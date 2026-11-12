import { App, FileSystemAdapter, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, normalizePath, requestUrl, setIcon, type WorkspaceLeaf } from 'obsidian';
import { MobileModal } from './mobile';
import { randomUUID } from './platform-crypto';
import { DraftJournal } from './draft-journal';
import { Drafts } from './drafts';
import type { CliInstaller, CliProgress } from './cli-installer';
import { agentGuide, agentSkill } from './agent-skill';
import { ResourceRoutes, slug } from './routes';
import { Store } from './store';
import type { startApi } from './api';
import { IssuesView, VIEW_TYPE, type ViewHost } from './view';
import type { HistoryDirection } from './trackpad-navigation';
import { suppressTooltips } from './tooltips';
import type { VaultAdapter } from './types';
import { layoutPreferences, type LayoutPreferences } from './layout-preferences';

interface Settings {
  root: string;
  author: string;
  apiEnabled: boolean;
  port: number;
  repoSlug?: string;
  projectSlugs?: Record<string, string>;
  shares: Record<string, { ref: string }>;
  cliNodePath?: string;
  draftStorageId?: string;
  layout?: LayoutPreferences;
  trackpadNavigation: boolean;
  commentSubmit: 'mod-enter' | 'enter';
}
const DEFAULTS: Settings = { root: 'Local Issues', author: '我', apiEnabled: false, port: 27183, shares: {}, trackpadNavigation: true, commentSubmit: 'mod-enter' };

export default class LocalIssuesPlugin extends Plugin implements ViewHost {
  declare settings: Settings;
  store!: Store;
  routes!: ResourceRoutes;
  draftCache!: Drafts;
  draftJournal!: DraftJournal;
  private server?: Awaited<ReturnType<typeof startApi>>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private unloaded = false;
  private apiQueue: Promise<void> = Promise.resolve();
  apiError = '';
  cliBusy = false;
  cliInstalled = false;
  cliProgress: CliProgress[] = [];
  cliMessage = '';
  private cliTask?: Promise<string>;
  private cliStatusVersion = 0;
  private cliListeners = new Set<() => void>();
  private desktop?: Promise<typeof import('./desktop')>;
  private layoutSave: Promise<void> = Promise.resolve();
  get author(): string { return this.settings.author; }
  get trackpadNavigation(): boolean { return this.settings.trackpadNavigation; }
  get commentSubmit(): 'mod-enter' | 'enter' { return this.settings.commentSubmit; }
  get layout(): LayoutPreferences { return this.settings.layout || {}; }
  async saveLayout(patch: Partial<LayoutPreferences>): Promise<void> {
    this.layoutSave = this.layoutSave.catch(() => {}).then(async () => {
      const previous = this.settings.layout;
      this.settings.layout = { ...this.layout, ...patch };
      try { await this.saveSettings(); } catch (error) { this.settings.layout = previous; throw error; }
    });
    await this.layoutSave;
  }
  get desktopAvailable(): boolean { return !Platform.isMobile; }
  private desktopServices() {
    if (!this.desktopAvailable) throw new Error('此功能仅在桌面端提供。');
    return this.desktop ??= import('./desktop');
  }

