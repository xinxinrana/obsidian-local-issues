import { App, FileSystemAdapter, Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, normalizePath } from 'obsidian';
import { randomBytes } from 'node:crypto';
import { agentSkill } from './agent-skill';
import { ResourceRoutes, slug } from './routes';
import { Store } from './store';
import { startApi } from './api';
import { IssuesView, VIEW_TYPE, type ViewHost } from './view';
import type { VaultAdapter } from './types';

interface Settings {
  root: string;
  author: string;
  apiEnabled: boolean;
  port: number;
  repoSlug?: string;
  projectSlugs?: Record<string, string>;
  shares: Record<string, { ref: string }>;
}
const DEFAULTS: Settings = { root: 'Local Issues', author: '我', apiEnabled: false, port: 27183, shares: {} };

export default class LocalIssuesPlugin extends Plugin implements ViewHost {
  declare settings: Settings;
  store!: Store;
  routes!: ResourceRoutes;
  private server?: Awaited<ReturnType<typeof startApi>>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private unloaded = false;
  private apiQueue: Promise<void> = Promise.resolve();
  apiError = '';
  get author(): string { return this.settings.author; }

  async onload(): Promise<void> {
    const saved = await this.loadData();
    this.settings = { ...DEFAULTS, ...(saved ?? {}), shares: saved?.shares ?? {} };
    delete (this.settings as unknown as Record<string, unknown>).token;
    delete (this.settings as unknown as Record<string, unknown>).apiToken;
    this.settings.shares = Object.fromEntries(Object.entries(this.settings.shares).map(([id, entry]) => [id, { ref: entry.ref }]));
    this.settings.repoSlug ??= slug(this.app.vault.getName());
    this.settings.projectSlugs ??= {};
    this.routes = new ResourceRoutes(this.settings.repoSlug, this.settings.projectSlugs, () => this.saveData(this.settings));
    await this.saveData(this.settings);
    this.configureStore();
    this.registerView(VIEW_TYPE, leaf => new IssuesView(leaf, this));
    this.addRibbonIcon('list-todo', 'Local Issues：项目', () => { void this.activate().catch(this.report); });
    this.addCommand({ id: 'open-projects', name: '打开项目', callback: () => { void this.activate().catch(this.report); } });
    this.addCommand({ id: 'copy-cli', name: '复制 Agent CLI 使用说明', callback: () => { void this.copyCli(); } });
    this.addCommand({ id: 'open-current-issue', name: '在项目中打开当前 Issue 笔记', checkCallback: checking => {
      const file = this.app.workspace.getActiveFile();
      if (!file || !file.path.startsWith(`${this.settings.root}/`)) return false;
      if (!checking) void this.openReference(file.path).catch(this.report);
      return true;
    } });
    this.addSettingTab(new LocalIssuesSettings(this.app, this));
    this.registerObsidianProtocolHandler('local-issues', params => {
      void this.openReference(params.issue || params.project || '').catch(this.report);
    });
    this.app.workspace.onLayoutReady(() => { if (!this.unloaded) void this.restartApi(); });
    for (const event of ['create', 'modify', 'delete', 'rename'] as const) {
      this.registerEvent(this.app.vault.on(event as 'modify', () => this.scheduleRefresh()));
    }
  }

  private report = (error: unknown): void => { console.error('[Local Issues]', error); new Notice(`Local Issues：${error instanceof Error ? error.message : String(error)}`); };

