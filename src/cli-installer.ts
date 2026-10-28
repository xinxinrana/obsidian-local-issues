import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export interface CliProgress { step: string; title: string; state: 'running' | 'done' | 'error'; detail?: string; help?: string; link?: string }
export interface CliInstallerOptions {
  home: string; pluginDir: string; vault: string; version: string;
  platform?: string; shell?: string; env?: NodeJS.ProcessEnv; nodeHint?: string;
  cancelled?: () => boolean;
  download: (url: string) => Promise<Uint8Array>;
  run?: (file: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<string>;
}
interface Receipt { owner: string; profiles: { path: string; block: string; created: boolean }[]; windowsPathAdded?: boolean }
export class CliInstallError extends Error {
  constructor(message: string, readonly help: string, readonly link?: string) { super(message); }
}
const marker = 'managed by Local Issues';
const start = '# >>> local-issues PATH >>>', end = '# <<< local-issues PATH <<<';
const sh = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
async function optional(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}

export class CliInstaller {
  readonly command: string; readonly cli: string;
  private readonly platform: string; private readonly env: NodeJS.ProcessEnv;
  private readonly owner: string; private readonly receiptPath: string;
  constructor(private readonly options: CliInstallerOptions) {
    this.platform = options.platform || process.platform; this.env = options.env || process.env;
    this.command = join(options.home, '.local', 'bin', this.platform === 'win32' ? 'local-issues.cmd' : 'local-issues');
    this.cli = join(options.pluginDir, 'cli.mjs'); this.receiptPath = join(options.pluginDir, 'cli-install.json');
    this.owner = hash(`${options.vault}\0${this.cli}`);
    if ([options.home, options.pluginDir, options.vault].some(value => /[\0\r\n]/.test(value))) throw new Error('安装路径不能包含换行或空字符。');
  }
  private run(file: string, args: string[], extra: NodeJS.ProcessEnv = {}): Promise<string> {
    const env = { ...this.env, NODE_OPTIONS: '', ...extra };
    if (this.options.run) return this.options.run(file, args, env);
    return new Promise((resolve, reject) => execFile(file, args, { env, timeout: 15000, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  }
  private owns(content: string): boolean {
    return content.includes(marker) && (content.includes(`local-issues-owner: ${this.owner}`) ||
      (!content.includes('local-issues-owner:') && (content.includes(sh(this.cli)) || content.includes(`"${this.cli}"`)) && (content.includes(sh(this.options.vault)) || content.includes(`"${this.options.vault}"`))));
  }
  async installed(): Promise<boolean> { try { return await this.commandContent() !== undefined; } catch (error) { if (error instanceof CliInstallError) return false; throw error; } }
  private active(): void { if (this.options.cancelled?.()) throw new CliInstallError('插件已停用，安装已中止。', '重新启用插件后可重试安装或卸载。'); }
  private async commandContent(): Promise<string | undefined> {
    try { if ((await lstat(this.command)).isSymbolicLink()) throw new CliInstallError('命令位置已被一个符号链接占用。', `请先检查或改名 ${this.command}，再重试安装。`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const current = await optional(this.command);
    if (current !== undefined && !this.owns(current)) throw new CliInstallError('命令位置已被其他工具或笔记库占用。', `请先检查或改名 ${this.command}，再重试；安装器不会覆盖该文件。`);
    return current;
  }
  private async replace(path: string, text: string, previous?: string, mode = 0o600): Promise<void> {
    this.active();
    try {
      if ((await lstat(path)).isSymbolicLink()) path = await realpath(path);
      mode = (await lstat(path)).mode & 0o777;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.local-issues-${randomBytes(6).toString('hex')}`;
    try {
      await writeFile(temp, text, { flag: 'wx', mode });
      if (await optional(path) !== previous) throw new CliInstallError('安装期间文件已被其他程序修改。', `请检查 ${path} 后重试。`);
      this.active();
      await rename(temp, path);
    } finally { await rm(temp, { force: true }); }
  }
  private async receipt(): Promise<Receipt> {
    const value = await optional(this.receiptPath);
    if (!value) return { owner: this.owner, profiles: [] };
    let data: Receipt;
    try { data = JSON.parse(value); } catch { throw new CliInstallError('CLI 安装记录损坏。', `请检查 ${this.receiptPath}，恢复有效记录或移走该文件后重试。`); }
    const allowed = ['.zshrc', '.zprofile', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.config/fish/conf.d/local-issues.fish'].map(p => resolve(this.options.home, p));
    if (data.owner !== this.owner || !Array.isArray(data.profiles) || data.profiles.some(p => !allowed.includes(resolve(p.path)) || typeof p.block !== 'string' || !p.block.includes(start) || !p.block.includes(end))) throw new CliInstallError('CLI 安装记录与当前笔记库不匹配。', `请检查 ${this.receiptPath} 后重试。`);
    return data;
  }
  private async saveReceipt(receipt: Receipt): Promise<void> { await this.replace(this.receiptPath, JSON.stringify(receipt, null, 2), await optional(this.receiptPath)); }
  private async node(): Promise<{ path: string; version: string }> {
    const exe = this.platform === 'win32' ? 'node.exe' : 'node';
    const candidates = [this.options.nodeHint, ...String(this.env.PATH || '').split(this.platform === 'win32' ? ';' : ':').filter(Boolean).map(p => join(p, exe)),
      this.env.NVM_BIN && join(this.env.NVM_BIN, exe), join(this.options.home, '.volta/bin', exe),
      ...(this.platform === 'win32' ? [join(this.env.ProgramFiles || 'C:\\Program Files', 'nodejs/node.exe'), this.env.LOCALAPPDATA && join(this.env.LOCALAPPDATA, 'Programs/nodejs/node.exe')] : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'])].filter((p): p is string => !!p);
    try { const versions = await readdir(join(this.options.home, '.nvm/versions/node')); for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) candidates.push(join(this.options.home, '.nvm/versions/node', version, 'bin/node')); } catch { /* Optional Node installation location. */ }
    const old: string[] = [];
    for (const candidate of [...new Set(candidates)]) {
      try { await realpath(candidate); const path = resolve(candidate), version = (await this.run(path, ['--version'])).trim(); if (/^v\d+\.\d+\.\d+/.test(version)) { if (Number(version.slice(1).split('.')[0]) >= 22) return { path, version }; old.push(version); } } catch { /* Try the remaining locations before asking for a path. */ }
    }
    throw new CliInstallError(old.length ? `找到的 Node.js 版本过低（${[...new Set(old)].join('、')}）。` : '未找到可运行的 Node.js 22 或更新版本。', '请安装 Node.js 22+，然后重试；已经安装时，可在下方填写 node 可执行文件的完整路径。', 'https://nodejs.org/en/download');
  }
  private wrapper(node: string): string {
    if (this.platform === 'win32') {
      const quoted = (value: string) => `"${value.replace(/%/g, '%%')}"`;
      return `@echo off\r\nrem ${marker}\r\nrem local-issues-owner: ${this.owner}\r\nsetlocal DisableDelayedExpansion\r\n${quoted(node)} ${quoted(this.cli)} --vault ${quoted(this.options.vault)} %*\r\nexit /b %errorlevel%\r\n`;
    }
    return `#!/bin/sh\n# ${marker}\n# local-issues-owner: ${this.owner}\nexec ${sh(node)} ${sh(this.cli)} --vault ${sh(this.options.vault)} "$@"\n`;
  }
  private async profiles(): Promise<string[]> {
    const shell = basename(this.options.shell || this.env.SHELL || (this.platform === 'darwin' ? 'zsh' : 'sh'));
    if (shell === 'zsh') return ['.zprofile', '.zshrc'];
    if (shell === 'fish') return ['.config/fish/conf.d/local-issues.fish'];
    if (shell === 'bash') {
      for (const name of ['.bash_profile', '.bash_login', '.profile']) if (await optional(join(this.options.home, name)) !== undefined) return ['.bashrc', name];
      return ['.bashrc', '.profile'];
    }
    return ['.profile'];
  }
  private async windowsPath(remove: boolean | 'check' = false): Promise<boolean> {
    this.active();
    const script = `$ErrorActionPreference='Stop'; $dir=$env:LOCAL_ISSUES_INSTALL_BIN; $old=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($old -split ';' | Where-Object { $_ -ne '' }); $has=@($parts | Where-Object { $_.TrimEnd('\\') -ieq $dir.TrimEnd('\\') }).Count -gt 0; if ($env:LOCAL_ISSUES_INSTALL_REMOVE -eq '1') { if ($has) { $parts=@($parts | Where-Object { $_.TrimEnd('\\') -ine $dir.TrimEnd('\\') }); [Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User') }; @{changed=$has} | ConvertTo-Json -Compress } else { if (-not $has) { [Environment]::SetEnvironmentVariable('Path',((@($parts)+@($dir)) -join ';'),'User') }; @{changed=(-not $has)} | ConvertTo-Json -Compress }`;
    const command = remove === 'check' ? script.replace("if ($env:LOCAL_ISSUES_INSTALL_REMOVE -eq '1')", "if ($env:LOCAL_ISSUES_INSTALL_REMOVE -eq '-1') { @{changed=(-not $has)} | ConvertTo-Json -Compress } elseif ($env:LOCAL_ISSUES_INSTALL_REMOVE -eq '1')") : script;
    const result = JSON.parse(await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { LOCAL_ISSUES_INSTALL_BIN: dirname(this.command), LOCAL_ISSUES_INSTALL_REMOVE: remove === 'check' ? '-1' : remove ? '1' : '0' }));
    return result.changed === true;
  }
  private async configurePath(receipt: Receipt): Promise<void> {
    if (this.platform === 'win32') {
      // Record cleanup intent before changing PATH, including interrupted installs.
      if (!receipt.windowsPathAdded) { if (!await this.windowsPath('check')) return; receipt.windowsPathAdded = true; await this.saveReceipt(receipt); }
      await this.windowsPath();
      return;
    }
    const dir = dirname(this.command);
    if (String(this.env.PATH || '').split(':').includes(dir)) return;
    for (const name of await this.profiles()) {
      const path = join(this.options.home, name), current = await optional(path);
      const existing = receipt.profiles.find(p => p.path === path);
      if (existing && current?.includes(existing.block)) continue;
      if (current?.includes(start)) throw new CliInstallError('终端配置中已有无法识别的 Local Issues 配置。', `请检查 ${path} 中的 ${start} 配置段后重试。`);
      const content = name.endsWith('.fish') ? `if not contains -- ${sh(dir)} $PATH\n  set -gx PATH ${sh(dir)} $PATH\nend` : `case ":$PATH:" in *${sh(`:${dir}:`)}*) ;; *) export PATH=${sh(dir)}:"$PATH" ;; esac`;
      const block = `\n${start}\n${content}\n${end}\n`;
      if (!existing) receipt.profiles.push({ path, block, created: current === undefined }); else existing.block = block;
      await this.saveReceipt(receipt);
      await this.replace(path, (current || '') + block, current);
    }
  }
  async install(notify: (event: CliProgress) => void = () => {}): Promise<{ command: string; node: string }> {
    const step = async <T>(key: string, title: string, work: () => Promise<T>): Promise<T> => {
      notify({ step: key, title, state: 'running' });
      try { this.active(); const result = await work(); this.active(); notify({ step: key, title, state: 'done' }); return result; }
      catch (error) {
        const e = error as NodeJS.ErrnoException;
        const help = error instanceof CliInstallError ? error.help : /EACCES|EPERM|EROFS/.test(e.code || '') ? `请确认 ${e.path || this.options.pluginDir} 对当前用户可写，再重试。无需使用 sudo；也可选择一个自己拥有的笔记库。` : '请检查网络或文件权限后重试。';
        notify({ step: key, title, state: 'error', detail: error instanceof Error ? error.message : String(error), help, link: error instanceof CliInstallError ? error.link : undefined }); throw error;
      }
    };
    const node = await step('node', '检查 Node.js', () => this.node());
    await step('download', '准备 CLI', async () => {
      if (await optional(this.cli) === undefined) {
        const base = `https://github.com/xinxinrana/obsidian-local-issues/releases/download/${encodeURIComponent(this.options.version)}`;
        let bytes: Uint8Array, checksums: string;
        try { checksums = Buffer.from(await this.options.download(`${base}/local-issues-SHA256SUMS.txt`)).toString('utf8'); bytes = await this.options.download(`${base}/cli.mjs`); }
        catch { throw new CliInstallError('无法下载当前插件版本的 CLI。', '请检查 GitHub 网络连接后重试；也可从该版本下载 cli.mjs 到插件目录，再点安装。', `https://github.com/xinxinrana/obsidian-local-issues/releases/tag/${encodeURIComponent(this.options.version)}`); }
        const expected = checksums.match(/^([a-f\d]{64})[ \t]+\*?cli\.mjs\r?$/im)?.[1].toLowerCase();
        if (!bytes.byteLength || bytes.byteLength > 2 * 1024 * 1024 || !expected || hash(bytes) !== expected) throw new CliInstallError('CLI 下载校验失败，文件未安装。', '请重试下载；若仍失败，请检查当前版本的 cli.mjs 与 SHA256SUMS 附件是否完整。');
        this.active();
        const temp = `${this.cli}.download-${randomBytes(6).toString('hex')}.mjs`;
        try { await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 }); await this.run(node.path, ['--check', temp]); if (await optional(this.cli) === undefined) await rename(temp, this.cli); }
        finally { await rm(temp, { force: true }); }
      }
      await this.run(node.path, ['--check', this.cli]);
      if (!/local.issues/i.test(await this.run(node.path, [this.cli, '--vault', this.options.vault, '--help']))) throw new CliInstallError('插件目录中的 cli.mjs 不是有效的 Local Issues CLI。', '请从当前版本下载 cli.mjs 并替换该文件后重试。', `https://github.com/xinxinrana/obsidian-local-issues/releases/tag/${encodeURIComponent(this.options.version)}`);
    });
    const receipt = await step('command', '安装 local-issues 命令', async () => {
      const receipt = await this.receipt();
      const previous = await this.commandContent(); await this.replace(this.command, this.wrapper(node.path), previous, 0o755);
      if (this.platform !== 'win32') await chmod(this.command, 0o755);
      await this.saveReceipt(receipt); return receipt;
    });
    await step('path', '配置终端命令路径', () => this.configurePath(receipt));
    await step('verify', '验证 CLI', async () => {
      const output = this.platform === 'win32' ? await this.run(node.path, [this.cli, '--vault', this.options.vault, '--help']) : await this.run(this.command, ['--help']);
      if (!/local.issues/i.test(output)) throw new CliInstallError('CLI 没有返回有效的帮助信息。', '请检查插件目录中的 cli.mjs，恢复当前版本文件后重试。');
    });
    return { command: this.command, node: node.version };
  }
  async remove(): Promise<void> {
    this.active();
    const current = await this.commandContent(), receipt = await this.receipt();
    for (const profile of receipt.profiles) {
      const content = await optional(profile.path); if (content === undefined || !content.includes(profile.block)) continue;
      const next = content.replace(profile.block, '');
      this.active(); if (!next && profile.created) await rm(profile.path); else await this.replace(profile.path, next, content);
    }
    if (receipt.windowsPathAdded) await this.windowsPath(true);
    if (current !== undefined) { if (await optional(this.command) !== current) throw new Error('命令已被其他程序修改，请检查后重试。'); await rm(this.command); }
    await rm(this.receiptPath, { force: true });
  }
}
