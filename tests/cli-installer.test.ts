import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, symlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CliInstaller, type CliInstallerOptions, type CliProgress } from '../src/cli-installer';

async function fixture(patch: Partial<CliInstallerOptions> = {}) {
  const home = await mkdtemp(join(tmpdir(), "local-issues-installer-' 空格-"));
  const pluginDir = join(home, "Vault ' 测试/.obsidian/plugins/local-issues"); await mkdir(pluginDir, { recursive: true });
  const body = await readFile('cli.mjs'); const requests: string[] = [], steps: CliProgress[] = [];
  const digest = createHash('sha256').update(body).digest('hex');
  const options: CliInstallerOptions = { home, pluginDir, vault: join(home, "Vault ' 测试"), version: '0.2.1',
    platform: 'darwin', shell: '/bin/zsh', env: { ...process.env, PATH: '', NODE_OPTIONS: '' }, nodeHint: process.execPath,
    download: async url => { requests.push(url); return url.endsWith('SHA256SUMS.txt') ? Buffer.from(`${digest}  cli.mjs\n`) : body; }, ...patch };
  const installer = new CliInstaller(options);
  return { home, pluginDir, body, options, installer, requests, steps, notify: (step: CliProgress) => steps.push({ ...step }), async close() { await rm(home, { recursive: true, force: true }); } };
}

test('one click downloads the exact version, verifies checksum, installs an executable command, configures PATH and uninstalls cleanly', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, '.zshrc'), 'export EDITOR=vim');
    const result = await f.installer.install(f.notify);
    assert.equal(result.command, f.installer.command); assert.equal(await f.installer.installed(), true);
    assert.ok(f.requests.every(url => url.includes('/download/0.2.1/'))); assert.equal(f.requests.length, 2);
    assert.deepEqual(f.steps.filter(s => s.state === 'done').map(s => s.step), ['node', 'download', 'command', 'path', 'verify']);
    assert.deepEqual(await readFile(f.installer.cli), f.body); assert.equal((await stat(f.installer.command)).mode & 0o777, 0o755);
    const before = await readFile(join(f.home, '.zshrc'), 'utf8'); assert.match(before, /export EDITOR=vim/); assert.match(before, /local-issues PATH/);
    const output = await promisify(execFile)(f.installer.command, ['--help'], { env: { PATH: '' } }); assert.match(output.stdout, /local-issues/);
    await f.installer.install(); assert.equal(f.requests.length, 2, 'Bundled or previously downloaded CLI is reused');
    assert.equal((await readFile(join(f.home, '.zshrc'), 'utf8')).match(/>>> local-issues/g)?.length, 1);
    await writeFile(join(f.home, '.zshrc'), before + '\n# user changes after installation\n');
    await f.installer.remove(); assert.equal(await f.installer.installed(), false);
    assert.equal(await readFile(join(f.home, '.zshrc'), 'utf8'), 'export EDITOR=vim\n# user changes after installation\n');
    await assert.rejects(readFile(join(f.home, '.zprofile')), /ENOENT/);
    assert.deepEqual(await readFile(f.installer.cli), f.body, 'The plugin CLI asset is retained');
    await f.installer.remove();
  } finally { await f.close(); }
});

test('Node discovery handles missing GUI PATH, old versions and custom paths without downloading or writing files on dependency failure', async () => {
  const f = await fixture({ nodeHint: process.execPath, run: async (_file, args) => args[0] === '--version' ? 'v20.11.0' : 'local-issues' });
  try {
    await assert.rejects(f.installer.install(f.notify), /版本过低/);
    assert.equal(f.requests.length, 0); assert.equal(await f.installer.installed(), false);
    assert.equal(f.steps.at(-1)?.step, 'node'); assert.match(f.steps.at(-1)?.help || '', /完整路径/); assert.equal(f.steps.at(-1)?.link, 'https://nodejs.org/en/download');
    const installer = new CliInstaller({ ...f.options, run: async (_file, args) => args[0] === '--version' ? 'v24.1.0' : 'local-issues' });
    await installer.install(); assert.equal(await installer.installed(), true);
  } finally { await f.close(); }
});

test('network and checksum failures disclose the current step and leave the command and terminal configuration untouched', async () => {
  for (const download of [async () => { throw new Error('offline'); }, async (url: string) => url.endsWith('SHA256SUMS.txt') ? Buffer.from(`${'0'.repeat(64)}  cli.mjs\n`) : Buffer.from('corrupt')]) {
    const f = await fixture({ download });
    try {
      await assert.rejects(f.installer.install(f.notify), /下载|校验/);
      assert.equal(f.steps.at(-1)?.step, 'download'); assert.equal(f.steps.at(-1)?.state, 'error');
      assert.equal(await f.installer.installed(), false); assert.deepEqual(await readdir(f.pluginDir), []);
      await assert.rejects(readFile(join(f.home, '.zshrc')), /ENOENT/);
    } finally { await f.close(); }
  }
});