  configureStore(): void {
    const vault = this.app.vault;
    const safe = (path: string): string => {
      if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some(p => p === '..' || p === '.') || path.split('/')[0] === vault.configDir) throw new Error('无效的笔记路径');
      return normalizePath(path);
    };
    const folders = async (path: string): Promise<void> => {
      const parts = path.split('/').slice(0, -1);
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!await vault.adapter.exists(dir)) {
          try { await vault.createFolder(dir); } catch (error) { if (!await vault.adapter.exists(dir)) throw error; }
        }
      }
    };
    const adapter: VaultAdapter = {
      list: async () => vault.getMarkdownFiles().map(f => f.path),
      exists: path => vault.adapter.exists(safe(path)),
      read: async path => {
        const file = vault.getAbstractFileByPath(safe(path));
        if (!(file instanceof TFile)) throw new Error(`笔记不存在：${path}`);
        return vault.read(file);
      },
      write: async (path, content, expectedRaw) => {
        path = safe(path); await folders(path);
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await vault.process(file, current => {
          if (expectedRaw !== undefined && current !== expectedRaw) throw new Error('内容已被修改，请刷新后重试（冲突）');
          return content;
        });
        else {
          if (expectedRaw !== undefined) throw new Error('笔记已被删除，请刷新后重试（冲突）');
          await vault.create(path, content);
        }
      },
      writeBinary: async (path, data) => {
        path = safe(path); await folders(path);
        if (await vault.adapter.exists(path)) throw new Error('附件已存在');
        await vault.createBinary(path, Uint8Array.from(data).buffer);
      },
    };
    this.store = new Store(adapter, this.settings.root, this.settings.author);
  }

  async activate(projectId?: string, issueId?: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    if (leaf.view instanceof IssuesView) await leaf.view.navigate(projectId, issueId);
  }

  async openReference(ref: string): Promise<void> {
    if (!ref) return this.activate();
    const resolved = await this.store.resolve(ref);
    if (resolved.kind === 'issue') await this.activate(resolved.value.projectId, resolved.value.id);
    else if (resolved.kind === 'project') await this.activate(resolved.value.id);
    else await this.openNote(resolved.path);
  }

  async openNote(path: string): Promise<void> {
    await this.app.workspace.openLinkText(path, '', 'tab');
  }

  openSettings(): void {
    const modal = new Modal(this.app);
    modal.setTitle('Local Issues 设置');
    const tab = new LocalIssuesSettings(this.app, this);
    tab.containerEl = modal.contentEl;
    tab.display();
    modal.open();
  }

  async share(ref: string): Promise<string> {
    if (!this.server) throw new Error('请先在 Local Issues 设置中启用本地 Agent API');
    const resolved = await this.store.resolve(ref);
    if (resolved.kind === 'note') throw new Error('只能分享项目或 Issue');
    const stableRef = resolved.value.id;
    let entry = Object.entries(this.settings.shares).find(([, s]) => s.ref === stableRef);
    if (!entry) {
      const id = randomBytes(12).toString('hex');
      this.settings.shares[id] = { ref: stableRef };
      await this.saveData(this.settings);
      entry = [id, this.settings.shares[id]];
    }
    return `http://127.0.0.1:${this.server.port}/api/shares/${entry[0]}/resolve`;
  }

  async resourceLink(ref?: string, scope?: 'issues'): Promise<string> {
    if (!this.server) throw new Error('请先在 Local Issues 设置中启用本地 Agent API');
    return `http://localhost:${this.server.port}${decodeURI(await this.routes.path(this.store, ref, scope))}`;
  }

  private async cliPath(): Promise<string> {
    const adapter = this.app.vault.adapter;
    const relativePath = `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/local-issues`}/cli.mjs`;
    if (!await adapter.exists(relativePath)) throw new Error('请先从 GitHub Release 下载独立的 cli.mjs，放入 Local Issues 插件目录，再复制命令。');
    const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
    return `${base}/${relativePath}`;
  }

  async restartApi(): Promise<void> {
    this.apiQueue = this.apiQueue.catch(() => {}).then(async () => {
      if (this.server) { await this.server.close(); this.server = undefined; }
      this.apiError = '';
      if (!this.settings.apiEnabled || this.unloaded) return;
      try {
        this.server = await startApi({ store: this.store, port: this.settings.port,
          vaultName: this.app.vault.getName(), routes: this.routes, shares: this.settings.shares,
          saveShares: () => this.saveData(this.settings), open: ref => this.openReference(ref) });
      } catch (error) { this.apiError = error instanceof Error ? error.message : String(error); this.report(error); }
    });
    await this.apiQueue;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
        if (leaf.view instanceof IssuesView) void leaf.view.refresh().catch(this.report);
      }
    }, 180);
  }

  async copyCli(): Promise<void> {
    try {
      const path = await this.cliPath();
      await navigator.clipboard.writeText(agentSkill(path, this.server?.port ?? this.settings.port));
      new Notice('已复制工具说明与极简 Skill，粘贴给 Agent 即可');
    } catch (error) { this.report(error); }
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  onunload(): void {
    this.unloaded = true;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    void this.apiQueue.finally(() => this.server?.close()).catch(console.error);
  }
}

class LocalIssuesSettings extends PluginSettingTab {
  constructor(app: App, private plugin: LocalIssuesPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl: el, plugin: p } = this; el.empty();
    new Setting(el).setName('打开项目').setDesc('项目、Issues、评论和看板。').addButton(b => b.setButtonText('打开').setCta().onClick(() => p.activate()));
    new Setting(el).setName('显示名称').setDesc('新建 Issue、评论和状态记录的默认作者。').addText(t => t.setValue(p.settings.author).onChange(async value => {
      p.settings.author = value.trim() || '我'; p.store.author = p.settings.author; await p.saveSettings();
    }));
    new Setting(el).setName('笔记目录').setDesc(`当前目录：${p.settings.root}。修改后重启 Obsidian 生效；已有笔记不会迁移。`)
      .addText(t => t.setValue(p.settings.root).onChange(async value => {
        const v = value.trim().replace(/\/$/, '');
        if (!v || v.startsWith('/') || v.includes('\\') || v.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) return;
        p.settings.root = v; await p.saveSettings();
      }));
    new Setting(el).setName('本地 Agent API').setDesc('仅监听 127.0.0.1，供 CLI 和分享链接读写当前笔记库。')
      .addToggle(t => t.setValue(p.settings.apiEnabled).onChange(async value => { p.settings.apiEnabled = value; await p.saveSettings(); await p.restartApi(); this.display(); }));
    new Setting(el).setName('API 端口').setDesc(p.apiError || `http://127.0.0.1:${p.settings.port}`)
      .addText(t => t.setValue(String(p.settings.port)).onChange(async value => {
        if (!/^\d+$/.test(value) || +value < 1024 || +value > 65535) return;
        p.settings.port = +value; await p.saveSettings();
      })).addButton(b => b.setButtonText('应用端口').onClick(async () => { await p.restartApi(); this.display(); }));
    const cliDescription = document.createDocumentFragment();
    cliDescription.append('复制内容包含工具用途、链接识别规则与 CLI 用法，可直接交给 Agent 或保存为 SKILL.md。社区商店安装后需另行下载 cli.mjs。');
    const cliDownload = document.createElement('a');
    cliDownload.href = 'https://github.com/xinxinrana/obsidian-local-issues/releases/latest';
    cliDownload.textContent = '下载 CLI'; cliDownload.rel = 'noopener noreferrer';
    cliDescription.append(' ', cliDownload);
    new Setting(el).setName('Agent CLI').setDesc(cliDescription)
      .addButton(b => b.setButtonText('复制 CLI 命令').onClick(() => p.copyCli()));
    el.createEl('p', { text: '内容保存在 Markdown 文件中，附件位于 resource/local-issues/。停用插件后仍可直接阅读与编辑。链接用于定位仓库、项目或议题，无需登录或密钥，仅在这台电脑的 Obsidian 运行时可用。', cls: 'setting-item-description' });
  }
}
