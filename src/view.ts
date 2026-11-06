import { Platform, Component, ItemView, MarkdownRenderer, Modal, Notice, Menu, Scope, setIcon, WorkspaceLeaf, type Modifier, type ViewStateResult } from 'obsidian';
import { createLiveMarkdown, MARKDOWN_TOOLS, MARKDOWN_SHORTCUTS } from './live-markdown';
import { suppressTooltips } from './tooltips';
import { MobileModal, observeMobileViewport } from './mobile';
import { mobilePage, type MobilePage } from './mobile-layout';
import { Drafts, type DraftEditor } from './drafts';
import { issueOptions } from './issue-options';
import { orderedProjects, moveProjectOrder, layoutPreferences, type LayoutPreferences } from './layout-preferences';
import { pointerDrag } from './pointer-drag';
import { ISSUE_STATUSES, STATUS_NAMES, CLOSE_REASON_NAMES, issueLink, CloseReason, Issue, IssueInput, IssuePatch, IssueStore, Project, ProjectStatus, Snapshot, TimelineEntry } from './types';

export const VIEW_TYPE = 'local-issues-view';
export interface ViewHost { draftCache?: Drafts; store: IssueStore; author: string; layout?: LayoutPreferences; saveLayout?(patch: Partial<LayoutPreferences>): Promise<void>; openNote(path: string): Promise<void>; resourceLink(ref?: string, scope?: 'issues'): Promise<string>; openSettings(): void; }
const PROJECT_STATES: ProjectStatus[] = ['active', 'paused', 'completed', 'archived'];
const el = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); node.className = cls; if (text) node.textContent = text; parent.append(node); return node; };
function prependIcon(parent: HTMLElement, name: string) { const icon = el(parent, 'span', 'li-icon'); setIcon(icon, name); icon.setAttribute('aria-hidden', 'true'); parent.prepend(icon); parent.addClass('li-with-icon'); }
const action = (parent: HTMLElement, text: string, run: () => void, cls = '', icon = '') => { const b = el(parent, 'button', cls, text); b.type = 'button'; icon ||= ({ 编辑: 'pencil', 编辑标题: 'pencil', 笔记: 'file-text', 删除: 'trash-2', 草稿: 'file-pen-line' } as Record<string, string>)[text] || ''; if (icon) prependIcon(b, icon); b.addEventListener('click', run); return b; };
const safe = (fn: () => Promise<unknown>) => { void fn().catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
let controlId = 0;
function labelControl(control: HTMLElement, fallback = '') { const field = control.closest('.li-field'); const label = field?.querySelector(':scope > label'); const id = `li-control-${++controlId}`; control.id = id; if (label instanceof HTMLLabelElement) label.htmlFor = id; control.setAttribute('aria-label', label?.textContent || fallback); }
const words = (s: string) => s.split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
const date = (s: string) => s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const STATE_ICONS: Record<string, string> = { open: 'circle-dot', active: 'circle-dot', closed: 'circle-check', completed: 'circle-check', 'on-hold': 'circle-pause', paused: 'circle-pause', 'not-planned': 'circle-slash', archived: 'archive' };
function select(parent: HTMLElement, options: [string, string][], value: string, changed: (value: string) => void): HTMLSelectElement {
  const state = options.some(([key]) => key === 'completed') && options.every(([key]) => key in STATE_ICONS || !key);
  const icon = state ? STATE_ICONS[value] : /不分组/.test(options[0]?.[1] || '') ? 'group' : /最近更新/.test(options[0]?.[1] || '') ? 'arrow-down-wide-narrow' : '';
  const control = icon ? el(parent, 'span', 'li-select-control') : parent;
  if (icon) prependIcon(control, icon);
  const input = el(control, 'select');
  for (const [key, name] of options) { const opt = el(input, 'option', '', name); opt.value = key; }
  input.value = value; labelControl(input, options[0]?.[1] || '选项');
  input.addEventListener('change', () => { if (state) { const node = control.querySelector<HTMLElement>('.li-icon'); if (node) setIcon(node, STATE_ICONS[input.value] || 'circle-dot'); } changed(input.value); });
  return input;
}
function input(parent: HTMLElement, placeholder: string, value = '') { const field = el(parent, 'input'); field.type = 'text'; field.enterKeyHint = 'done'; field.placeholder = placeholder; field.value = value; labelControl(field, placeholder); return field; }
function pill(parent: HTMLElement, status: string, reason?: CloseReason) {
  const closedReason = reason || 'completed'; const label = status === 'closed' ? (reason ? `已关闭 · ${CLOSE_REASON_NAMES[closedReason]}` : '已关闭') : STATUS_NAMES[status as keyof typeof STATUS_NAMES] || status;
  const node = el(parent, 'span', `li-status li-status-${status}${status === 'closed' ? ` li-reason-${closedReason}` : ''}`);
  const icon = status === 'closed' ? closedReason === 'completed' ? 'circle-check' : closedReason === 'on-hold' ? 'circle-pause' : 'circle-slash' : ({ open: 'circle-dot', active: 'circle-dot', paused: 'circle-pause', completed: 'circle-check', archived: 'archive' } as Record<string, string>)[status];
  if (icon) prependIcon(node, icon);
  el(node, 'span', '', label);
}
const stateOptions: [string, string][] = [['open', '开启'], ['completed', '关闭 · 完成'], ['on-hold', '关闭 · 搁置'], ['not-planned', '关闭 · 不做']];
const stateValue = (issue: Pick<Issue, 'status' | 'closeReason'>) => issue.status === 'closed' ? issue.closeReason || 'completed' : 'open';
const statePatch = (value: string): IssuePatch => value === 'open' ? { status: 'open' } : { status: 'closed', closeReason: value as CloseReason };
interface IssueViewState { creating?: { projectId: string; defaults: Partial<IssueInput> }; projectId?: string; issueId?: string; query?: string; projectState?: string; issueState?: 'open' | 'closed'; mode?: 'list' | 'board' | 'table'; label?: string; milestone?: string; sort?: string; projectSort?: string; group?: string; }

export class IssuesView extends ItemView {
  private projectId?: string;
  private issueId?: string;
  private creating?: { projectId: string; defaults: Partial<IssueInput> };
  private activeEdit?: { element: HTMLElement; label: string; dirty: () => boolean; discard: () => void };
  private discardPrompt?: Modal;
  private deletePrompt?: Modal;
  private relationPicker?: Modal;
  private submissionNotice?: Notice;
  private submittingComment = false;
  private data: Snapshot = { projects: [], issues: [], timeline: [], warnings: [] };
  private query = '';
  private state = '';
  private issueState: 'open' | 'closed' = 'open';
  private label = '';
  private milestone = '';
  private sort = 'updated';
  private projectSort: string;
  private layout: LayoutPreferences;
  private group = '';
  private projectFields = new Set(['progress', 'count', 'status', 'due']);
  private issueFields = new Set(['status', 'labels', 'milestone', 'assignees', 'due']);
  private mode: 'list' | 'board' | 'table' = 'list';
  private selected = new Set<string>();
  private batching = false;
  private batchFeedback = '';
  private drafts = new Map<string, string>();
  private draftCache: Drafts;
  private editors = new WeakMap<HTMLElement, DraftEditor>();
  private shortcutEditors = new WeakMap<HTMLElement, ReturnType<typeof createLiveMarkdown>>();
  private renderScope = new Component();
  private generation = 0;
  private pending = false;
  private closed = false;
  private layoutDragging = false;
  private initialState = true;
  private resumeOnDraw?: string;
  private bindings = new Set<{ save(): void }>();
  private mobilePropertiesOpen = false;
  private phone?: MobilePage;
  private leaveMobileEdit?: () => void;
  private disposeViewport?: () => void;
  constructor(leaf: WorkspaceLeaf, private host: ViewHost) { super(leaf); this.navigation = true; this.layout = layoutPreferences(host.layout); this.projectSort = this.layout.projectSort || 'updated'; this.scope = new Scope(this.app.scope); this.bindMarkdownShortcuts(this.scope); this.draftCache = host.draftCache || new Drafts({ read: () => undefined, write: () => {} }, message => { new Notice(message, 0); }); }
  private bindMarkdownShortcuts(scope: Scope) {
    for (const [modifiers, key, command] of MARKDOWN_SHORTCUTS) scope.register(modifiers as Modifier[], key.toUpperCase(), event => {
      if (event.isComposing) return;
      const target = event.target as HTMLElement | null;
      const container = target?.closest?.('.li-live-editor');
      const editor = container instanceof HTMLElement ? this.shortcutEditors.get(container) : undefined;
      if (editor?.shortcut(command)) { event.preventDefault(); event.stopPropagation(); return false; }
    });
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Local Issues'; }
  getIcon() { return 'list-todo'; }
  async onOpen() { this.closed = false; this.disposeViewport?.(); this.disposeViewport = observeMobileViewport(this.contentEl); suppressTooltips(this.contentEl); this.renderScope.load(); await this.refresh(); }
  async onClose() { this.closed = true; ++this.generation; this.disposeViewport?.(); this.disposeViewport = undefined; this.deletePrompt?.close(); this.relationPicker?.close(); this.submissionNotice?.hide(); this.discardPrompt?.close(); this.stopEditing(); this.captureDrafts(); this.renderScope.unload(); }
  getState() { return { projectId: this.projectId, issueId: this.issueId, creating: this.creating, query: this.query, projectState: this.state, issueState: this.issueState, mode: this.mode, label: this.label, milestone: this.milestone, sort: this.sort, projectSort: this.projectSort, group: this.group }; }
  getEphemeralState() { return { scrollTop: (this.phone?.content || this.contentEl).scrollTop }; }
  setEphemeralState(state: { scrollTop?: number }) { if (typeof state?.scrollTop === 'number' && Number.isFinite(state.scrollTop)) (this.phone?.content || this.contentEl).scrollTop = Math.max(0, state.scrollTop); }
  private captureDrafts() { for (const binding of this.bindings) binding.save(); }
  private get editingInline() {
    if (this.activeEdit && !this.contentEl.contains(this.activeEdit.element)) this.stopEditing(true);
    return !!this.activeEdit;
  }
  private startEditing(element: HTMLElement, label: string, dirty: () => boolean, discard: () => void) {
    ++this.generation;
    this.activeEdit = { element, label, dirty, discard };
    element.addClass('li-editing');
    if (this.phone) {
      queueMicrotask(() => {
        if (this.activeEdit?.element !== element || !element.isConnected || !this.phone) return;
        const buttons = element.querySelector<HTMLElement>('.li-editor-actions:not(:empty), :scope > .li-inline-actions, .li-inline-actions');
        this.leaveMobileEdit = this.phone.edit(element, label, buttons || undefined);
        this.locateEditing();
      });
      return;
    }
    const bar = this.contentEl.querySelector('.li-topbar');
    if (bar instanceof HTMLElement) { const location = action(bar, `正在编辑：${label}`, () => this.locateEditing(), 'li-editing-location li-subtle'); location.title = `定位编辑：${label}`; }
  }
  private locateEditing() {
    if (!this.editingInline) return;
    const element = this.activeEdit!.element;
    const focus = element.querySelector<HTMLElement>('.cm-content, input:not([type="hidden"]), select') || element.querySelector<HTMLElement>('button');
    if (this.phone) {
      if (focus?.matches('input,select')) focus.scrollIntoView?.({ block: 'nearest' });
    } else element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    focus?.focus({ preventScroll: true });
  }
  private stopEditing(discard = false) {
    const edit = this.activeEdit; this.activeEdit = undefined;
    this.leaveMobileEdit?.(); this.leaveMobileEdit = undefined;
    edit?.element.removeClass('li-editing');
    this.contentEl.querySelector('.li-editing-location')?.remove();
    if (discard) { this.captureDrafts(); if (edit) this.draftCache.suspend(); edit?.discard(); }
  }
  private afterEditing(run: () => void | Promise<unknown>, allowDuringSubmission = false): Promise<void> {
    if (this.discardPrompt?.modalEl.isConnected) {
      this.discardPrompt.modalEl.querySelector<HTMLElement>('button')?.focus();
      return Promise.resolve();
    }
    this.discardPrompt = undefined;
    if (this.batching) { new Notice('正在批量更新，请稍候。'); return Promise.resolve(); }
    if (this.submittingComment && !allowDuringSubmission) {
      this.submissionNotice ??= new Notice('评论正在发表，请稍候再操作。', 0);
      return Promise.resolve();
    }
    if (!this.editingInline || !this.activeEdit!.dirty()) {
      this.stopEditing(true);
      return (async () => { await run(); })();
    }
    const edit = this.activeEdit!;
    const modal = this.discardPrompt = this.modal('离开当前编辑？');
    el(modal.contentEl, 'p', '', `正在编辑：${edit.label}`);
    el(modal.contentEl, 'p', 'li-muted', '输入已暂存在本机，继续操作后可重新打开编辑，接着上次的草稿。');
    let discard = false;
    return new Promise<void>((resolve, reject) => {
      modal.onClose = () => {
        this.discardPrompt = undefined;
        if (!discard) { void Promise.resolve().then(() => { this.locateEditing(); resolve(); }); return; }
        this.stopEditing(true);
        void Promise.resolve().then(run).then(() => resolve(), reject);
      };
      const buttons = el(modal.modalEl, 'div', 'li-modal-actions');
      const keep = action(buttons, '返回编辑', () => modal.close());
      action(buttons, '保留草稿并继续', () => { discard = true; modal.close(); }, 'mod-warning');
      modal.open(); keep.focus();
    });
  }
  async setState(state: IssueViewState, result: ViewStateResult) {
    if (this.initialState) {
      this.initialState = false;
      const data = await this.host.store.snapshot();
      this.migrateDrafts(data);
      const key = this.draftCache.active(), route = key && this.draftRoute(key, data);
      if (route && (!state.projectId || (state.projectId === route.projectId && (!state.issueId || state.issueId === route.issueId)))) {
        state = { ...state, ...route };
        this.resumeOnDraw = key;
      }
    }
    const before = JSON.stringify(this.getState());
    result.history = false;
    await this.afterEditing(async () => {
      this.projectId = state.projectId; this.issueId = state.issueId; this.creating = state.creating?.projectId === state.projectId ? state.creating : undefined;
      this.query = state.query || ''; this.state = state.projectState || ''; this.issueState = state.issueState === 'closed' ? 'closed' : 'open';
      this.mode = state.mode === 'board' || state.mode === 'table' ? state.mode : 'list';
      this.label = state.label || ''; this.milestone = state.milestone || ''; this.sort = state.sort || 'updated'; this.group = state.group || '';
      this.projectSort = state.projectSort || this.layout.projectSort || 'updated';
      this.selected.clear(); this.batchFeedback = '';
      await this.draw(); (this.phone?.content || this.contentEl).scrollTop = 0;
      result.history = before !== JSON.stringify(this.getState());
    });
    await super.setState(this.getState(), result);
  }
  async navigate(projectId?: string, issueId?: string) {
    await this.afterEditing(async () => {
      this.draftCache.suspend();
      await this.leaf.setViewState({ type: VIEW_TYPE, state: { ...this.getState(), projectId, issueId, creating: undefined, query: '', projectState: '', label: '', milestone: '', ...(projectId !== this.projectId ? { group: '', issueState: 'open' } : {}) } });
    });
  }
  async refresh() {
    const active = document.activeElement;
    if (this.creating || this.editingInline || this.submittingComment || this.batching || (this.contentEl.contains(active) && (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.dataset.editor) || (active instanceof HTMLElement && active.closest('.li-live-editor'))))) { this.pending = true; this.showPending(); return; }
    await this.draw();
  }
  private showPending() { if (this.contentEl.querySelector('.li-pending')) return; const bar = this.contentEl.querySelector('.li-topbar'); if (bar instanceof HTMLElement) action(bar, '有更新 · 刷新', () => safe(() => this.afterEditing(() => this.draw())), 'li-pending', 'refresh-cw'); }
  private async draw() {
    if (this.closed) return;
    if (this.editingInline || this.submittingComment || this.batching || this.layoutDragging) { this.pending = true; this.showPending(); return; }
    const sequence = ++this.generation;
    const data = await this.host.store.snapshot(); if (sequence !== this.generation) return;
    this.data = data; this.pending = false; this.captureDrafts(); this.renderScope.unload(); this.bindings.clear(); this.renderScope = new Component(); this.renderScope.load();
    this.contentEl.replaceChildren(); this.contentEl.addClass('local-issues');
    const shell = el(this.contentEl, 'div', 'li-shell');
    const project = data.projects.find(p => p.id === this.projectId);
    let body: HTMLElement = shell;
    this.phone = Platform.isMobile ? mobilePage(shell) : undefined;
    if (this.phone) {
      const page = this.phone;
      page.title.textContent = this.creating ? '新建议题' : this.issueId ? `#${data.issues.find(i => i.id === this.issueId)?.number || ''}` : project?.title || `项目 · ${data.projects.length}`;
      if (project) action(page.leading, '返回', () => safe(() => this.navigate(this.issueId || this.creating ? project.id : undefined)), 'li-subtle li-mobile-back', 'chevron-left');
      action(page.actions, '草稿', () => this.showDrafts(), 'li-subtle').setAttribute('aria-label', '草稿');
      if (!project) action(page.actions, '设置', () => this.host.openSettings(), 'li-subtle', 'settings');
      body = page.content;
    } else {
      const top = el(shell, 'div', 'li-topbar');
      action(top, '项目', () => safe(() => this.navigate()), 'li-breadcrumb');
      if (project) { el(top, 'span', 'li-muted', '/'); action(top, project.title, () => safe(() => this.navigate(project.id)), 'li-breadcrumb'); }
      action(top, '草稿', () => this.showDrafts(), 'li-subtle'); el(top, 'div', 'li-spacer'); action(top, '设置', () => this.host.openSettings(), 'li-subtle', 'settings');
    }
    if (data.warnings.length) { const details = el(body, 'details', 'li-warning'); el(details, 'summary', '', `${data.warnings.length} 个笔记需要检查`); for (const warning of data.warnings) el(details, 'div', '', warning); }
    if (this.creating && project && this.creating.projectId === project.id) this.issueModal(project, undefined, this.creating.defaults, body);
    else if (this.issueId) { const issue = data.issues.find(i => i.id === this.issueId); if (issue) this.renderIssue(body, issue); else { el(body, 'p', '', '此 Issue 已移动或不存在。'); action(body, '返回项目', () => safe(() => this.navigate(project?.id))); } }
    else if (project) this.renderProject(body, project);
    else this.renderProjects(body);
    if (this.resumeOnDraw) { const key = this.resumeOnDraw; this.resumeOnDraw = undefined; this.openDraftEditor(key); }
  }
  private markdown(parent: HTMLElement, body: string, path: string) {
    const node = el(parent, 'div', 'li-markdown markdown-rendered');
    safe(() => MarkdownRenderer.render(this.app, body || '*暂无描述*', node, path, this.renderScope));
    node.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest('a.internal-link') as HTMLAnchorElement | null;
      if (!target || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const href = target.dataset.href || target.getAttribute('href'); if (!href) return;
      const [linkpath, ...subpath] = href.split('#');
      const resolved = this.app.metadataCache.getFirstLinkpathDest(linkpath, path)?.path || linkpath;
      const item = this.data.issues.find(i => i.path.replace(/\.md$/, '') === resolved.replace(/\.md$/, ''));
      event.preventDefault(); event.stopPropagation();
      // Let the native Markdown view handle heading/block locations and ordinary notes.
      if (item && !subpath.length) safe(() => this.navigate(item.projectId, item.id));
      else safe(() => this.afterEditing(() => this.app.workspace.openLinkText(href, path, false)));
    }, true);
    return node;
  }
  private migrateDrafts(data: Snapshot) {
    // Read old drafts once by their known keys; keep the originals as a migration backup.
    if (this.draftCache.list().length) return;
    this.draftCache.read('new-project');
    for (const project of data.projects) { this.draftCache.read(`new-issue:${project.id}:`); this.draftCache.read(`project:${project.id}`); }
  }
  private draftRoute(key: string, data = this.data): IssueViewState | undefined {
    const [kind, id, parent] = key.split(':');
    if (kind === 'new-project') return {};
    if (kind === 'project' || kind === 'new-issue') {
      if (!data.projects.some(project => project.id === id)) return;
      return { projectId: id, ...(kind === 'new-issue' ? { creating: { projectId: id, defaults: parent ? { parent } : {} } } : {}) };
    }
    const issueId = kind === 'comment' ? data.timeline.find(entry => entry.id === id)?.issueId : id;
    const issue = data.issues.find(issue => issue.id === issueId);
    if (issue && ['issue-body', 'issue-title', 'issue-field', 'new-comment', 'comment'].includes(kind)) return { projectId: issue.projectId, issueId: issue.id };
  }
  private openDraftEditor(key: string) {
    const [kind, id, name] = key.split(':');
    const click = (parent: Element | null, label: string) => [...(parent?.querySelectorAll<HTMLButtonElement>('button') || [])].find(button => button.textContent === label || button.getAttribute('aria-label') === label)?.click();
    if (kind === 'new-project') this.projectModal();
    else if (kind === 'project') { const project = this.data.projects.find(project => project.id === id); if (project) this.projectModal(project); }
    else if (kind === 'issue-body') click(this.contentEl.querySelector('.li-description'), '编辑');
    else if (kind === 'issue-title') click(this.contentEl, '编辑标题');
    else if (kind === 'comment') click([...this.contentEl.querySelectorAll<HTMLElement>('[data-comment-id]')].find(node => node.dataset.commentId === id) || null, '编辑');
    else if (kind === 'new-comment') { if (this.phone) click(this.phone.actions, '继续评论'); else this.contentEl.querySelector<HTMLElement>('.li-composer .cm-content')?.focus(); }
    else if (kind === 'issue-field') { const properties = this.contentEl.querySelector<HTMLDetailsElement>('.li-mobile-properties'); if (properties) properties.open = true; click(this.contentEl, `修改${name}`); }
  }
  private showDrafts() {
    safe(() => this.afterEditing(() => {
      const modal = this.modal('草稿');
      const drafts = this.draftCache.list();
      if (!drafts.length) el(modal.contentEl, 'p', 'li-muted', '没有未提交的草稿。');
      for (const draft of drafts) {
        const route = this.draftRoute(draft.key), project = this.data.projects.find(project => project.id === route?.projectId), issue = this.data.issues.find(issue => issue.id === route?.issueId);
        const row = el(modal.contentEl, 'article', 'li-draft-item');
        const [kind] = draft.key.split(':');
        const type = ({ 'new-issue': '新建议题', 'new-project': '新建项目', project: '编辑项目', 'issue-body': '编辑正文', 'issue-title': '编辑标题', 'issue-field': '编辑属性', comment: '编辑评论', 'new-comment': '未发表的评论' } as Record<string, string>)[kind] || '未提交的输入';
        el(row, 'strong', '', (['new-issue', 'new-project', 'project', 'issue-title'].includes(kind) ? draft.value.fields[0] : issue?.title) || issue?.title || type);
        el(row, 'p', 'li-muted', `${project?.title ? project.title + ' · ' : ''}${type}`);
        action(row, route ? '继续编辑' : '查看内容', () => {
          modal.close();
          if (!route) { const copy = this.modal('草稿内容'); el(copy.contentEl, 'pre', 'li-draft-raw', [...draft.value.fields, ...draft.value.editors].join('\n\n')); copy.open(); return; }
          safe(async () => {
            this.draftCache.activate(draft.key);
            await this.leaf.setViewState({ type: VIEW_TYPE, state: { ...this.getState(), projectId: undefined, issueId: undefined, creating: undefined, ...route } });
            this.openDraftEditor(draft.key);
          });
        }, 'mod-cta');
      }
      modal.open();
    }));
  }
  private cacheForm(root: HTMLElement, key: string, revision?: string, extra?: { read(): unknown; restore?(value: unknown): void }) {
    const nodes = root.matches('.li-editor') ? [root] : [...root.querySelectorAll<HTMLElement>('.li-editor')];
    const binding = this.draftCache.bind(root, key, nodes.map(node => this.editors.get(node)!).filter(Boolean), { revision, extra });
    this.bindings.add(binding); return binding;
  }
  private async writeLayout(patch: Partial<LayoutPreferences>) {
    const previous = this.layout;
    this.layout = { ...previous, ...patch };
    try { await this.host.saveLayout?.(patch); }
    catch (error) { this.layout = previous; throw error; }
  }
  private sidebarResizer(detail: HTMLElement) {
    const handle = el(detail, 'div', 'li-detail-resizer'); handle.tabIndex = 0;
    handle.setAttribute('role', 'separator'); handle.setAttribute('aria-orientation', 'vertical'); handle.setAttribute('aria-label', '调整属性栏宽度');
    handle.setAttribute('aria-description', '左右拖动调整宽度，方向键微调，双击恢复默认');
    let width = this.layout.sidebarWidth || 240, startX = 0, startWidth = width, startDesired = width;
    const maximum = () => Math.max(180, Math.floor(Math.min(480, (detail.getBoundingClientRect().width || 1200) * .4)));
    const apply = () => {
      const effective = Math.round(Math.max(180, Math.min(maximum(), width)));
      detail.setCssProps({ '--li-sidebar-width': `${effective}px` });
      handle.setAttribute('aria-valuemin', '180'); handle.setAttribute('aria-valuemax', String(Math.floor(maximum()))); handle.setAttribute('aria-valuenow', String(effective));
      return effective;
    };
    const save = () => safe(async () => {
      try { await this.writeLayout({ sidebarWidth: apply() }); }
      catch (error) { width = this.layout.sidebarWidth || 240; apply(); throw error; }
      if (this.pending && !this.editingInline) await this.draw();
    });
    this.renderScope.register(pointerDrag(handle, {
      start: event => { if (this.layoutDragging) return false; startX = event.clientX; startDesired = width; startWidth = apply(); this.layoutDragging = true; detail.addClass('is-resizing'); return true; },
      move: event => { width = Math.max(180, Math.min(maximum(), startWidth + startX - event.clientX)); apply(); },
      end: (_event, cancelled) => { this.layoutDragging = false; detail.removeClass('is-resizing'); if (cancelled) { width = startDesired; apply(); if (this.pending && !this.closed) safe(() => this.draw()); } else save(); },
    }));
    this.renderScope.registerDomEvent(handle, 'keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      width = event.key === 'Home' ? 180 : event.key === 'End' ? maximum() : apply() + (event.key === 'ArrowLeft' ? 16 : -16); apply(); save();
    });
    this.renderScope.registerDomEvent(handle, 'dblclick', () => { width = 240; apply(); save(); });
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(apply);
    observer?.observe(detail); this.renderScope.register(() => observer?.disconnect()); apply();
  }
  private async reorderProject(source: Project, target: Project, after: boolean, visible: Project[]) {
    if (source.id === target.id) return;
    if (this.group === 'status' && source.status !== target.status) { new Notice('按状态分组时，请在同一组内调整顺序'); return; }
    const before = this.projectSort;
    const base = orderedProjects(this.data.projects, this.projectSort, this.layout.projectOrder).map(project => project.id);
    const projectOrder = moveProjectOrder(base, visible.map(project => project.id), source.id, target.id, after);
    const scroll = (this.phone?.content || this.contentEl).scrollTop;
    this.projectSort = 'manual';
    try { await this.writeLayout({ projectOrder, projectSort: 'manual' }); }
    catch (error) { this.projectSort = before; throw error; }
    await this.draw(); (this.phone?.content || this.contentEl).scrollTop = scroll;
    [...this.contentEl.querySelectorAll<HTMLButtonElement>('.li-project-drag-handle')].find(button => button.dataset.projectId === source.id)?.focus({ preventScroll: true });
    new Notice(`已调整「${source.title}」的顺序`);
  }
  private projectDragHandle(parent: HTMLElement, row: HTMLElement, project: Project, visible: Project[]) {
    row.dataset.projectId = project.id;
    const handle = action(parent, '', () => {}, 'li-subtle li-project-drag-handle', 'grip-vertical'); handle.dataset.projectId = project.id;
    handle.setAttribute('aria-label', `拖动项目：${project.title}`); handle.setAttribute('aria-description', '拖动调整顺序，也可以使用上下方向键');
    handle.addEventListener('click', event => event.stopPropagation());
    let startX = 0, startY = 0, x = 0, y = 0, moved = false, frame = 0, destination: Project | undefined, after = false;
    const win = row.ownerDocument.defaultView!;
    const clearMarker = () => { for (const node of this.contentEl.querySelectorAll('.li-drop-before,.li-drop-after')) node.removeClass('li-drop-before', 'li-drop-after'); };
    const targetAtPointer = () => {
      clearMarker(); destination = undefined;
      const target = row.ownerDocument.elementFromPoint(x, y)?.closest<HTMLElement>('[data-project-row]');
      if (!target || !this.contentEl.contains(target) || target === row) return;
      destination = visible.find(project => project.id === target.dataset.projectId);
      if (!destination) return;
      after = y > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2;
      target.addClass(after ? 'li-drop-after' : 'li-drop-before');
    };
    const autoscroll = () => {
      const content = this.phone?.content || this.contentEl, bounds = content.getBoundingClientRect();
      if (y < bounds.top + 36) content.scrollTop -= 12;
      else if (y > bounds.bottom - 36) content.scrollTop += 12;
      targetAtPointer(); frame = win.requestAnimationFrame(autoscroll);
    };
    this.renderScope.register(pointerDrag(handle, {
      start: event => { if (this.editingInline || this.batching || this.layoutDragging) return false; startX = x = event.clientX; startY = y = event.clientY; moved = false; destination = undefined; this.layoutDragging = true; return true; },
      move: event => {
        x = event.clientX; y = event.clientY;
        if (!moved && Math.hypot(x - startX, y - startY) > 5) { moved = true; row.addClass('is-reordering'); handle.setAttribute('aria-pressed', 'true'); frame = win.requestAnimationFrame(autoscroll); }
        if (moved) targetAtPointer();
      },
      end: (_event, cancelled) => {
        win.cancelAnimationFrame(frame); this.layoutDragging = false; row.removeClass('is-reordering'); handle.setAttribute('aria-pressed', 'false'); clearMarker();
        if (!cancelled && moved && destination) safe(() => this.reorderProject(project, destination!, after, visible));
        else if (this.pending && !this.closed) safe(() => this.draw());
      },
    }));
    this.renderScope.registerDomEvent(handle, 'keydown', event => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      event.preventDefault(); event.stopPropagation(); const direction = event.key === 'ArrowDown' ? 1 : -1;
      const target = visible[visible.findIndex(candidate => candidate.id === project.id) + direction];
      if (target) safe(() => this.reorderProject(project, target, direction > 0, visible));
    });
    row.setAttribute('data-project-row', 'true');
  }
  private mobileSearch(placeholder: string, project?: Project) {
    const row = el(this.phone!.controls, 'form', 'li-mobile-search');
    const search = input(row, placeholder, this.query); search.type = 'search'; search.enterKeyHint = 'search'; search.dataset.editor = 'true'; search.setAttribute('aria-label', placeholder);
    const find = action(row, '搜索', () => { this.query = search.value; search.blur(); safe(() => this.draw()); }, 'li-subtle li-mobile-search-submit', 'search'); find.setAttribute('aria-label', '执行搜索');
    row.addEventListener('submit', event => { event.preventDefault(); find.click(); });
    search.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); find.click(); } });
    const active = this.state || this.label || this.milestone || this.group || (project ? this.sort : this.projectSort) !== 'updated' || (project && this.mode !== 'list');
    action(row, active ? '筛选 ·' : '筛选', () => this.mobileFilters(project), 'li-subtle', 'sliders-horizontal');
  }
  private mobileFilters(project?: Project) {
    const modal = this.modal(project ? '筛选与视图' : '筛选项目'); modal.modalEl.addClass('li-mobile-filter-sheet');
    const form = modal.contentEl;
    const options = (name: string, items: [string, string][], value: string) => select(this.field(form, name), items, value, () => {});
    const all = this.data.issues.filter(i => i.projectId === project?.id);
    const state = !project ? options('状态', [['', '所有状态'], ...PROJECT_STATES.map(s => [s, STATUS_NAMES[s]] as [string, string])], this.state) : undefined;
    const mode = project ? options('视图', [['list', 'Issues'], ['board', '看板'], ['table', '表格']], this.mode) : undefined;
    const label = project ? options('标签', [['', '所有标签'], ...[...new Set(all.flatMap(i => i.labels))].sort().map(s => [s, s] as [string, string])], this.label) : undefined;
    const milestone = project ? options('里程碑', [['', '所有里程碑'], ...[...new Set(all.map(i => i.milestone).filter(Boolean))].sort().map(s => [s, s] as [string, string])], this.milestone) : undefined;
    const sort = options('排序', [['updated', '最近更新'], ...(project ? [['created', '最早创建']] as [string, string][] : [['manual', '手动排序']] as [string, string][]), ['title', '名称'], ['due', '截止日期']], project ? this.sort : this.projectSort);
    const group = options('分组', project ? [['', '不分组'], ['status', '按状态'], ['milestone', '按里程碑'], ['label', '按标签']] : [['', '不分组'], ['status', '按状态']], this.group);
    const buttons = el(modal.modalEl, 'div', 'li-modal-actions');
    action(buttons, '重置', () => { for (const field of form.querySelectorAll('select')) field.value = field === sort ? 'updated' : field === mode ? 'list' : ''; });
    action(buttons, '取消', () => modal.close());
    action(buttons, '应用', () => safe(async () => { this.state = state?.value || ''; this.mode = (mode?.value || 'list') as typeof this.mode; this.label = label?.value || ''; this.milestone = milestone?.value || ''; if (project) this.sort = sort.value; else { this.projectSort = sort.value; await this.writeLayout({ projectSort: sort.value }); } this.group = group.value; this.selected.clear(); modal.close(); await this.draw(); }), 'mod-cta');
    modal.open();
  }
  private renderProjects(root: HTMLElement) {
    if (this.phone) {
      action(this.phone.actions, '新建', () => this.projectModal(), 'mod-cta').setAttribute('aria-label', '新建项目');
      this.mobileSearch('搜索项目');
    } else {
      const head = el(root, 'div', 'li-heading'); el(head, 'h2', '', '项目'); el(head, 'span', 'li-muted', `${this.data.projects.length} 个项目`); const actions = el(head, 'div', 'li-heading-actions'); if (!Platform.isMobile) action(actions, '复制仓库链接', () => safe(async () => { await navigator.clipboard.writeText(await this.host.resourceLink()); new Notice('已复制仓库链接'); }), '', 'link'); action(actions, '新建项目', () => this.projectModal(), 'mod-cta', 'plus');
      const searchRow = el(root, 'div', 'li-search-row'); const search = input(searchRow, '搜索项目', this.query); search.setAttribute('aria-label', '搜索项目'); search.addEventListener('change', () => { this.query = search.value; safe(() => this.draw()); }); search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.query = search.value; safe(() => this.draw()); } });
      const tools = el(root, 'div', 'li-toolbar');
      select(tools, [['', '所有状态'], ...PROJECT_STATES.map(s => [s, STATUS_NAMES[s]] as [string, string])], this.state, value => { this.state = value; safe(() => this.draw()); });
      select(tools, [['updated', '最近更新'], ['manual', '手动排序'], ['title', '项目名称'], ['due', '截止日期']], this.projectSort, value => safe(async () => { this.projectSort = value; await this.writeLayout({ projectSort: value }); await this.draw(); }));
      select(tools, [['', '不分组'], ['status', '按状态分组']], this.group, value => { this.group = value; safe(() => this.draw()); });
      if (!Platform.isMobile) this.fieldsButton(tools, this.projectFields, [['progress', '进度'], ['count', 'Issues 数'], ['status', '状态'], ['due', '截止日期']]);
    }
    const matching = this.data.projects.filter(p => `${p.title} ${p.description}`.toLowerCase().includes(this.query.toLowerCase()));
    const archived = matching.filter(p => p.status === 'archived');
    const projects = orderedProjects(matching.filter(p => p.status !== 'archived' && (!this.state || p.status === this.state)), this.projectSort, this.layout.projectOrder);
    if (this.group === 'status') projects.sort((a, b) => PROJECT_STATES.indexOf(a.status) - PROJECT_STATES.indexOf(b.status));
    if (!this.data.projects.length) { const empty = el(root, 'div', 'li-empty'); setIcon(el(empty, 'div', 'li-empty-icon'), 'folders'); el(empty, 'h3', '', '把想法变成项目'); el(empty, 'p', 'li-muted', '为每个项目记录 Issues、讨论和进度，所有内容保存在本地 Markdown 中。'); action(empty, '创建第一个项目', () => this.projectModal(), 'mod-cta', 'plus'); return; }
    if (Platform.isMobile) {
      const cards = el(root, 'div', 'li-project-cards');
      let group = '';
      for (const project of projects) {
        if (this.group && group !== project.status) { group = project.status; el(cards, 'h3', 'li-section-heading', STATUS_NAMES[project.status]); }
        const card = el(cards, 'article', 'li-project-card'); this.tapCard(card, () => this.navigate(project.id));
        const heading = el(card, 'div', 'li-project-card-heading'); this.projectDragHandle(heading, card, project, projects); action(heading, project.title, () => safe(() => this.navigate(project.id)), 'li-project-title');
        action(heading, '编辑', () => this.projectModal(project), 'li-subtle');
        if (project.description) el(card, 'p', 'li-muted', project.description.split('\n')[0]);
        const issues = this.data.issues.filter(i => i.projectId === project.id), done = issues.filter(i => i.status === 'closed').length;
        const meta = el(card, 'div', 'li-project-card-meta'); pill(meta, project.status); el(meta, 'span', 'li-muted', `${done}/${issues.length} 个议题完成`);
        if (project.dueDate) el(meta, 'span', 'li-muted', `截止 ${project.dueDate}`);
      }
      if (!projects.length) el(root, 'p', 'li-empty', archived.length ? '没有进行中的项目，已归档的在下方。' : '没有匹配的项目。');
      this.renderArchived(root, archived); return;
    }
    const table = el(root, 'table', 'li-table li-projects'); const tr = el(el(table, 'thead'), 'tr'); for (const name of ['', '项目', '进度', 'Issues', '状态', '截止', '']) el(tr, 'th', '', name); const body = el(table, 'tbody');
    let group = ''; for (const project of projects) { if (this.group && group !== project.status) { group = project.status; const cell = el(el(body, 'tr', 'li-group'), 'td', '', STATUS_NAMES[project.status]); cell.colSpan = 7; }
      const row = el(body, 'tr'); this.shareContextMenu(row, project.id, '项目'); this.projectDragHandle(el(row, 'td', 'li-project-handle-cell'), row, project, projects); const name = el(row, 'td'); action(name, project.title, () => safe(() => this.navigate(project.id)), 'li-project-title'); if (project.description) el(name, 'div', 'li-muted li-truncate', project.description.split('\n')[0]);
      const issues = this.data.issues.filter(i => i.projectId === project.id); const done = issues.filter(i => i.status === 'closed').length; const percent = issues.length ? Math.round(done / issues.length * 100) : 0;
      const progressCell = el(row, 'td'); const progress = el(progressCell, 'progress'); progress.max = 100; progress.value = percent; progress.setAttribute('aria-label', `${project.title} 完成 ${percent}%`); el(progressCell, 'span', 'li-muted', ` ${percent}%`);
      el(row, 'td', '', `${done}/${issues.length}`); pill(el(row, 'td'), project.status); el(row, 'td', 'li-muted', project.dueDate || '—'); action(el(row, 'td'), '编辑', () => this.projectModal(project), 'li-subtle');
    }
    this.hideColumns(table, ['', '', 'progress', 'count', 'status', 'due', ''], this.projectFields);
    if (!projects.length) el(root, 'p', 'li-empty', archived.length ? '没有进行中的项目，已归档的在下方。' : '没有匹配的项目。');
    this.renderArchived(root, archived);
  }
  /** Archived projects leave the working list; they live in one collapsible strip with revive and delete. */
  private renderArchived(root: HTMLElement, projects: Project[]) {
    if (!projects.length) return;
    const box = el(root, 'details', 'li-archived');
    box.open = this.state === 'archived';
    el(box, 'summary', '', `已归档 · ${projects.length} 个项目`);
    for (const project of projects) {
      const row = el(box, 'div', 'li-archived-row');
      const info = el(row, 'div', 'li-archived-info');
      action(info, project.title, () => safe(() => this.navigate(project.id)), 'li-project-title');
      const issues = this.data.issues.filter(i => i.projectId === project.id);
      el(info, 'span', 'li-muted', `${issues.filter(i => i.status !== 'closed').length} 个开启 · ${issues.length} 个议题`);
      const actions = el(row, 'div', 'li-archived-actions');
      action(actions, '启用', () => safe(async () => {
        await this.host.store.updateProject(project.id, { status: 'active' }, project.revision ?? project.updatedAt);
        new Notice(`已启用「${project.title}」`);
        await this.draw();
      }), 'li-subtle', 'rotate-ccw');
      action(actions, '删除', () => this.deleteProject(project), 'li-subtle', 'trash-2');
    }
  }
  private deleteProject(project: Project) {
    const issues = this.data.issues.filter(i => i.projectId === project.id);
    const modal = this.modal(`删除项目「${project.title}」？`);
    modal.modalEl.addClass('li-delete-dialog');
    el(modal.contentEl, 'p', 'li-muted', `项目里的 ${issues.length} 条议题、评论和附件会一起移入系统废纸篓，可以从回收站找回。笔记本体不会被改写。`);
    const status = el(modal.contentEl, 'p', 'li-delete-status'); status.setAttribute('role', 'status');
    const buttons = el(modal.modalEl, 'div', 'li-modal-actions');
    const cancel = action(buttons, '取消', () => modal.close());
    const confirm = action(buttons, '移入废纸篓', () => safe(async () => {
      if (confirm.disabled) return;
      confirm.disabled = true; cancel.disabled = true; confirm.textContent = '正在删除…'; status.removeClass('is-error'); status.textContent = '正在把项目移入废纸篓…';
      try { await this.host.store.deleteProject(project.id, true); }
      catch (error) {
        status.addClass('is-error'); status.textContent = `删除失败：${error instanceof Error ? error.message : String(error)}`;
        confirm.disabled = false; cancel.disabled = false; confirm.textContent = '重试删除';
        return;
      }
      modal.close(); new Notice(`项目「${project.title}」已移入废纸篓`);
      if (this.projectId === project.id) await this.navigate(); else await this.draw();
    }), 'mod-warning');
    modal.open(); cancel.focus();
  }

  private renderProject(root: HTMLElement, project: Project) {
    const head = this.phone ? undefined : el(root, 'div', 'li-heading'); if (head) { this.shareContextMenu(head, project.id, '项目'); el(head, 'h2', '', project.title); pill(head, project.status); }
    const actions = this.phone?.actions || el(head!, 'div', 'li-heading-actions');
    this.moreButton(actions, [
      ['编辑项目', () => this.projectModal(project)],
      ['打开笔记', () => safe(() => this.host.openNote(project.path))],
      ['分享给 Agent', () => safe(async () => { await navigator.clipboard.writeText(await this.host.resourceLink(project.id)); new Notice('已复制项目链接'); })],
      ['复制 Issues 列表链接', () => safe(async () => {
        const url = new URL(await this.host.resourceLink(project.id, 'issues'));
        if (this.mode !== 'board') url.searchParams.set('state', this.issueState);
        if (this.query) url.searchParams.set('search', this.query);
        if (this.label) url.searchParams.set('label', this.label);
        if (this.milestone) url.searchParams.set('milestone', this.milestone);
        await navigator.clipboard.writeText(decodeURI(url.toString())); new Notice('已复制 Issues 列表链接');
      })],
    ], '项目更多操作');
    const create = action(actions, this.phone ? '新建' : '新建 Issue', () => this.issueModal(project), 'mod-cta', 'plus'); create.setAttribute('aria-label', '新建 Issue');
    const all = this.data.issues.filter(i => i.projectId === project.id); const labels = [...new Set(all.flatMap(i => i.labels))].sort(); const milestones = [...new Set(all.map(i => i.milestone).filter(Boolean))].sort();
    if (this.phone) {
      this.mobileSearch('搜索 Issues', project);
      if (project.description) { const about = el(root, 'details', 'li-mobile-about'); el(about, 'summary', '', '项目说明'); this.markdown(about, project.description, project.path); }
    } else {
      if (project.description) this.markdown(root, project.description, project.path);
      const tabs = el(root, 'div', 'li-tabs'); for (const [mode, title, icon] of [['list', 'Issues', 'circle-dot'], ['board', '看板', 'columns-3'], ['table', '表格', 'table']] as const) action(tabs, title, () => { this.mode = mode; safe(() => this.draw()); }, this.mode === mode ? 'li-tab is-active' : 'li-tab', icon);
      const searchRow = el(root, 'div', 'li-search-row'); const search = input(searchRow, '搜索标题、描述、评论 · label:标签 state:open', this.query); search.setAttribute('aria-label', '搜索 Issues'); search.addEventListener('change', () => { this.query = search.value; safe(() => this.draw()); }); search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.query = search.value; safe(() => this.draw()); } });
      const filters = el(root, 'details', 'li-advanced-filters'); filters.open = !!(this.label || this.milestone);
      el(filters, 'summary', '', `更多筛选${this.label || this.milestone ? ' · 已启用' : ''}`);
      const filterFields = el(filters, 'div', 'li-filter-grid');
      select(this.field(filterFields, '标签'), [['', '所有标签'], ...labels.map(s => [s, s] as [string, string])], this.label, value => { this.label = value; safe(() => this.draw()); });
      select(this.field(filterFields, '里程碑'), [['', '所有里程碑'], ...milestones.map(s => [s, s] as [string, string])], this.milestone, value => { this.milestone = value; safe(() => this.draw()); });
      const tools = el(root, 'div', 'li-toolbar');
      select(tools, [['updated', '最近更新'], ['created', '最早创建'], ['title', '标题'], ['due', '截止日期']], this.sort, value => { this.sort = value; safe(() => this.draw()); });
      select(tools, [['', '不分组'], ['status', '按状态'], ['milestone', '按里程碑'], ['label', '按标签']], this.group, value => { this.group = value; safe(() => this.draw()); });
      this.fieldsButton(tools, this.issueFields, [['status', '状态'], ['labels', '标签'], ['milestone', '里程碑'], ['assignees', '负责人'], ['due', '截止日期']]);
    }
    const matching = all.filter(i => this.matches(i));
    const filtered = matching.filter(i => this.mode === 'board' || (this.issueState === 'closed' ? i.status === 'closed' : i.status !== 'closed')).sort((a, b) => this.sort === 'title' ? a.title.localeCompare(b.title) : this.sort === 'created' ? a.createdAt.localeCompare(b.createdAt) : this.sort === 'due' ? (a.dueDate || '9999').localeCompare(b.dueDate || '9999') : b.updatedAt.localeCompare(a.updatedAt));
    if (this.mode !== 'board') {
      const states = el(this.phone?.controls || root, 'div', 'li-state-tabs'); states.setAttribute('aria-label', 'Issue 状态');
      for (const [state, label] of [['open', '开启'], ['closed', '已关闭']] as const) {
        const count = matching.filter(i => state === 'closed' ? i.status === 'closed' : i.status !== 'closed').length;
        const button = action(states, `${count} 个${label}`, () => { this.issueState = state; this.selected.clear(); safe(() => this.draw()); }, `li-state-tab${this.issueState === state ? ' is-active' : ''}`);
        prependIcon(button, state === 'open' ? 'circle-dot' : 'circle-check');
        button.setAttribute('aria-pressed', String(this.issueState === state));
      }
    }

    if (this.mode !== 'board') this.renderBatch(root, filtered, milestones, labels);
    else this.selected.clear();
    if (!filtered.length) { const empty = el(root, 'div', 'li-empty'); el(empty, 'h3', '', !all.length ? '这个项目还没有 Issues' : this.issueState === 'closed' && !matching.some(i => i.status === 'closed') ? '没有已关闭的 Issues' : this.issueState === 'open' && !matching.some(i => i.status !== 'closed') ? '没有开启的 Issues' : '没有匹配的 Issues'); action(empty, '新建 Issue', () => this.issueModal(project), 'mod-cta', 'plus'); return; }
    if (this.mode === 'board') { const board = el(root, 'div', 'li-board'); for (const status of ISSUE_STATUSES) { const column = el(board, 'section', 'li-board-column'); const issues = filtered.filter(i => i.status === status); const header = el(column, 'div', 'li-board-header'); pill(header, status); el(header, 'span', 'li-muted', String(issues.length)); const add = action(header, '', () => this.issueModal(project, undefined, { status }), 'li-subtle li-icon-button', 'plus'); add.setAttribute('aria-label', `新建${STATUS_NAMES[status]} Issue`); add.title = `新建${STATUS_NAMES[status]} Issue`; column.addEventListener('dragover', event => { event.preventDefault(); column.addClass('is-dragover'); }); column.addEventListener('dragleave', () => column.removeClass('is-dragover')); column.addEventListener('drop', event => { event.preventDefault(); column.removeClass('is-dragover'); const id = event.dataTransfer?.getData('text/local-issues'); if (id) safe(async () => { await this.host.store.updateIssue(id, { status, actor: this.host.author }); await this.draw(); }); }); for (const issue of issues) this.issueCard(column, issue, true); } return; }
    const groups = new Map<string, Issue[]>(); for (const issue of filtered) { const key = this.group === 'status' ? STATUS_NAMES[issue.status] : this.group === 'milestone' ? issue.milestone || '无里程碑' : this.group === 'label' ? issue.labels[0] || '无标签' : ''; groups.set(key, [...(groups.get(key) || []), issue]); }
    for (const [name, issues] of groups) { if (name) el(root, 'h3', 'li-section-heading', `${name} · ${issues.length}`); if (this.mode === 'table') { const table = el(root, 'table', 'li-table li-issues-table'); const th = el(el(table, 'thead'), 'tr'); for (const name of ['', 'Issue', '状态', '标签', '里程碑', '负责人', '截止']) el(th, 'th', '', name); const body = el(table, 'tbody'); for (const issue of issues) { const row = el(body, 'tr'); this.tapCard(row, () => this.navigate(project.id, issue.id)); this.shareContextMenu(row, issue.id, '议题'); this.checkbox(el(row, 'td'), issue); action(el(row, 'td'), `#${issue.number} ${issue.title}`, () => safe(() => this.navigate(project.id, issue.id)), 'li-issue-title'); pill(el(row, 'td'), issue.status, issue.closeReason); el(row, 'td', '', issue.labels.join('、') || '—'); el(row, 'td', '', issue.milestone || '—'); el(row, 'td', '', issue.assignees.join('、') || '—'); el(row, 'td', '', issue.dueDate || '—'); } this.hideColumns(table, ['', '', 'status', 'labels', 'milestone', 'assignees', 'due'], this.issueFields); } else { const list = el(root, 'div', 'li-issue-list'); for (const issue of issues) this.issueCard(list, issue); } }
  }
  private renderBatch(root: HTMLElement, issues: Issue[], milestones: string[], labels: string[]) {
    const visible = new Set(issues.map(issue => issue.id));
    this.selected = new Set([...this.selected].filter(id => visible.has(id)));
    if (!issues.length) { if (this.batchFeedback) el(root, 'p', 'li-batch-feedback', this.batchFeedback).setAttribute('role', 'status'); return; }
    const bar = el(root, 'div', 'li-batch');
    const selectLabel = el(bar, 'label', 'li-select-all');
    const check = el(selectLabel, 'input'); check.type = 'checkbox';
    check.checked = this.selected.size === issues.length; check.indeterminate = this.selected.size > 0 && !check.checked;
    check.setAttribute('aria-label', '全选当前结果');
    el(selectLabel, 'span', '', this.selected.size ? `已选择 ${this.selected.size} 项` : `全选 ${issues.length} 项`);
    check.addEventListener('change', () => { this.selected = check.checked ? new Set(visible) : new Set(); this.batchFeedback = ''; safe(() => this.draw()); });
    if (this.selected.size) {
      select(bar, [['', '修改状态…'], ...stateOptions], '', value => { if (value) safe(() => this.updateSelected(() => statePatch(value))); });
      const editLabels = (remove = false) => this.textModal(remove ? '批量移除标签' : '批量添加标签', '', async value => {
        const values = words(value); if (!values.length) throw new Error('请输入标签');
        await this.updateSelected(issue => ({ labels: remove ? issue.labels.filter(label => !values.includes(label)) : [...new Set([...issue.labels, ...values])] }));
      }, { label: '标签', placeholder: '多个标签用逗号分隔', suggestions: labels, hint: `应用到选中的 ${this.selected.size} 个 Issue，其他标签保留。` });
      action(bar, '添加标签', () => editLabels());
      action(bar, '移除标签', () => editLabels(true));
      action(bar, '设置里程碑', () => this.textModal('批量设置里程碑', '', async value => {
        await this.updateSelected(() => ({ milestone: value.trim() }));
      }, { label: '里程碑', placeholder: '选择已有或输入新里程碑', suggestions: milestones, hint: `应用到选中的 ${this.selected.size} 个 Issue；留空可清除里程碑。` }));
      action(bar, '取消选择', () => { this.selected.clear(); this.batchFeedback = ''; safe(() => this.draw()); }, 'li-subtle');
    }
    if (this.batchFeedback) el(root, 'p', 'li-batch-feedback', this.batchFeedback).setAttribute('role', 'status');
  }
  private async updateSelected(patch: (issue: Issue) => IssuePatch) {
    if (this.batching) return;
    const issues = this.data.issues.filter(issue => this.selected.has(issue.id));
    if (!issues.length) return;
    this.batching = true;
    const bar = this.contentEl.querySelector('.li-batch');
    bar?.setAttribute('aria-busy', 'true');
    for (const checkbox of this.contentEl.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) checkbox.disabled = true;
    for (const control of bar?.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select') || []) control.disabled = true;
    const progress = bar instanceof HTMLElement ? el(bar, 'span', 'li-muted', `正在更新 0/${issues.length}…`) : undefined;
    progress?.setAttribute('role', 'status');
    const failed = new Set<string>(); const errors: string[] = [];
    try {
      for (const [index, issue] of issues.entries()) {
        try { await this.host.store.updateIssue(issue.id, { ...patch(issue), actor: this.host.author }, issue.revision ?? issue.updatedAt); }
        catch (error) { failed.add(issue.id); errors.push(`#${issue.number}：${error instanceof Error ? error.message : String(error)}`); }
        if (progress) progress.textContent = `正在更新 ${index + 1}/${issues.length}…`;
      }
      this.selected = failed;
      this.batchFeedback = errors.length ? `已更新 ${issues.length - failed.size} 项，${failed.size} 项失败，已保留选择。${errors.slice(0, 3).join('；')}` : `已更新 ${issues.length} 项`;
      new Notice(this.batchFeedback);
    } finally { this.batching = false; await this.draw(); }
  }
  private tapCard(card: HTMLElement, open: () => Promise<unknown>) {
    if (!Platform.isMobile) return;
    card.addClass('li-tappable');
    card.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : undefined;
      if (target?.closest('button,a,input,select,textarea,label,summary,[contenteditable="true"]')) return;
      const selection = card.ownerDocument.defaultView?.getSelection();
      if (selection && !selection.isCollapsed && card.contains(selection.anchorNode)) return;
      safe(open);
    });
  }
  private shareContextMenu(target: HTMLElement, ref: string, kind: string) {
    if (Platform.isMobile) return;
    target.addEventListener('contextmenu', event => { event.preventDefault(); const menu = new Menu(); menu.addItem(item => item.setTitle('分享给 Agent').onClick(() => safe(async () => { await navigator.clipboard.writeText(await this.host.resourceLink(ref)); new Notice(`已复制${kind}链接`); }))); menu.showAtMouseEvent(event); });
  }
  private moreButton(parent: HTMLElement, options: [string, () => void][], label: string) {
    if (Platform.isMobile) options = options.filter(([title]) => !title.includes('分享') && !title.startsWith('复制'));
    const button = action(parent, '更多', () => undefined, 'li-subtle li-more', 'ellipsis'); button.setAttribute('aria-label', label);
    button.addEventListener('click', event => { const menu = new Menu(); for (const [title, run] of options) menu.addItem(item => { const icon = ({ '打开笔记': 'file-text', '编辑项目': 'pencil', '复制双链': 'link', '分享给 Agent': 'share-2', '复制 Issues 列表链接': 'link', '移动议题': 'folder-input', '删除议题': 'trash-2' } as Record<string, string>)[title]; item.setTitle(title).onClick(run); if (icon) item.setIcon(icon); }); menu.showAtMouseEvent(event); });
  }
  private fieldsButton(parent: HTMLElement, fields: Set<string>, options: [string, string][]) { const button = action(parent, '字段', () => undefined, '', 'columns-3'); button.addEventListener('click', event => { const menu = new Menu(); for (const [key, name] of options) menu.addItem(item => item.setTitle(name).setChecked(fields.has(key)).onClick(() => { fields.has(key) ? fields.delete(key) : fields.add(key); safe(() => this.draw()); })); menu.showAtMouseEvent(event); }); }
  private hideColumns(table: HTMLTableElement, keys: string[], fields: Set<string>) { for (const row of table.rows) { if (row.cells.length === 1 && row.cells[0].colSpan > 1) continue; for (let i = 0; i < row.cells.length; i++) row.cells[i].hidden = !!keys[i] && !fields.has(keys[i]); } }
  private matches(issue: Issue) {
    if (this.label && !issue.labels.includes(this.label)) return false; if (this.milestone && issue.milestone !== this.milestone) return false;
    const text = `${issue.title} ${issue.body} ${issue.labels.join(' ')} ${issue.number} ${this.data.timeline.filter(e => e.issueId === issue.id && e.kind === 'comment').map(e => e.body).join(' ')}`.toLowerCase();
    return this.query.match(/(?:[^\s"]+|"[^"]*")+/g)?.every(token => { const [key, ...parts] = token.split(':'); const value = parts.join(':').replace(/^"|"$/g, ''); if (key === 'state' || key === 'is') return value === 'open' ? issue.status !== 'closed' : value === 'closed' ? issue.status === 'closed' : issue.status === value; if (key === 'label') return issue.labels.some(l => l.toLowerCase() === value.toLowerCase()); if (key === 'milestone') return issue.milestone.toLowerCase() === value.toLowerCase(); if (key === 'assignee') return issue.assignees.some(a => a.toLowerCase() === value.toLowerCase()); return text.includes(token.replace(/^"|"$/g, '').toLowerCase()); }) ?? true;
  }
  private checkbox(parent: HTMLElement, issue: Issue) { const target = Platform.isMobile ? el(parent, 'label', 'li-touch-checkbox') : parent; const checkbox = el(target, 'input'); checkbox.type = 'checkbox'; checkbox.checked = this.selected.has(issue.id); checkbox.setAttribute('aria-label', `选择 #${issue.number}`); checkbox.addEventListener('change', () => { checkbox.checked ? this.selected.add(issue.id) : this.selected.delete(issue.id); safe(() => this.draw()); }); }
  private issueCard(parent: HTMLElement, issue: Issue, board = false) { const card = el(parent, 'div', board ? 'li-card' : 'li-issue-row'); this.tapCard(card, () => this.navigate(issue.projectId, issue.id)); this.shareContextMenu(card, issue.id, '议题'); if (board && !Platform.isMobile) { card.draggable = true; card.addEventListener('dragstart', event => event.dataTransfer?.setData('text/local-issues', issue.id)); } else if (!board) this.checkbox(card, issue); const content = el(card, 'div', 'li-issue-content'); const title = el(content, 'div', 'li-issue-title-row'); if (!board) pill(title, issue.status, issue.closeReason); action(title, issue.title, () => safe(() => this.navigate(issue.projectId, issue.id)), 'li-issue-title'); for (const label of issue.labels) el(title, 'span', 'li-label', label); const meta = el(content, 'div', 'li-muted li-issue-meta'); el(meta, 'span', '', `#${issue.number} · ${issue.author} · ${date(issue.updatedAt)}`); if (issue.milestone) { const milestone = el(meta, 'span', '', issue.milestone); prependIcon(milestone, 'milestone'); milestone.title = `里程碑：${issue.milestone}`; milestone.setAttribute('aria-label', milestone.title); } const comments = this.data.timeline.filter(e => e.issueId === issue.id && e.kind === 'comment').length; if (comments) { const count = el(meta, 'span', '', String(comments)); prependIcon(count, 'message-square'); count.title = `${comments} 条评论`; count.setAttribute('aria-label', count.title); } if (board) select(card, stateOptions, stateValue(issue), value => safe(async () => { await this.host.store.updateIssue(issue.id, { ...statePatch(value), actor: this.host.author }); await this.draw(); })); }
  private renderIssue(root: HTMLElement, issue: Issue) {
    const project = this.data.projects.find(p => p.id === issue.projectId)!;
    const header = el(root, 'div', 'li-detail-header'); this.shareContextMenu(header, issue.id, '议题'); const title = el(header, 'div', 'li-detail-title');
    const showTitle = () => { title.replaceChildren(); el(title, 'h1', '', issue.title); el(title, 'span', 'li-muted', `#${issue.number}`); const button = action(title, '编辑标题', () => safe(() => this.afterEditing(() => {
      title.replaceChildren();
      const field = input(title, '议题标题', issue.title); field.setAttribute('aria-label', '议题标题'); field.dataset.editor = 'true';
      const controls = el(title, 'div', 'li-inline-actions'); action(controls, '取消', () => { this.stopEditing(true); if (this.pending) safe(() => this.draw()); });
      const draft = this.cacheForm(title, `issue-title:${issue.id}`, issue.revision ?? issue.updatedAt);
      this.startEditing(title, '议题标题', () => field.value !== issue.title, showTitle);
      const save = action(controls, '保存', () => safe(async () => { if (!field.value.trim()) throw new Error('请输入 Issue 标题'); save.disabled = true; try { const submitted = draft.snapshot(); await this.host.store.updateIssue(issue.id, { title: field.value.trim(), actor: this.host.author }, draft.revision); draft.complete(submitted); this.stopEditing(); await this.draw(); } finally { save.disabled = false; } }), 'mod-cta'); field.focus();
    })), 'li-subtle'); button.setAttribute('aria-label', '编辑标题'); }; showTitle();
    const controls = this.phone?.actions || el(header, 'div', 'li-detail-actions');
    this.moreButton(controls, [
      ['打开笔记', () => safe(() => this.host.openNote(issue.path))],
      ['复制双链', () => safe(async () => { await navigator.clipboard.writeText(issueLink(issue)); new Notice('已复制双链'); })],
      ['分享给 Agent', () => safe(async () => { await navigator.clipboard.writeText(await this.host.resourceLink(issue.id)); new Notice('已复制议题链接'); })],
      ['移动议题', () => safe(() => this.afterEditing(() => this.moveIssue(issue)))],
      ['删除议题', () => safe(() => this.afterEditing(() => this.deleteIssue(issue)))],
    ], 'Issue 更多操作');
    const summary = el(root, 'div', 'li-issue-summary'); pill(summary, issue.status, issue.closeReason); el(summary, 'span', 'li-muted', `${issue.author} 创建于 ${date(issue.createdAt)} · ${this.data.timeline.filter(e => e.issueId === issue.id && e.kind === 'comment').length} 条评论`);
    const detail = el(root, 'div', 'li-detail'); const main = el(detail, 'div', 'li-detail-main');
    if (!Platform.isMobile) this.sidebarResizer(detail);
    let sidebar: HTMLElement;
    if (Platform.isMobile) {
      const properties = el(detail, 'details', 'li-mobile-properties'); properties.open = this.mobilePropertiesOpen;
      el(properties, 'summary', '', '属性与关联'); sidebar = el(properties, 'aside', 'li-sidebar');
      properties.addEventListener('toggle', () => {
        if (!properties.open && this.activeEdit && properties.contains(this.activeEdit.element)) {
          properties.open = true;
          safe(() => this.afterEditing(() => { this.mobilePropertiesOpen = false; properties.open = false; }));
        } else this.mobilePropertiesOpen = properties.open;
      });
    } else sidebar = el(detail, 'aside', 'li-sidebar');
    const description = el(main, 'article', 'li-comment li-description'); const descriptionHead = el(description, 'div', 'li-comment-header'); el(descriptionHead, 'strong', '', issue.author); el(descriptionHead, 'span', 'li-muted', '描述'); el(descriptionHead, 'div', 'li-spacer');
    const content = el(description, 'div', 'li-description-content'); this.markdown(content, issue.body, issue.path);
    const edit = action(descriptionHead, '编辑', () => safe(() => this.afterEditing(() => {
      edit.hidden = true; content.replaceChildren(); const text = this.editor(content, issue.body, issue.id, issue.path); const buttons = text.actions; const draft = this.cacheForm(text.element, `issue-body:${issue.id}`, issue.revision ?? issue.updatedAt);
      this.startEditing(text.element, '议题描述', () => text.value !== issue.body || text.uploading, () => { text.destroy(); content.replaceChildren(); this.markdown(content, issue.body, issue.path); edit.hidden = false; });
      action(buttons, '取消', () => { this.stopEditing(true); if (this.pending) safe(() => this.draw()); });
      const save = action(buttons, '保存', () => safe(async () => { if (text.uploading) throw new Error('附件正在保存，请稍后保存'); save.disabled = true; try { const submitted = draft.snapshot(); await this.host.store.updateIssue(issue.id, { body: text.value, actor: this.host.author }, draft.revision); draft.complete(submitted); this.stopEditing(); await this.draw(); } finally { save.disabled = false; } }), 'mod-cta'); text.focus();
    })), 'li-subtle');
    const children = this.data.issues.filter(i => i.parent === issue.id); if (children.length) { const section = el(main, 'section', 'li-relations'); el(section, 'h3', '', `子议题 · ${children.filter(i => i.status === 'closed').length}/${children.length}`); for (const child of children) { const row = el(section, 'div', 'li-relation'); pill(row, child.status, child.closeReason); action(row, `#${child.number} ${child.title}`, () => safe(() => this.navigate(child.projectId, child.id)), 'li-subtle'); } }
    action(main, '添加子议题', () => this.issueModal(project, undefined, { parent: issue.id }), 'li-subtle', 'plus');
    const timeline = el(main, 'div', 'li-timeline'); const entries = this.data.timeline.filter(e => e.issueId === issue.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const entry of entries) { if (entry.kind === 'event') { const event = el(timeline, 'div', 'li-event'); pill(event, entry.to || 'open'); el(event, 'span', '', `${entry.author} ${entry.body}`); el(event, 'span', 'li-muted', date(entry.createdAt)); } else { const comment = el(timeline, 'article', 'li-comment'); comment.dataset.commentId = entry.id; const head = el(comment, 'div', 'li-comment-header'); el(head, 'strong', '', entry.author); el(head, 'span', 'li-muted', `${date(entry.createdAt)}${entry.updatedAt !== entry.createdAt ? ' · 已编辑' : ''}`); el(head, 'div', 'li-spacer'); const content = el(comment, 'div', 'li-description-content'); const edit = action(head, '编辑', () => safe(() => this.afterEditing(() => { edit.hidden = true; content.replaceChildren(); const text = this.editor(content, entry.body, issue.id, entry.path); const buttons = text.actions; const draft = this.cacheForm(text.element, `comment:${entry.id}`, entry.revision ?? entry.updatedAt); this.startEditing(text.element, `评论 · ${entry.author} · ${date(entry.createdAt)} · ${entry.body.replace(/\s+/g, ' ').slice(0, 40)}`, () => text.value !== entry.body || text.uploading, () => { text.destroy(); content.replaceChildren(); this.markdown(content, entry.body, entry.path); edit.hidden = false; }); action(buttons, '取消', () => { this.stopEditing(true); if (this.pending) safe(() => this.draw()); }); const save = action(buttons, '保存', () => safe(async () => { if (!text.value.trim()) throw new Error('评论不能为空'); if (text.uploading) throw new Error('附件正在保存，请稍后保存'); save.disabled = true; try { const submitted = draft.snapshot(); await this.host.store.editComment(entry.id, text.value, draft.revision); draft.complete(submitted); this.stopEditing(); await this.draw(); } finally { save.disabled = false; } }), 'mod-cta'); text.focus(); })), 'li-subtle'); action(head, '笔记', () => safe(() => this.host.openNote(entry.path)), 'li-subtle'); action(head, '删除', () => this.deleteComment(comment, entry), 'li-subtle li-delete-comment'); this.markdown(content, entry.body, entry.path); } }
    const compose = () => {
      const composer = el(main, 'section', 'li-composer'); el(composer, 'h3', '', '发表评论'); const editor = this.editor(composer, this.drafts.get(issue.id) || '', issue.id, issue.path, value => this.drafts.set(issue.id, value)); const status = el(editor.element, 'div', 'li-composer-status'); status.setAttribute('role', 'status'); const footer = editor.actions;
      if (!this.phone) {
        let closeReason: CloseReason = 'completed'; if (issue.status !== 'closed') select(footer, Object.entries(CLOSE_REASON_NAMES) as [string, string][], closeReason, value => { closeReason = value as CloseReason; }).setAttribute('aria-label', '关闭原因');
        const close = action(footer, issue.status === 'closed' ? '重新打开 Issue' : '关闭 Issue', () => safe(() => this.afterEditing(async () => { close.disabled = true; try { await this.host.store.updateIssue(issue.id, { status: issue.status === 'closed' ? 'open' : 'closed', ...(issue.status !== 'closed' ? { closeReason } : {}), actor: this.host.author }, issue.revision ?? issue.updatedAt); await this.draw(); } finally { close.disabled = false; } })), '', issue.status === 'closed' ? 'circle-dot' : 'circle-check');
      }
      const draft = this.cacheForm(editor.element, `new-comment:${issue.id}`);
      const send = async () => {
        if (this.submittingComment) return;
        const feedback = (message: string) => { status.textContent = message; new Notice(message); };
        if (!editor.value.trim()) { feedback('请输入评论内容'); return; }
        if (editor.uploading) { feedback('附件正在保存，请稍后发表评论'); return; }
        this.submittingComment = true; submit.disabled = true; submit.textContent = '正在发表…'; status.textContent = '正在发表评论…';
        try {
          const submitted = draft.snapshot(); await this.host.store.addComment(issue.id, editor.value, this.host.author); draft.complete(submitted);
          editor.clear(); this.drafts.delete(issue.id); this.submittingComment = false; this.stopEditing();
          await this.draw(); new Notice('评论已发表');
        } catch (error) { status.textContent = `发表失败：${error instanceof Error ? error.message : String(error)}`; throw error; }
        finally { this.submittingComment = false; this.submissionNotice?.hide(); this.submissionNotice = undefined; submit.disabled = false; submit.textContent = '发表评论'; }
      };
      const submit = action(footer, '发表评论', () => safe(() => this.phone ? send() : this.afterEditing(send)), 'mod-cta');
      if (this.phone) {
        action(footer, '取消', () => { this.stopEditing(true); if (this.pending) safe(() => this.draw()); });
        // Keep Cancel first in the phone navigation bar.
        footer.prepend(footer.lastElementChild!);
        this.startEditing(editor.element, '发表评论', () => !!editor.value.trim() || editor.uploading, () => { this.drafts.delete(issue.id); editor.destroy(); composer.remove(); });
        editor.focus();
      }
    };
    if (this.phone) action(this.phone.actions, this.drafts.get(issue.id) || this.draftCache.read(`new-comment:${issue.id}`) ? '继续评论' : '评论', () => safe(() => this.afterEditing(compose)), 'mod-cta'); else compose();
    el(sidebar, 'h3', '', '属性'); const stateField = this.field(sidebar, '状态'); select(stateField, stateOptions, stateValue(issue), value => { const stateSelect = stateField.querySelector('select')!; stateSelect.value = stateValue(issue); safe(() => this.afterEditing(async () => { await this.host.store.updateIssue(issue.id, { ...statePatch(value), actor: this.host.author }, issue.revision ?? issue.updatedAt); await this.draw(); })); });
    this.editableProperty(sidebar, issue, '标签', issue.labels.join('、'), (area, current) => {
      const field = this.listInput(area, '多个标签用逗号分隔', current.labels, this.data.issues.filter(i => i.projectId === issue.projectId).flatMap(i => i.labels));
      return () => ({ labels: words(field.value) });
    });
    this.editableProperty(sidebar, issue, '里程碑', issue.milestone, (area, current) => {
      const field = input(area, '选择已有或输入新里程碑', current.milestone);
      this.suggestValues(field, this.data.issues.filter(i => i.projectId === issue.projectId).map(i => i.milestone));
      return () => ({ milestone: field.value.trim() });
    });
    this.editableProperty(sidebar, issue, '负责人', issue.assignees.join('、'), (area, current) => {
      const field = this.listInput(area, '姓名，用逗号分隔', current.assignees, this.data.issues.flatMap(i => i.assignees));
      return () => ({ assignees: words(field.value) });
    });
    this.editableProperty(sidebar, issue, '截止日期', issue.dueDate, (area, current) => {
      const field = input(area, '截止日期', current.dueDate); field.type = 'date';
      return () => ({ dueDate: field.value });
    });
    const parent = this.data.issues.find(i => i.id === issue.parent);
    this.editableProperty(sidebar, issue, '父议题', parent ? `#${parent.number} ${parent.title}` : '', (area, current) => {
      const field = this.parentInput(area, issue.projectId, issue, current.parent);
      return () => ({ parent: field.value });
    }, parent);
    const depField = this.editableProperty(sidebar, issue, '依赖', issue.dependencies.length ? `${issue.dependencies.length} 个依赖` : '无依赖', (area, current) => {
      const chosen = new Set(current.dependencies);
      const chips = el(area, 'div', 'li-selected-dependencies');
      const search = input(area, '搜索依赖议题');
      const choices = el(area, 'div', 'li-issue-options');
      const render = () => {
        chips.replaceChildren();
        for (const id of chosen) {
          const dependency = this.data.issues.find(i => i.id === id);
          const chip = action(chips, dependency ? `#${dependency.number} ${dependency.title}` : id, () => { chosen.delete(id); render(); }, 'li-subtle li-dependency-chip');
          chip.setAttribute('aria-label', `移除依赖 ${dependency?.title || id}`);
        }
        this.issueChoices(choices, issue.projectId, issue.number, search.value, new Set([issue.id, ...chosen]), candidate => {
          chosen.add(candidate.id); render(); area.dispatchEvent(new area.ownerDocument.defaultView!.Event('change', { bubbles: true }));
        });
      };
      search.addEventListener('input', render); this.issueSearchKeys(search, choices); render();
      return () => ({ dependencies: [...chosen] });
    });
    if (issue.dependencies.length) {
      const links = el(depField, 'div', 'li-property-links');
      for (const id of issue.dependencies) {
        const dependency = this.data.issues.find(i => i.id === id);
        if (dependency) { const row = el(links, 'div', 'li-relation'); pill(row, dependency.status, dependency.closeReason); action(row, `#${dependency.number} ${dependency.title}`, () => safe(() => this.navigate(dependency.projectId, dependency.id)), 'li-subtle'); }
        else el(links, 'span', 'li-muted', id);
      }
    }
  }
  private issueChoices(container: HTMLElement, projectId: string, number: number, query: string, excluded: Set<string>, pick: (issue: Issue) => void, selected = '') {
    const foreignOpen = container.querySelector<HTMLDetailsElement>('.li-other-projects')?.open || false;
    container.replaceChildren();
    const candidates = issueOptions(this.data.issues, this.data.projects, projectId, number, query, excluded);
    const own = candidates.filter(issue => issue.projectId === projectId), other = candidates.filter(issue => issue.projectId !== projectId);
    const add = (list: HTMLElement, issue: Issue, foreign = false) => {
      const project = this.data.projects.find(project => project.id === issue.projectId);
      const option = action(list, '', () => pick(issue), 'li-dependency-option li-issue-option');
      option.dataset.issueId = issue.id; option.setAttribute('aria-description', STATUS_NAMES[issue.status]); option.setAttribute('aria-label', `${project?.title || ''} #${issue.number} ${issue.title}`);
      option.setAttribute('aria-pressed', String(issue.id === selected));
      pill(option, issue.status, issue.closeReason);
      const body = el(option, 'span', 'li-issue-option-body'); el(body, 'span', 'li-issue-option-title', `#${issue.number} ${issue.title}`);
      if (foreign) el(body, 'span', 'li-muted li-issue-option-project', project?.title || '');
    };
    if (own.length) {
      el(container, 'div', 'li-issue-options-label li-muted', `当前项目 · ${own.length}`);
      const list = el(container, 'div', 'li-issue-options-list'); for (const issue of own) add(list, issue);
    } else el(container, 'p', 'li-issue-options-empty li-muted', query.trim() ? '当前项目没有匹配的议题' : '当前项目没有可选议题');
    if (other.length) {
      const group = el(container, 'details', 'li-other-projects'); el(group, 'summary', '', `其他项目 · ${other.length}${query.trim() ? ' 条匹配' : ''}`);
      const list = el(group, 'div', 'li-issue-options-list');
      const populate = () => { if (group.open && !list.childElementCount) for (const issue of other) add(list, issue, true); };
      group.addEventListener('toggle', populate); group.open = foreignOpen; populate();
    }
  }
  private parentInput(parent: HTMLElement, projectId: string, issue: Issue | undefined, value: string) {
    const field = el(parent, 'input'); field.type = 'hidden'; field.value = value; field.setAttribute('aria-label', '父议题');
    const label = () => { const chosen = this.data.issues.find(issue => issue.id === field.value); return chosen ? `#${chosen.number} ${chosen.title}` : field.value || '无父议题'; };
    const button = action(parent, label(), () => {
      this.relationPicker?.close();
      const modal = this.relationPicker = this.modal('选择父议题'); modal.modalEl.addClass('li-issue-picker-modal');
      modal.onClose = () => { if (this.relationPicker === modal) this.relationPicker = undefined; };
      const search = input(modal.contentEl, '搜索标题、编号或项目'); search.type = 'search'; search.enterKeyHint = 'search'; search.setAttribute('aria-label', '搜索父议题');
      const choose = (id: string) => { field.value = id; field.dispatchEvent(new field.ownerDocument.defaultView!.Event('change', { bubbles: true })); modal.close(); button.focus(); };
      action(modal.contentEl, '无父议题', () => choose(''), 'li-subtle li-issue-picker-clear');
      const choices = el(modal.contentEl, 'div', 'li-issue-options');
      const number = issue?.number ?? Math.max(0, ...this.data.issues.filter(issue => issue.projectId === projectId).map(issue => issue.number)) + 1;
      const render = () => this.issueChoices(choices, projectId, number, search.value, new Set(issue ? [issue.id] : []), candidate => choose(candidate.id), field.value);
      search.addEventListener('input', render);
      this.issueSearchKeys(search, choices);
      action(el(modal.modalEl, 'div', 'li-modal-actions'), '取消', () => modal.close());
      render(); modal.open(); search.focus();
    }, 'li-parent-picker');
    button.setAttribute('aria-label', '选择父议题'); button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-description', label());
    field.addEventListener('change', () => { button.textContent = label(); button.setAttribute('aria-description', label()); });
    return field;
  }
  private issueSearchKeys(search: HTMLInputElement, choices: HTMLElement) {
    search.addEventListener('keydown', event => {
      if (event.isComposing || event.key !== 'Enter' && event.key !== 'ArrowDown') return;
      event.preventDefault(); event.stopPropagation();
      const first = [...choices.querySelectorAll<HTMLButtonElement>('.li-issue-options-list > button')].find(button => {
        const group = button.closest<HTMLDetailsElement>('.li-other-projects'); return !group || group.open;
      });
      if (event.key === 'Enter') first?.click(); else first?.focus();
    });
  }
  private listInput(parent: HTMLElement, placeholder: string, values: string[], options: string[]) {
    const field = input(parent, placeholder, values.join(', '));
    const choices = el(parent, 'div', 'li-property-choices');
    for (const value of [...new Set([...values, ...options])].sort()) {
      const button = action(choices, value, () => {
        const current = words(field.value);
        field.value = (current.includes(value) ? current.filter(item => item !== value) : [...current, value]).join(', ');
        update();
      }, 'li-subtle');
      button.setAttribute('aria-pressed', String(values.includes(value)));
    }
    const update = () => { for (const button of choices.querySelectorAll('button')) button.setAttribute('aria-pressed', String(words(field.value).includes(button.textContent || ''))); };
    field.addEventListener('input', update);
    return field;
  }
  private editableProperty(sidebar: HTMLElement, issue: Issue, name: string, value: string, build: (area: HTMLElement, current: Issue) => () => IssuePatch, linked?: Issue) {
    const field = this.field(sidebar, name);
    const display = el(field, 'div', 'li-property-display');
    if (linked) action(display, value, () => safe(() => this.navigate(linked.projectId, linked.id)), 'li-subtle li-property-link');
    const change = action(display, linked ? '修改' : value || '未设置', () => safe(() => this.afterEditing(() => {
      display.hidden = true;
      const area = el(field, 'div', 'li-property-editor');
      const key = `issue-field:${issue.id}:${name}`;
      const patch = this.draftCache.read(key)?.extra;
      const current = patch && typeof patch === 'object' ? { ...issue, ...patch } : issue;
      const read = build(area, current); const initial = JSON.stringify(read());
      const draft = this.cacheForm(area, key, issue.revision ?? issue.updatedAt, { read });
      const feedback = el(area, 'p', 'li-form-error'); feedback.setAttribute('role', 'alert');
      const controls = el(area, 'div', 'li-inline-actions');
      action(controls, '取消', () => { this.stopEditing(true); if (this.pending) safe(() => this.draw()); });
      const save = action(controls, '保存', () => safe(async () => {
        if (save.disabled) return;
        save.disabled = true; feedback.textContent = '';
        try {
          const submitted = draft.snapshot(); await this.host.store.updateIssue(issue.id, { ...read(), actor: this.host.author }, draft.revision); draft.complete(submitted);
          this.stopEditing(); await this.draw();
        } catch (error) { feedback.textContent = error instanceof Error ? error.message : String(error); }
        finally { save.disabled = false; }
      }), 'mod-cta');
      this.startEditing(area, `议题属性 · ${name}`, () => JSON.stringify(read()) !== initial, () => { area.remove(); display.hidden = false; });
      area.addEventListener('keydown', event => { if (event.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); this.stopEditing(true); change.focus(); } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) { event.preventDefault(); save.click(); } });
      (area.querySelector<HTMLElement>('input:not([type="hidden"]),select') || area.querySelector<HTMLElement>('.li-parent-picker'))?.focus();
    })), 'li-subtle li-property-value');
    change.setAttribute('aria-label', `修改${name}`);
    return field;
  }

  private moveIssue(issue: Issue) {
    const choices = this.data.projects.filter(project => project.id !== issue.projectId && project.status !== 'archived');
    const modal = this.modal('移动议题');
    if (!choices.length) { el(modal.contentEl, 'p', '', '请先创建另一个项目。'); action(modal.contentEl, '关闭', () => modal.close()); modal.open(); return; }
    el(modal.contentEl, 'p', 'li-muted', '正文、评论、附件和关联会保留，议题将在目标项目中获得新编号。');
    let target = choices[0].id;
    select(this.field(modal.contentEl, '目标项目'), choices.map(project => [project.id, project.title]), target, value => { target = value; });
    this.saveButton(modal, async () => {
      const moved = await this.host.store.moveIssue(issue.id, target, issue.revision ?? issue.updatedAt);
      modal.close(); await this.navigate(moved.projectId, moved.id); new Notice(`议题已移动为 #${moved.number}`);
    });
    modal.open();
  }
  private deleteIssue(issue: Issue) {
    const modal = this.modal(`删除议题 #${issue.number}？`); modal.modalEl.addClass('li-delete-dialog');
    el(modal.contentEl, 'p', '', issue.title);
    el(modal.contentEl, 'p', 'li-muted', '议题及其评论将从项目中移除，子议题和附件会保留。');
    const status = el(modal.contentEl, 'p', 'li-delete-status'); status.setAttribute('role', 'status');
    const buttons = el(modal.modalEl, 'div', 'li-modal-actions');
    const cancel = action(buttons, '取消', () => modal.close());
    const confirm = action(buttons, '确认删除', () => safe(async () => {
      if (confirm.disabled) return;
      confirm.disabled = true; cancel.disabled = true; status.textContent = '正在删除…'; status.removeClass('is-error');
      try { await this.host.store.deleteIssue(issue.id, issue.revision ?? issue.updatedAt); }
      catch (error) { status.addClass('is-error'); status.textContent = `删除失败：${error instanceof Error ? error.message : String(error)}`; confirm.disabled = false; cancel.disabled = false; return; }
      modal.close(); await this.navigate(issue.projectId); new Notice('议题已删除');
    }), 'mod-warning');
    modal.open(); cancel.focus();
  }
  private deleteComment(parent: HTMLElement, entry: TimelineEntry) {
    safe(() => this.afterEditing(() => {
      if (this.deletePrompt?.modalEl.isConnected) {
        this.deletePrompt.modalEl.querySelector<HTMLElement>('button')?.focus();
        return;
      }
      const modal = this.deletePrompt = this.modal('删除这条评论？');
      modal.modalEl.addClass('li-delete-dialog');
      modal.onClose = () => { if (this.deletePrompt === modal) this.deletePrompt = undefined; };
      el(modal.contentEl, 'p', 'li-muted', `${entry.author} · ${date(entry.createdAt)}`);
      el(modal.contentEl, 'p', 'li-delete-excerpt', entry.body.replace(/\s+/g, ' ').slice(0, 180));
      const status = el(modal.contentEl, 'p', 'li-delete-status'); status.setAttribute('role', 'status');
      const buttons = el(modal.modalEl, 'div', 'li-modal-actions');
      const cancel = action(buttons, '取消', () => modal.close());
      const confirm = action(buttons, '确认删除', () => safe(async () => {
        if (confirm.disabled) return;
        confirm.disabled = true; cancel.disabled = true; confirm.textContent = '正在删除…'; status.removeClass('is-error'); status.textContent = '正在删除评论…';
        try {
          await this.host.store.deleteComment(entry.id, entry.revision ?? entry.updatedAt);
        } catch (error) {
          status.addClass('is-error'); status.textContent = `删除失败：${error instanceof Error ? error.message : String(error)}`;
          if (!modal.modalEl.isConnected) new Notice(status.textContent, 0);
          confirm.disabled = false; cancel.disabled = false; confirm.textContent = '重试删除';
          return;
        }
        parent.remove();
        for (const card of this.contentEl.querySelectorAll<HTMLElement>('.li-comment')) if (card.dataset.commentId === entry.id) card.remove();
        modal.close(); new Notice('评论已删除');
        await this.draw();
      }), 'mod-warning');
      modal.open(); cancel.focus();
    }, true));
  }
  private field(parent: HTMLElement, label: string) {
    const field = el(parent, 'div', 'li-field'); const heading = el(field, 'label', '', label);
    const icon = ({ 状态: 'circle-dot', 标签: 'tags', 里程碑: 'milestone', 负责人: 'users', 截止日期: 'calendar', 父议题: 'git-branch', 依赖: 'link' } as Record<string, string>)[label];
    if (icon) prependIcon(heading, icon);
    return field;
  }
  private projectModal(project?: Project) {
    const modal = this.phone ? undefined : this.modal(project ? '编辑项目' : '新建项目');
    const form = modal?.contentEl || el(this.phone!.content, 'section', 'li-mobile-project-form');
    const title = input(this.field(form, '项目名称'), '项目名称', project?.title); title.required = true;
    const description = this.editor(this.field(form, '项目说明 · Markdown'), project?.description || '', project?.id || '', project?.path || '');
    if (modal) modal.onClose = () => description.destroy();
    let status: ProjectStatus = project?.status || 'active'; select(this.field(form, '状态'), PROJECT_STATES.map(s => [s, STATUS_NAMES[s]]), status, value => { status = value as ProjectStatus; }); const due = input(this.field(form, '截止日期'), '', project?.dueDate); due.type = 'date';
    const draft = this.cacheForm(form, project ? `project:${project.id}` : 'new-project', project?.revision ?? project?.updatedAt);
    const save = async () => {
      if (!title.value.trim()) throw new Error('请输入项目名称');
      if (description.uploading) throw new Error('附件正在保存，请稍后保存');
      const submitted = draft.snapshot();
      const data = { title: title.value.trim(), description: description.value, status, dueDate: due.value };
      const saved = project ? await this.host.store.updateProject(project.id, data, draft.revision) : await this.host.store.createProject(data);
      draft.complete(submitted); modal?.close(); if (this.phone) this.stopEditing(); await this.navigate(saved.id);
    };
    if (modal) { this.saveButton(modal, save); modal.open(); }
    else {
      const value = () => JSON.stringify([title.value, description.value, status, due.value]), initial = value();
      const feedback = el(form, 'p', 'li-form-error'); feedback.setAttribute('role', 'alert');
      const buttons = el(form, 'div', 'li-inline-actions');
      action(buttons, '取消', () => { this.stopEditing(true); if (this.pending) safe(() => this.draw()); });
      const submit = action(buttons, '保存', () => safe(async () => {
        submit.disabled = true; feedback.textContent = '';
        try { await save(); } catch (error) { feedback.textContent = error instanceof Error ? error.message : String(error); }
        finally { submit.disabled = false; }
      }), 'mod-cta');
      this.startEditing(form, project ? '编辑项目' : '新建项目', () => value() !== initial || description.uploading, () => { description.destroy(); form.remove(); });
    }
    title.focus();
  }
  private issueModal(project: Project, issue?: Issue, defaults: Partial<IssueInput> = {}, inline?: HTMLElement, restore?: () => void) {
    if (!issue && !inline) { safe(() => this.afterEditing(async () => { await this.leaf.setViewState({ type: VIEW_TYPE, state: { ...this.getState(), projectId: project.id, issueId: undefined, creating: { projectId: project.id, defaults } } }); })); return; }
    const modal = inline ? undefined : this.modal(`编辑 #${issue!.number}`);
    const frame = inline && !issue ? el(inline, 'div', 'li-create') : undefined;
    if (frame) { el(frame, 'h2', '', '创建新议题'); el(frame, 'p', 'li-muted li-create-hint', '记录问题、想法或需要完成的工作。'); }
    const form = frame ? el(frame, 'div', 'li-create-content') : inline || modal!.contentEl;
    const title = issue ? undefined : input(this.field(form, '标题'), '简洁描述这件事', defaults.title || ''); if (title) { title.required = true; title.dataset.editor = 'true'; }
    const body = issue ? undefined : this.editor(this.field(form, '描述'), defaults.body || '', project.id, project.path);
    const properties = el(form, 'details', 'li-properties'); properties.open = !!issue;
    const propertiesSummary = el(properties, 'summary'); el(propertiesSummary, 'span', '', '属性与关联');
    const overview = [
      issue && issue.status !== 'open' ? STATUS_NAMES[issue.status] : '',
      issue?.labels.length ? `${issue.labels.length} 个标签` : '',
      issue?.milestone ? `里程碑：${issue.milestone}` : '',
      issue?.assignees.length ? `${issue.assignees.length} 位负责人` : '',
      issue?.dueDate ? `截止 ${issue.dueDate}` : '',
      issue?.parent || defaults.parent ? '已设置父议题' : '',
      (issue?.dependencies || defaults.dependencies)?.length ? `${(issue?.dependencies || defaults.dependencies)!.length} 项依赖` : '',
    ].filter(Boolean);
    el(propertiesSummary, 'span', 'li-property-summary', overview.join(' · ') || '状态、标签、里程碑、依赖');
    const grid = el(properties, 'div', 'li-form-grid'); let currentState = stateValue({ status: issue?.status || defaults.status || 'open', closeReason: issue?.closeReason || defaults.closeReason }); select(this.field(grid, '状态'), stateOptions, currentState, value => { currentState = value; });
    const labels = input(this.field(grid, '标签'), '多个标签用逗号分隔', (issue?.labels || defaults.labels || []).join(', ')); const milestone = input(this.field(grid, '里程碑'), '例如：首次发布', issue?.milestone || defaults.milestone || ''); const assignees = input(this.field(grid, '负责人'), '姓名，用逗号分隔', (issue?.assignees || defaults.assignees || []).join(', ')); const due = input(this.field(grid, '截止日期'), '', issue?.dueDate || defaults.dueDate || ''); due.type = 'date';
    const parent = this.parentInput(this.field(grid, '父议题'), project.id, issue, issue?.parent || defaults.parent || '');
    const dependencies = new Set(issue?.dependencies || defaults.dependencies || []);
    const depField = this.field(properties, '依赖'); const selectedDeps = el(depField, 'div', 'li-selected-dependencies');
    const searchDeps = input(depField, '搜索标题、编号或项目'); searchDeps.setAttribute('aria-label', '搜索依赖议题');
    const suggestions = el(depField, 'div', 'li-dependency-suggestions'); suggestions.hidden = true;
    const renderSelected = () => { selectedDeps.replaceChildren(); for (const id of dependencies) { const candidate = this.data.issues.find(i => i.id === id); const chip = el(selectedDeps, 'span', 'li-dependency-chip'); el(chip, 'span', '', candidate ? `#${candidate.number} ${candidate.title}` : id); const remove = action(chip, '', () => { dependencies.delete(id); renderSelected(); renderSuggestions(); form.dispatchEvent(new form.ownerDocument.defaultView!.Event('change')); }, 'li-icon-button', 'x'); remove.setAttribute('aria-label', `移除依赖 ${candidate?.title || id}`); remove.title = `移除依赖 ${candidate?.title || id}`; } };
    const renderSuggestions = () => { suggestions.hidden = false; suggestions.addClass('li-issue-options'); this.issueChoices(suggestions, project.id, issue?.number ?? Math.max(0, ...this.data.issues.filter(issue => issue.projectId === project.id).map(issue => issue.number)) + 1, searchDeps.value, new Set([...(issue ? [issue.id] : []), ...dependencies]), candidate => { dependencies.add(candidate.id); searchDeps.value = ''; renderSelected(); renderSuggestions(); form.dispatchEvent(new form.ownerDocument.defaultView!.Event('change')); searchDeps.focus(); }); };
    searchDeps.addEventListener('input', renderSuggestions); searchDeps.addEventListener('focus', renderSuggestions); this.issueSearchKeys(searchDeps, suggestions); searchDeps.addEventListener('keydown', event => { if (!event.isComposing && event.key === 'Escape') suggestions.hidden = true; }); renderSelected();
    const draft = this.cacheForm(form, issue ? `issue-properties:${issue.id}` : `new-issue:${project.id}:${defaults.parent || ''}`, issue?.revision ?? issue?.updatedAt, {
      read: () => [...dependencies], restore: value => { if (Array.isArray(value) && value.every(v => typeof v === 'string')) { dependencies.clear(); value.forEach(v => dependencies.add(v)); renderSelected(); renderSuggestions(); } },
    });
    const saveIssue = async () => { if (!issue && !title?.value.trim()) throw new Error('请输入 Issue 标题'); if (form.querySelector('[data-uploading]')) throw new Error('附件正在保存，请稍后保存'); const submitted = draft.snapshot(); const patch: IssuePatch = { ...(!issue ? { title: title!.value.trim(), body: body!.value } : {}), ...statePatch(currentState), labels: words(labels.value), milestone: milestone.value.trim(), assignees: words(assignees.value), dueDate: due.value, parent: parent.value, dependencies: [...dependencies], actor: this.host.author }; const saved = issue ? await this.host.store.updateIssue(issue.id, patch, draft.revision) : await this.host.store.createIssue(project.id, { ...patch, author: this.host.author, title: title!.value.trim() }); draft.complete(submitted); modal?.close(); this.creating = undefined; this.stopEditing(); await this.navigate(project.id, saved.id); };
    const formValue = () => JSON.stringify({ fields: [...form.querySelectorAll('input,select')].map(field => (field as HTMLInputElement).value), body: body?.value, currentState, parent: parent.value, dependencies: [...dependencies] });
    const initialForm = formValue();
    if (inline) this.startEditing(frame || inline, issue ? '议题属性' : '新建议题', () => formValue() !== initialForm || !!body?.uploading, () => { body?.destroy(); this.creating = undefined; restore?.(); });
    if (frame) { const buttons = el(frame, 'div', 'li-inline-actions'); action(buttons, '取消', () => { this.stopEditing(true); safe(() => this.navigate(project.id)); }); const save = action(buttons, '创建议题', () => safe(async () => { save.disabled = true; try { await saveIssue(); } finally { save.disabled = false; } }), 'mod-cta'); }
    else if (inline) { const buttons = el(inline, 'div', 'li-inline-actions'); action(buttons, '取消', () => { this.stopEditing(true); safe(() => this.draw()); }); const save = action(buttons, '保存', () => safe(async () => { save.disabled = true; try { await saveIssue(); } finally { save.disabled = false; } }), 'mod-cta'); }
    else { this.saveButton(modal!, saveIssue); modal!.open(); } title?.focus();
  }
  private textModal(title: string, value: string, save: (value: string) => Promise<void>, options: { label?: string; placeholder?: string; hint?: string; suggestions?: string[] } = {}) {
    const modal = this.modal(title); modal.modalEl.addClass('li-text-dialog');
    const text = input(this.field(modal.contentEl, options.label || title), options.placeholder || title, value);
    if (options.suggestions?.length) this.suggestValues(text, options.suggestions);
    if (options.hint) el(modal.contentEl, 'p', 'li-muted li-dialog-hint', options.hint);
    const draft = this.cacheForm(modal.contentEl, `text:${this.projectId || 'repo'}:${title}`);
    this.saveButton(modal, async () => { const submitted = draft.snapshot(); await save(text.value); draft.complete(submitted); modal.close(); }); modal.open(); text.focus();
  }
  private suggestValues(control: HTMLInputElement, values: string[]) {
    const list = el(control.parentElement!, 'datalist'); list.id = `li-options-${++controlId}`; control.setAttribute('list', list.id);
    for (const value of [...new Set(values)].filter(Boolean).sort()) el(list, 'option').value = value;
  }
  private modal(title: string) { const modal = new MobileModal(this.app); this.bindMarkdownShortcuts(modal.scope); suppressTooltips(modal.modalEl); modal.modalEl.addClass('li-modal-container'); modal.contentEl.addClass('local-issues', 'li-modal'); modal.titleEl.setText(title); return modal; }
  private saveButton(modal: Modal, run: () => Promise<void>) { const buttons = el(modal.modalEl, 'div', 'li-modal-actions'); action(buttons, '取消', () => modal.close()); const feedback = el(modal.contentEl, 'p', 'li-form-error'); feedback.setAttribute('role', 'alert'); const save = action(buttons, '保存', () => safe(async () => { if (save.disabled) return; save.disabled = true; feedback.textContent = ''; try { if (modal.contentEl.querySelector('[data-uploading]')) throw new Error('附件正在保存，请稍后保存'); await run(); } catch (error) { feedback.textContent = error instanceof Error ? error.message : String(error); } finally { save.disabled = false; } }), 'mod-cta'); }
  private editor(parent: HTMLElement, initial: string, ref: string, sourcePath: string, changed?: (body: string) => void) {
    const container = el(parent, 'div', 'li-editor'); const tools = el(container, 'div', 'li-editor-toolbar');
    const tabs = el(tools, 'div', 'li-editor-tabs');
    const formatting = el(tools, 'div', 'li-editor-formatting'); formatting.setAttribute('role', 'toolbar'); formatting.setAttribute('aria-label', 'Markdown 格式');
    const liveContainer = el(container, 'div', 'li-live-editor');
    const preview = el(container, 'div', 'li-editor-preview markdown-rendered'); preview.hidden = true;
    const footer = el(container, 'div', 'li-editor-footer');
    let disposed = false, uploads = 0;
    const view = createLiveMarkdown(this.app, liveContainer, initial, sourcePath, value => { changed?.(value); container.dispatchEvent(new container.ownerDocument.defaultView!.Event('li-editor-change', { bubbles: true })); }, {
      onSubmit: () => { if (!uploads) (actions.querySelector<HTMLButtonElement>('.mod-cta') || container.closest('.li-create')?.querySelector<HTMLButtonElement>('.li-inline-actions .mod-cta') || container.closest('.modal')?.querySelector<HTMLButtonElement>('.li-modal-actions .mod-cta'))?.click(); },
      onAttach: () => { if (ref) picker.click(); else new Notice('请先创建项目，再添加附件'); },
    });
    this.shortcutEditors.set(liveContainer, view);
    const destroy = () => { if (!disposed) { disposed = true; view.destroy(); } };
    this.renderScope.register(destroy);
    const getValue = () => view.state.doc.toString();
    const focus = () => view.focus();
    const insert = (text: string) => { const { from, to } = view.state.selection.main; view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } }); focus(); };
    const write = action(tabs, '编写', () => { liveContainer.hidden = false; preview.hidden = true; write.addClass('is-active'); previewButton.removeClass('is-active'); focus(); });
    const previewButton = action(tabs, '预览', () => { liveContainer.hidden = true; preview.hidden = false; preview.replaceChildren(); safe(() => MarkdownRenderer.render(this.app, getValue() || '*暂无内容*', preview, sourcePath, this.renderScope)); write.removeClass('is-active'); previewButton.addClass('is-active'); });
    write.addClass('is-active');
    for (const [command, label, shortcut] of Platform.isMobile ? [] : MARKDOWN_TOOLS) {
      const button = action(formatting, label, () => { liveContainer.hidden = false; preview.hidden = true; write.addClass('is-active'); previewButton.removeClass('is-active'); view.command(command); });
      button.setAttribute('aria-label', shortcut && !Platform.isMobile ? `${label}（${shortcut}）` : label);
      if (shortcut) el(button, 'kbd', '', shortcut.replace('Cmd/Ctrl+', Platform.isMacOS ? '⌘' : 'Ctrl+'));
      button.addEventListener('mousedown', event => event.preventDefault());
      if (command === 'source') { const update = () => { button.setAttribute('aria-pressed', String(liveContainer.dataset.mode === 'source')); }; liveContainer.addEventListener('markdown-mode', update); update(); }
    }
    const picker = el(footer, 'input'); picker.type = 'file'; picker.multiple = true; picker.hidden = true; picker.setAttribute('aria-label', '选择附件');
    const uploadStatus = el(footer, 'span', 'li-upload-status li-muted'); uploadStatus.setAttribute('aria-live', 'polite');
    const actions = el(footer, 'div', 'li-editor-actions');
    const attach = async (list: File[]) => { uploads++; container.dataset.uploading = 'true'; uploadStatus.textContent = '正在保存附件…'; try { for (const file of list) { const saved = await this.host.store.attach(ref, file.name, new Uint8Array(await file.arrayBuffer())); if (!disposed) insert(`\n${saved.markdown}\n`); } } finally { if (--uploads === 0) { delete container.dataset.uploading; uploadStatus.textContent = ''; } } };
    picker.addEventListener('change', () => { const list = [...(picker.files || [])]; picker.value = ''; if (list.length) safe(() => attach(list)); });
    const attachButton = action(Platform.isMobile ? tabs : formatting, '附件', () => { if (ref) picker.click(); else new Notice('请先创建项目，再添加附件'); }); attachButton.disabled = !ref;
    attachButton.setAttribute('aria-label', Platform.isMobile ? '附件' : '附件（⌘/Ctrl+Shift+U）');
    formatting.hidden = Platform.isMobile;
    view.contentDOM.addEventListener('paste', event => { const list = [...(event.clipboardData?.files || [])]; if (!list.length) return; event.preventDefault(); safe(() => attach(list)); }, true);
    container.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); container.addClass('is-dragover'); } }); container.addEventListener('dragleave', () => container.removeClass('is-dragover')); container.addEventListener('drop', event => { container.removeClass('is-dragover'); const list = [...(event.dataTransfer?.files || [])]; if (!list.length) return; event.preventDefault(); safe(() => attach(list)); });
    const editor = { element: container, get value() { return getValue(); }, setValue: (value: string) => { if (!disposed) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value }, selection: { anchor: value.length } }); }, get uploading() { return uploads > 0; }, actions, focus, destroy, clear: () => { if (!disposed) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' }, selection: { anchor: 0 } }); } };
    this.editors.set(container, editor); return editor;
  }
}