  async onload(): Promise<void> {
    const saved = await this.loadData();
    this.settings = { ...DEFAULTS, ...(saved ?? {}), shares: saved?.shares ?? {} };
    this.settings.layout = layoutPreferences((saved as Partial<Settings> | null)?.layout);
    delete (this.settings as unknown as Record<string, unknown>).token;
    delete (this.settings as unknown as Record<string, unknown>).apiToken;
    this.settings.shares = Object.fromEntries(Object.entries(this.settings.shares).map(([id, entry]) => [id, { ref: entry.ref }]));
    this.settings.repoSlug ??= slug(this.app.vault.getName());
    this.settings.projectSlugs ??= {};
    this.settings.draftStorageId ||= randomUUID();
    this.routes = new ResourceRoutes(this.settings.repoSlug, this.settings.projectSlugs, () => this.saveData(this.settings));
    await this.saveData(this.settings);
    this.configureStore();
    let journal: Storage | undefined;
    try { journal = window.localStorage; } catch { /* Use the independent disk replica. */ }
    this.draftJournal = new DraftJournal({ prefix: `local-issues:${this.settings.draftStorageId}`, directory: `${this.manifest.dir || `${this.app.vault.configDir}/plugins/local-issues`}/drafts`, disk: this.app.vault.adapter,
      journal, legacy: key => this.app.loadLocalStorage?.(key), warn: message => { new Notice(message, 0); } });
    await this.draftJournal.initialize();
    this.draftCache = new Drafts(this.draftJournal, message => { new Notice(message, 0); });
    this.registerView(VIEW_TYPE, leaf => new IssuesView(leaf, this));
    this.addRibbonIcon('list-todo', 'Local Issues：项目', () => { void this.activate().catch(this.report); });
    this.addCommand({ id: 'open-projects', name: '打开项目', callback: () => { void this.activate().catch(this.report); } });
    this.addCommand({ id: 'open-local-issues', name: '打开 Local Issues', callback: () => { void this.activate().catch(this.report); } });
    for (const direction of ['back', 'forward'] as const) this.addCommand({
      id: `history-${direction}`, name: direction === 'back' ? '返回上一页' : '前进下一页',
      checkCallback: checking => {
        const leaf = this.app.workspace.activeLeaf;
        if (!(leaf?.view instanceof IssuesView)) return false;
        if (!checking) this.navigateHistory(leaf, direction);
        return true;
      },
    });
    if (this.desktopAvailable) {
      this.addCommand({ id: 'copy-skill', name: '复制 Agent Skill', callback: () => { void this.copySkill(); } });
      this.addCommand({ id: 'copy-guide', name: '复制给 Agent 的引导语（含 skill 安装说明）', callback: () => { void this.copyGuide(); } });
      this.addCommand({ id: 'install-cli', name: '安装或修复 CLI', callback: () => { void this.installCli().catch(this.report); } });
      this.addCommand({ id: 'remove-cli', name: '卸载 CLI 命令', callback: () => { void this.removeCli().catch(this.report); } });
    }
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
    this.app.workspace.onLayoutReady(() => {
      if (this.unloaded) return;
      if (this.desktopAvailable) void this.restartApi();
    });
    for (const event of ['create', 'modify', 'delete', 'rename'] as const) {
      this.registerEvent(this.app.vault.on(event as 'modify', () => this.scheduleRefresh()));
    }
  }