test('existing commands, other vaults and symlinks are never overwritten or deleted', async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.home, '.local/bin'), { recursive: true }); await writeFile(f.installer.command, '# another tool');
    await assert.rejects(f.installer.install(f.notify), /占用/); assert.equal(await readFile(f.installer.command, 'utf8'), '# another tool');
    await assert.rejects(f.installer.remove(), /占用/);
    await rm(f.installer.command); await symlink(f.installer.cli, f.installer.command);
    await assert.rejects(f.installer.install(), /符号链接/); assert.equal((await lstat(f.installer.command)).isSymbolicLink(), true);
    await rm(f.installer.command); await f.installer.install();
    const other = new CliInstaller({ ...f.options, vault: join(f.home, 'Other Vault') }); await assert.rejects(other.install(), /匹配|占用/); await assert.rejects(other.remove(), /占用|匹配/);
    assert.equal(await f.installer.installed(), true);
  } finally { await f.close(); }
});

test('permission failures show a targeted recovery action and a partial install can be removed', async () => {
  const f = await fixture({ run: async (_file, args) => { if (args[0] === '--version') return 'v24.0.0'; return 'local-issues'; } });
  try {
    await writeFile(join(f.home, '.zprofile'), 'profile');
    const e = Object.assign(new Error('permission denied'), { code: 'EACCES', path: join(f.home, '.zshrc') });
    // Fail a PATH operation independently of root/test-user permission differences.
    (f.installer as any).profiles = async () => { throw e; };
    await assert.rejects(f.installer.install(f.notify), /permission denied/);
    assert.equal(f.steps.at(-1)?.step, 'path'); assert.match(f.steps.at(-1)?.help || '', /当前用户可写/);
    assert.equal(await f.installer.installed(), true); await f.installer.remove(); assert.equal(await f.installer.installed(), false);
    assert.equal(await readFile(join(f.home, '.zprofile'), 'utf8'), 'profile');
  } finally { await f.close(); }
});

test('profile symlinks, file modes, bash login files and existing PATH configuration are preserved', async () => {
  const f = await fixture({ shell: '/bin/bash' });
  try {
    const dotfiles = join(f.home, 'bashrc-source'); await writeFile(dotfiles, '# my dotfiles\n', { mode: 0o640 }); await symlink(dotfiles, join(f.home, '.bashrc'));
    await writeFile(join(f.home, '.profile'), '# my login file\n');
    await f.installer.install(); assert.equal((await lstat(join(f.home, '.bashrc'))).isSymbolicLink(), true);
    assert.equal((await stat(dotfiles)).mode & 0o777, 0o640);
    await assert.rejects(readFile(join(f.home, '.bash_profile')), /ENOENT/, 'No new login file shadows an existing .profile');
    await f.installer.remove(); assert.equal(await readFile(dotfiles, 'utf8'), '# my dotfiles\n');
    const ready = new CliInstaller({ ...f.options, env: { ...f.options.env, PATH: join(f.home, '.local/bin') } }); await ready.install();
    assert.equal(await readFile(join(f.home, '.profile'), 'utf8'), '# my login file\n');
  } finally { await f.close(); }
});

test('Windows uses a literal cmd wrapper and user-only PATH updates; uninstall removes only the added entry', async () => {
  const envCalls: NodeJS.ProcessEnv[] = [];
  const f = await fixture({ platform: 'win32', run: async (file, args, env) => {
    if (file === 'powershell.exe') { assert.match(args.join(' '), /'User'/); assert.doesNotMatch(args.join(' '), /'Machine'/); envCalls.push(env!); return '{"changed":true}'; }
    return args[0] === '--version' ? 'v24.1.0' : 'local-issues';
  } });
  try {
    await f.installer.install(); const wrapper = await readFile(f.installer.command, 'utf8');
    assert.match(wrapper, /DisableDelayedExpansion/); assert.match(f.installer.command, /\.cmd$/); assert.match(wrapper, /--vault ".*" %\*/);
    assert.equal(envCalls[0].LOCAL_ISSUES_INSTALL_REMOVE, '-1'); assert.equal(envCalls[1].LOCAL_ISSUES_INSTALL_REMOVE, '0');
    await f.installer.remove(); assert.equal(envCalls.at(-1)?.LOCAL_ISSUES_INSTALL_REMOVE, '1');
    assert.equal(await f.installer.installed(), false);
  } finally { await f.close(); }
});

test('stopping the plugin while downloading prevents later installation writes', async () => {
  let cancelled = false;
  const f = await fixture({ cancelled: () => cancelled });
  try {
    const install = new CliInstaller({ ...f.options, download: async url => { const data = await f.options.download(url); if (url.endsWith('/cli.mjs')) cancelled = true; return data; } });
    await assert.rejects(install.install(), /中止/);
    assert.deepEqual(await readdir(f.pluginDir), []); assert.equal(await install.installed(), false);
  } finally { await f.close(); }
});