  report = (error: unknown): void => { console.error('[Local Issues]', error); new Notice(`Local Issues：${error instanceof Error ? error.message : String(error)}`); };

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
      removeFolder: async path => {
        path = safe(path);
        const folder = vault.getAbstractFileByPath(path);
        if (folder) await vault.trash(folder, this.desktopAvailable && vault.adapter instanceof FileSystemAdapter);
      },
      rename: async (path, destination) => {
        path = safe(path); destination = safe(destination);
        if (await vault.adapter.exists(destination)) throw new Error('目标位置已存在，请刷新后重试');
        await folders(destination);
        const file = vault.getAbstractFileByPath(path);
        if (!file) throw new Error('原笔记或目录已不存在，请刷新后重试');
        await this.app.fileManager.renameFile(file, destination);
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
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true, state: projectId || issueId ? { projectId, issueId } : {} });
    await this.app.workspace.revealLeaf(leaf);
    if (existing && (projectId || issueId) && leaf.view instanceof IssuesView) await leaf.view.navigate(projectId, issueId);
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

  navigateHistory(leaf: WorkspaceLeaf, direction: HistoryDirection): void {
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    const commands = (this.app as App & { commands?: { executeCommandById(id: string): boolean } }).commands;
    const ran = commands?.executeCommandById(direction === 'back' ? 'app:go-back' : 'app:go-forward');
    if (!ran) new Notice(direction === 'back' ? '当前没有可返回的页面' : '当前没有可前进的页面');
  }

  openSettings(): void {
    const modal = new MobileModal(this.app);
    modal.modalEl.addClass('li-settings-modal');
    modal.modalEl.addClass('li-settings');
    suppressTooltips(modal.modalEl);
    modal.setTitle('Local Issues 设置');
    const tab = new LocalIssuesSettings(this.app, this);
    tab.containerEl = modal.contentEl;
    tab.display();
    modal.onClose = () => tab.hide();
    modal.open();
  }

  async share(ref: string): Promise<string> {
    if (!this.desktopAvailable) throw new Error('手机端仅提供本地人工读写。');
    if (!this.server) throw new Error('请先在 Local Issues 设置的 Agent 页开启本地服务');
    const resolved = await this.store.resolve(ref);
    if (resolved.kind === 'note') throw new Error('只能分享项目或 Issue');
    const stableRef = resolved.value.id;
    let entry = Object.entries(this.settings.shares).find(([, s]) => s.ref === stableRef);
    if (!entry) {
      const id = randomUUID().replace(/-/g, '');
      this.settings.shares[id] = { ref: stableRef };
      await this.saveData(this.settings);
      entry = [id, this.settings.shares[id]];
    }
    return `http://127.0.0.1:${this.server.port}/api/shares/${entry[0]}/resolve`;
  }

  async resourceLink(ref?: string, scope?: 'issues'): Promise<string> {
    if (!this.server) throw new Error('请先在 Local Issues 设置的 Agent 页开启本地服务');
    return `http://localhost:${this.server.port}${decodeURI(await this.routes.path(this.store, ref, scope))}`;
  }

  private async cliPath(): Promise<string> {
    if (!this.desktopAvailable) throw new Error('CLI 仅在桌面端提供。');
    const adapter = this.app.vault.adapter;
    const relativePath = `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/local-issues`}/cli.mjs`;
    if (!await adapter.exists(relativePath)) throw new Error('CLI 尚未安装，请在 Local Issues 设置点击「安装 CLI」。');
    const base = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : '';
    return `${base}/${relativePath}`;
  }

  private async vaultPath(): Promise<string> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) throw new Error('全局命令只支持本地笔记库。');
    return adapter.getBasePath();
  }

  private origin(): string { return `http://localhost:${this.server?.port ?? this.settings.port}`; }

  private async cliInstaller(): Promise<CliInstaller> {
    const { CliInstaller, homedir, join } = await this.desktopServices();
    const vault = await this.vaultPath();
    return new CliInstaller({ home: homedir(), vault, version: this.manifest.version, nodeHint: this.settings.cliNodePath,
      cancelled: () => this.unloaded,
      pluginDir: join(vault, this.manifest.dir ?? `${this.app.vault.configDir}/plugins/local-issues`),
      download: async url => {
        let pendingTimer: ReturnType<typeof setTimeout> | undefined;
        const response = await Promise.race([requestUrl({ url, throw: false }), new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error('下载超时，请检查网络后重试。')), 30000);
          // The timer is disposed when the underlying request settles.
          pendingTimer = timer;
        })]).finally(() => { if (pendingTimer) clearTimeout(pendingTimer); });
        if (response.status !== 200) throw new Error(`下载失败（HTTP ${response.status}）`);
        return new Uint8Array(response.arrayBuffer);
      },
    });
  }

  onCliChange(callback: () => void): () => void { this.cliListeners.add(callback); return () => this.cliListeners.delete(callback); }
  private cliChanged(): void { if (!this.unloaded) for (const listener of this.cliListeners) listener(); }
  async refreshCliStatus(): Promise<void> {
    if (this.cliBusy) return;
    const version = this.cliStatusVersion;
    let installed = false;
    try { installed = await (await this.cliInstaller()).installed(); } catch { /* The install action reports actionable errors. */ }
    if (version !== this.cliStatusVersion || this.cliBusy) return;
    this.cliInstalled = installed;
    this.cliChanged();
  }
  private cliOperation(remove: boolean): Promise<string> {
    if (this.cliTask) return this.cliTask;
    this.cliStatusVersion++;
    this.cliBusy = true; this.cliProgress = []; this.cliMessage = ''; this.cliChanged();
    const progress = (event: CliProgress) => {
      const index = this.cliProgress.findIndex(item => item.step === event.step);
      if (index < 0) this.cliProgress.push(event); else this.cliProgress[index] = event;
      this.cliChanged();
    };
    this.cliTask = (async () => {
      try {
        const installer = await this.cliInstaller();
        if (remove) {
          progress({ step: 'remove', title: '卸载 CLI 命令', state: 'running' }); await installer.remove();
          this.cliInstalled = false; progress({ step: 'remove', title: '卸载 CLI 命令', state: 'done' }); this.cliMessage = 'CLI 命令已卸载。';
        } else {
          const result = await installer.install(progress); this.cliInstalled = true;
          this.cliMessage = `安装完成（${result.node}）。请重新打开终端后使用 local-issues。`;
        }
        new Notice(this.cliMessage); return installer.command;
      } catch (error) {
        const { CliInstallError } = await this.desktopServices();
        if (!this.cliProgress.some(step => step.state === 'error')) progress({ step: remove ? 'remove' : 'prepare', title: remove ? '卸载 CLI 命令' : '准备安装', state: 'error', detail: error instanceof Error ? error.message : String(error), help: error instanceof CliInstallError ? error.help : '请确认相关目录可读写后重试。', link: error instanceof CliInstallError ? error.link : undefined });
        throw error;
      } finally { this.cliBusy = false; this.cliTask = undefined; this.cliChanged(); }
    })();
    return this.cliTask;
  }
  installCli(): Promise<string> { return this.cliOperation(false); }
  async removeCli(): Promise<void> { await this.cliOperation(true); }

  async restartApi(): Promise<void> {
    if (!this.desktopAvailable) return;
    this.apiQueue = this.apiQueue.catch(() => {}).then(async () => {
      if (this.server) { await this.server.close(); this.server = undefined; }
      this.apiError = '';
      if (!this.settings.apiEnabled || this.unloaded) return;
      try {
        const { startApi } = await this.desktopServices();
        this.server = await startApi({ store: this.store, port: this.settings.port,
          vaultName: this.app.vault.getName(), routes: this.routes, shares: this.settings.shares,
          saveShares: () => this.saveData(this.settings), open: ref => this.openReference(ref), author: this.settings.author,
          cliPath: await this.cliPath().catch(() => undefined),
          vaultPath: await this.vaultPath().catch(() => undefined),
          readCli: () => this.app.vault.adapter.read(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/local-issues`}/cli.mjs`),
          readAttachment: async path => {
            const file = this.app.vault.getAbstractFileByPath(path);
            if (!(file instanceof TFile)) throw new Error('附件不存在。');
            if (file.stat.size > 16 * 1024 * 1024) throw new Error('附件超过 16 MB，请在 Obsidian 中打开。');
            return new Uint8Array(await this.app.vault.readBinary(file));
          } });
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

  async copyCli(): Promise<void> { await this.copyGuide(); }

  /** SKILL.md：给已经会装 skill 的 agent。 */
  async copySkill(): Promise<void> {
    try {
      const cli = await this.cliPath();
      const vault = await this.vaultPath().catch(() => undefined);
      await navigator.clipboard.writeText(agentSkill({ origin: this.origin(), cli, vault }));
      new Notice('已复制 SKILL.md');
    } catch (error) { this.report(error); }
  }

  /** 引导语：含“存到你自己的 skills 目录”的说明，可直接粘贴给 agent。 */
  async copyGuide(): Promise<void> {
    try {
      const cli = await this.cliPath();
      const vault = await this.vaultPath().catch(() => undefined);
      await navigator.clipboard.writeText(agentGuide({ origin: this.origin(), cli, vault }));
      new Notice('已复制 Agent 引导语（含 skill 安装说明）');
    } catch (error) { this.report(error); }
  }

  async saveSettings(): Promise<void> { await this.saveData(this.settings); }

  onunload(): void {
    this.unloaded = true;
    void this.draftJournal?.flush().catch(this.report);
    this.cliListeners.clear();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    void this.apiQueue.finally(() => this.server?.close()).catch(console.error);
  }
}

type SettingsTab = 'general' | 'interaction' | 'agent';

class LocalIssuesSettings extends PluginSettingTab {
  private cliCleanup?: () => void;
  private activeTab: SettingsTab = 'general';
  hide(): void { this.cliCleanup?.(); this.cliCleanup = undefined; }
  constructor(app: App, private plugin: LocalIssuesPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl: el, plugin: p } = this;
    this.cliCleanup?.(); this.cliCleanup = undefined;
    el.empty(); suppressTooltips(el); el.addClass('li-settings');

    const header = el.createDiv({ cls: 'li-settings-header' });
    const brand = header.createDiv({ cls: 'li-settings-brand' });
    const logo = brand.createSpan({ cls: 'li-settings-logo' }); setIcon(logo, 'list-todo');
    const title = brand.createDiv();
    title.createEl('strong', { text: 'Local Issues' });
    title.createSpan({ cls: 'li-settings-version', text: p.manifest.version });
    const open = header.createEl('button', { cls: 'mod-cta', attr: { type: 'button' } });
    setIcon(open, 'arrow-up-right'); open.createSpan({ text: '打开项目' });
    open.onClickEvent(() => { void p.activate().catch(p.report); });

    const nav = el.createDiv({ cls: 'li-settings-nav', attr: { role: 'tablist', 'aria-label': '设置分类' } });
    const definitions: { id: SettingsTab; label: string; icon: string }[] = [
      { id: 'general', label: '常规', icon: 'settings-2' },
      { id: 'interaction', label: '操作', icon: 'keyboard' },
      ...(p.desktopAvailable ? [{ id: 'agent' as const, label: 'Agent', icon: 'bot' }] : []),
    ];
    const buttons = new Map<SettingsTab, HTMLButtonElement>();
    const panels = new Map<SettingsTab, HTMLElement>();
    const selectTab = (id: SettingsTab) => {
      this.activeTab = id;
      for (const [key, button] of buttons) {
        const selected = key === id;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-selected', String(selected));
        button.tabIndex = selected ? 0 : -1;
      }
      for (const [key, panel] of panels) panel.hidden = key !== id;
    };
    for (const item of definitions) {
      const button = nav.createEl('button', { cls: 'li-settings-tab', attr: { type: 'button', role: 'tab', id: `li-settings-tab-${item.id}`, 'aria-controls': `li-settings-panel-${item.id}` } });
      setIcon(button, item.icon); button.createSpan({ text: item.label });
      button.onClickEvent(() => selectTab(item.id)); buttons.set(item.id, button);
      const panel = el.createDiv({ cls: 'li-settings-panel', attr: { role: 'tabpanel', id: `li-settings-panel-${item.id}`, 'aria-labelledby': `li-settings-tab-${item.id}` } });
      panels.set(item.id, panel);
    }
    nav.addEventListener('keydown', event => {
      const current = definitions.findIndex(item => item.id === this.activeTab);
      const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? definitions.length - 1 : offset ? (current + offset + definitions.length) % definitions.length : -1;
      if (next < 0) return;
      event.preventDefault(); selectTab(definitions[next].id); buttons.get(definitions[next].id)?.focus();
    });

    const general = panels.get('general')!;
    const basics = general.createDiv({ cls: 'li-settings-card' });
    new Setting(basics).setName('我的称呼').setDesc('Issue 与评论作者').addText(t => t.setValue(p.settings.author).onChange(async value => {
      p.settings.author = value.trim() || '我'; p.store.author = p.settings.author; await p.saveSettings();
    }));
    new Setting(basics).setName('保存位置').setDesc('重启生效 · 不移动已有文件').addText(t => t.setValue(p.settings.root).onChange(async value => {
      const v = value.trim().replace(/\/$/, '');
      if (!v || v.startsWith('/') || v.includes('\\') || v.split('/').some(s => !s || s === '.' || s === '..' || s.startsWith('.'))) return;
      p.settings.root = v; await p.saveSettings();
    }));
    const local = general.createDiv({ cls: 'li-settings-note' });
    setIcon(local.createSpan(), 'file-text'); local.createSpan({ text: '本地 Markdown · 随笔记库同步' });

    const interaction = panels.get('interaction')!;
    const commenting = interaction.createDiv({ cls: 'li-settings-card' });
    const submit = new Setting(commenting).setName('评论发布');
    submit.settingEl.addClass('li-submit-setting');
    const submitControl = submit.settingEl.querySelector<HTMLElement>('.setting-item-control')!;
    submitControl.empty(); submitControl.addClass('li-segmented'); submitControl.setAttribute('role', 'group'); submitControl.setAttribute('aria-label', '评论发布方式');
    const preview = commenting.createDiv({ cls: 'li-settings-key-preview' });
    const submitButtons = new Map<string, HTMLButtonElement>();
    const renderSubmit = () => {
      for (const [mode, button] of submitButtons) {
        const selected = p.settings.commentSubmit === mode;
        button.classList.toggle('is-active', selected); button.setAttribute('aria-pressed', String(selected));
      }
      preview.empty(); preview.createSpan({ text: '换行' }); preview.createEl('kbd', { text: p.settings.commentSubmit === 'enter' ? 'Shift + Enter' : 'Enter' });
    };
    for (const mode of ['mod-enter', 'enter'] as const) {
      const button = submitControl.createEl('button', { cls: 'li-submit-option', attr: { type: 'button', 'data-mode': mode } });
      setIcon(button, mode === 'enter' ? 'corner-down-left' : 'command');
      button.createSpan({ text: mode === 'enter' ? '回车' : '快捷键' });
      button.createEl('kbd', { text: mode === 'enter' ? 'Enter' : '⌘ / Ctrl + Enter' });
      button.onClickEvent(() => { p.settings.commentSubmit = mode; renderSubmit(); void p.saveSettings().catch(p.report); });
      submitButtons.set(mode, button);
    }
    renderSubmit();

    if (Platform.isMacOS) {
      const navigation = interaction.createDiv({ cls: 'li-settings-card li-trackpad-card' });
      const guide = navigation.createDiv({ cls: 'li-gesture-guide' });
      new Setting(navigation).setName('触控板导航').setDesc('双指滑动').addToggle(t => t.setValue(p.settings.trackpadNavigation).onChange(async value => {
        p.settings.trackpadNavigation = value; guide.hidden = !value; await p.saveSettings();
      }));
      navigation.insertBefore(guide, navigation.lastChild);
      for (const direction of ['back', 'forward'] as const) {
        const back = direction === 'back';
        const card = guide.createDiv({ cls: 'li-gesture-card' });
        const visual = card.createDiv({ cls: `li-gesture-visual is-${direction}` });
        visual.setAttribute('role', 'img');
        visual.setAttribute('aria-label', back ? '双指向右滑，返回上一页' : '双指向左滑，前进到下一页');
        visual.createSpan({ cls: 'li-gesture-arrow', text: back ? '←' : '→' }).setAttribute('aria-hidden', 'true');
        const trackpad = visual.createDiv({ cls: 'li-gesture-trackpad' }); trackpad.setAttribute('aria-hidden', 'true');
        const fingers = trackpad.createDiv({ cls: 'li-gesture-fingers' });
        fingers.createSpan({ cls: 'li-gesture-finger' }); fingers.createSpan({ cls: 'li-gesture-finger' });
        card.createEl('strong', { text: back ? '向右滑 · 后退' : '向左滑 · 前进' });
      }
      guide.hidden = !p.settings.trackpadNavigation;
      const shortcut = navigation.createDiv({ cls: 'li-settings-note' });
      setIcon(shortcut.createSpan(), 'keyboard'); shortcut.createSpan({ text: '快捷键中搜索 Local Issues' });
    }

    const agent = panels.get('agent');
    if (agent) {
      const flow = agent.createDiv({ cls: 'li-settings-card li-agent-flow' });
      const step = (number: number) => flow.createDiv({ cls: 'li-agent-step', attr: { 'data-step': String(number) } });
      const apiStep = step(1);
      new Setting(apiStep).setName('开启本地服务').setDesc(p.apiError || '仅限这台电脑').addToggle(t => t.setValue(p.settings.apiEnabled).onChange(async value => {
        p.settings.apiEnabled = value; await p.saveSettings(); await p.restartApi(); this.display();
      }));

      const cliStep = step(2);
      const cli = new Setting(cliStep).setName('安装 CLI');
      let install!: HTMLButtonElement, remove!: HTMLButtonElement;
      cli.addButton(b => { install = b.buttonEl; b.setButtonText('安装 CLI').setCta().onClick(() => { void p.installCli().catch(() => {}); }); })
        .addButton(b => { remove = b.buttonEl; b.setButtonText('卸载 CLI').onClick(() => { void p.removeCli().catch(() => {}); }); });
      const cliState = cliStep.createDiv({ cls: 'li-cli-state' });
      const progress = cliStep.createDiv({ cls: 'li-cli-progress' }); progress.setAttribute('aria-live', 'polite');
      const renderCli = () => {
        install.disabled = remove.disabled = p.cliBusy;
        install.textContent = p.cliBusy ? '处理中…' : p.cliInstalled ? '修复安装' : '安装 CLI';
        remove.hidden = !p.cliInstalled && !p.cliProgress.some(item => item.step === 'command' && item.state === 'done');
        cliState.empty(); cliState.addClass(p.cliInstalled ? 'is-ready' : 'is-pending');
        const stateIcon = cliState.createSpan(); setIcon(stateIcon, p.cliInstalled ? 'circle-check' : 'terminal');
        cliState.createSpan({ text: p.cliBusy ? '正在处理' : p.cliInstalled ? 'local-issues · 已安装' : 'local-issues · 待安装' });
        progress.replaceChildren();
        for (const item of p.cliProgress) {
          const line = progress.createEl('p', { cls: `li-cli-step is-${item.state}`, text: `${item.state === 'done' ? '已完成' : item.state === 'error' ? '未完成' : '正在进行'} · ${item.title}` });
          if (item.state === 'error') {
            line.setAttribute('role', 'alert');
            progress.createEl('p', { text: item.detail || '操作失败，请重试。' });
            if (item.help) progress.createEl('p', { text: item.help, cls: 'setting-item-description' });
            if (item.link) { const link = progress.createEl('a', { text: item.step === 'node' ? '下载 Node.js' : '打开当前版本下载页', href: item.link }); link.rel = 'noopener noreferrer'; }
            if (item.step === 'node') new Setting(progress).setName('Node.js 路径').setDesc('填写后可重新安装')
              .addText(t => t.setPlaceholder('/opt/homebrew/bin/node').setValue(p.settings.cliNodePath || '').onChange(async value => { p.settings.cliNodePath = value.trim(); await p.saveSettings(); }));
          }
        }
        if (p.cliMessage) progress.createEl('p', { text: p.cliMessage, cls: 'li-cli-result' }).setAttribute('role', 'status');
      };
      this.cliCleanup = p.onCliChange(renderCli); renderCli(); void p.refreshCliStatus();

      const handoff = step(3);
      new Setting(handoff).setName('接入 Agent').setDesc('复制后粘贴给 Agent')
        .addButton(b => b.setButtonText('复制引导语').setCta().onClick(() => p.copyGuide()))
        .addButton(b => b.setButtonText('复制 Skill').onClick(() => p.copySkill()));

      const advanced = agent.createEl('details', { cls: 'li-settings-advanced' });
      const summary = advanced.createEl('summary'); setIcon(summary.createSpan(), 'settings-2'); summary.createSpan({ text: '高级设置' });
      new Setting(advanced).setName('API 端口').setDesc(`127.0.0.1:${p.settings.port}`)
        .addText(t => t.setValue(String(p.settings.port)).onChange(async value => {
          if (!/^\d+$/.test(value) || +value < 1024 || +value > 65535) return;
          p.settings.port = +value; await p.saveSettings();
        })).addButton(b => b.setButtonText('应用').onClick(async () => { await p.restartApi(); this.display(); }));
      const privacy = agent.createDiv({ cls: 'li-settings-note' });
      setIcon(privacy.createSpan(), 'shield-check'); privacy.createSpan({ text: '仅本机 · 无需账号或密钥' });
    }
    selectTab(panels.has(this.activeTab) ? this.activeTab : 'general');
  }
}
