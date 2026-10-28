import { Component, ItemView, MarkdownRenderer, Modal, Notice, Menu, setIcon, WorkspaceLeaf } from 'obsidian';
import { createLiveMarkdown } from './live-markdown';
import { ISSUE_STATUSES, STATUS_NAMES, CLOSE_REASON_NAMES, issueLink, CloseReason, Issue, IssueInput, IssuePatch, IssueStore, Project, ProjectStatus, Snapshot, TimelineEntry } from './types';

export const VIEW_TYPE = 'local-issues-view';
export interface ViewHost { store: IssueStore; author: string; openNote(path: string): Promise<void>; resourceLink(ref?: string, scope?: 'issues'): Promise<string>; openSettings(): void; }
const PROJECT_STATES: ProjectStatus[] = ['active', 'paused', 'completed', 'archived'];
const el = <K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => { const node = document.createElement(tag); node.className = cls; if (text) node.textContent = text; parent.append(node); return node; };
const action = (parent: HTMLElement, text: string, run: () => void, cls = '') => { const b = el(parent, 'button', cls, text); b.type = 'button'; b.addEventListener('click', run); return b; };
const safe = (fn: () => Promise<unknown>) => { void fn().catch(error => new Notice(error instanceof Error ? error.message : String(error))); };
let controlId = 0;
function labelControl(control: HTMLElement, fallback = '') { const field = control.closest('.li-field'); const label = field?.querySelector(':scope > label'); const id = `li-control-${++controlId}`; control.id = id; if (label instanceof HTMLLabelElement) label.htmlFor = id; control.setAttribute('aria-label', label?.textContent || fallback); }
const words = (s: string) => s.split(/[,，\n]/).map(x => x.trim()).filter(Boolean);
const date = (s: string) => s ? new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
function select(parent: HTMLElement, options: [string, string][], value: string, changed: (value: string) => void): HTMLSelectElement { const input = el(parent, 'select'); for (const [key, name] of options) { const opt = el(input, 'option', '', name); opt.value = key; } input.value = value; labelControl(input, options[0]?.[1] || '选项'); input.addEventListener('change', () => changed(input.value)); return input; }
function input(parent: HTMLElement, placeholder: string, value = '') { const field = el(parent, 'input'); field.type = 'text'; field.placeholder = placeholder; field.value = value; labelControl(field, placeholder); return field; }
function pill(parent: HTMLElement, status: string, reason?: CloseReason) {
  const closedReason = reason || 'completed'; const label = status === 'closed' ? (reason ? `已关闭 · ${CLOSE_REASON_NAMES[closedReason]}` : '已关闭') : STATUS_NAMES[status as keyof typeof STATUS_NAMES] || status;
  const node = el(parent, 'span', `li-status li-status-${status}${status === 'closed' ? ` li-reason-${closedReason}` : ''}`);
  if (status === 'open' || status === 'closed') { const icon = el(node, 'span', 'li-status-icon'); setIcon(icon, status === 'open' ? 'circle-dot' : closedReason === 'completed' ? 'circle-check' : closedReason === 'on-hold' ? 'circle-pause' : 'circle-slash'); icon.setAttribute('aria-hidden', 'true'); }
  el(node, 'span', '', label);
}
const stateOptions: [string, string][] = [['open', '开启'], ['completed', '关闭 · 完成'], ['on-hold', '关闭 · 搁置'], ['not-planned', '关闭 · 不做']];
const stateValue = (issue: Pick<Issue, 'status' | 'closeReason'>) => issue.status === 'closed' ? issue.closeReason || 'completed' : 'open';
const statePatch = (value: string): IssuePatch => value === 'open' ? { status: 'open' } : { status: 'closed', closeReason: value as CloseReason };

export class IssuesView extends ItemView {
  private projectId?: string;
  private issueId?: string;
  private creating?: { projectId: string; defaults: Partial<IssueInput> };
  private activeEdit?: { element: HTMLElement; label: string; dirty: () => boolean; discard: () => void };
  private discardPrompt?: Modal;
  private deletePrompt?: Modal;
  private submissionNotice?: Notice;
  private submittingComment = false;
  private data: Snapshot = { projects: [], issues: [], timeline: [], warnings: [] };
  private query = '';
  private state = '';
  private issueState: 'open' | 'closed' = 'open';
  private label = '';
  private milestone = '';
  private sort = 'updated';
  private group = '';
  private projectFields = new Set(['progress', 'count', 'status', 'due']);
  private issueFields = new Set(['status', 'labels', 'milestone', 'assignees', 'due']);
  private mode: 'list' | 'board' | 'table' = 'list';
  private selected = new Set<string>();
  private drafts = new Map<string, string>();
  private renderScope = new Component();
  private generation = 0;
  private pending = false;
  constructor(leaf: WorkspaceLeaf, private host: ViewHost) { super(leaf); }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Local Issues'; }
  getIcon() { return 'list-todo'; }
  async onOpen() { this.renderScope.load(); await this.refresh(); }
  async onClose() { this.deletePrompt?.close(); this.submissionNotice?.hide(); this.discardPrompt?.close(); this.stopEditing(); this.renderScope.unload(); }
  getState() { return { projectId: this.projectId, issueId: this.issueId }; }
  private get editingInline() {
    if (this.activeEdit && !this.contentEl.contains(this.activeEdit.element)) this.stopEditing(true);
    return !!this.activeEdit;
  }
  private startEditing(element: HTMLElement, label: string, dirty: () => boolean, discard: () => void) {
    ++this.generation;
    this.activeEdit = { element, label, dirty, discard };
    element.addClass('li-editing');
    const bar = this.contentEl.querySelector('.li-topbar');
    if (bar instanceof HTMLElement) { const location = action(bar, `正在编辑：${label}`, () => this.locateEditing(), 'li-editing-location li-subtle'); location.title = `定位编辑：${label}`; }
  }
  private locateEditing() {
    if (!this.editingInline) return;
    const element = this.activeEdit!.element;
    element.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    (element.querySelector<HTMLElement>('.cm-content, input, select') || element.querySelector<HTMLElement>('button'))?.focus({ preventScroll: true });
  }
  private stopEditing(discard = false) {
    const edit = this.activeEdit; this.activeEdit = undefined;
    edit?.element.removeClass('li-editing');
    this.contentEl.querySelector('.li-editing-location')?.remove();
    if (discard) edit?.discard();
  }
  private afterEditing(run: () => void | Promise<unknown>, allowDuringSubmission = false): Promise<void> {
    if (this.discardPrompt?.modalEl.isConnected) {
      this.discardPrompt.modalEl.querySelector<HTMLElement>('button')?.focus();
      return Promise.resolve();
    }
    this.discardPrompt = undefined;
    if (this.submittingComment && !allowDuringSubmission) {
      this.submissionNotice ??= new Notice('评论正在发表，请稍候再操作。', 0);
      return Promise.resolve();
    }
    if (!this.editingInline || !this.activeEdit!.dirty()) {
      this.stopEditing(true);
      return (async () => { await run(); })();
    }
    const edit = this.activeEdit!;
    const modal = this.discardPrompt = this.modal('放弃未保存的修改？');
    el(modal.contentEl, 'p', '', `正在编辑：${edit.label}`);
    el(modal.contentEl, 'p', 'li-muted', '继续操作将丢失这处尚未保存的修改。');
    let discard = false;
    return new Promise<void>((resolve, reject) => {
      modal.onClose = () => {
        this.discardPrompt = undefined;
        if (!discard) { Promise.resolve().then(() => { this.locateEditing(); resolve(); }); return; }
        this.stopEditing(true);
        Promise.resolve().then(run).then(() => resolve(), reject);
      };
      const buttons = el(modal.modalEl, 'div', 'li-modal-actions');
      const keep = action(buttons, '返回编辑', () => modal.close());
      action(buttons, '放弃修改并继续', () => { discard = true; modal.close(); }, 'mod-warning');
      modal.open(); keep.focus();
    });
  }
  async setState(state: { projectId?: string; issueId?: string }, result: any) { await this.navigate(state.projectId, state.issueId); await super.setState(this.getState(), result); }
  async navigate(projectId?: string, issueId?: string) {
    await this.afterEditing(async () => {
      if (projectId !== this.projectId) { this.group = ''; this.issueState = 'open'; }
      this.projectId = projectId; this.issueId = issueId; this.creating = undefined; this.query = ''; this.state = ''; this.label = ''; this.milestone = ''; this.selected.clear(); await this.draw();
    });
  }
  async refresh() {
    const active = document.activeElement;
    if (this.creating || this.editingInline || this.submittingComment || (this.contentEl.contains(active) && (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.dataset.editor) || (active instanceof HTMLElement && active.closest('.li-live-editor'))))) { this.pending = true; this.showPending(); return; }
    await this.draw();
  }
  private showPending() { if (this.contentEl.querySelector('.li-pending')) return; const bar = this.contentEl.querySelector('.li-topbar'); if (bar instanceof HTMLElement) action(bar, '有更新 · 刷新', () => safe(() => this.afterEditing(() => this.draw())), 'li-pending'); }
  private async draw() {
    if (this.editingInline || this.submittingComment) { this.pending = true; this.showPending(); return; }
    const sequence = ++this.generation;
    const data = await this.host.store.snapshot(); if (sequence !== this.generation) return;
    this.data = data; this.pending = false; this.renderScope.unload(); this.renderScope = new Component(); this.renderScope.load();
    this.contentEl.replaceChildren(); this.contentEl.addClass('local-issues');
    const shell = el(this.contentEl, 'div', 'li-shell');
    const top = el(shell, 'div', 'li-topbar');
    action(top, '项目', () => safe(() => this.navigate()), 'li-breadcrumb');
    const project = data.projects.find(p => p.id === this.projectId);
    if (project) { el(top, 'span', 'li-muted', '/'); action(top, project.title, () => safe(() => this.navigate(project.id)), 'li-breadcrumb'); }
    el(top, 'div', 'li-spacer'); action(top, '设置', () => this.host.openSettings(), 'li-subtle');
    if (data.warnings.length) { const details = el(shell, 'details', 'li-warning'); el(details, 'summary', '', `${data.warnings.length} 个笔记需要检查`); for (const warning of data.warnings) el(details, 'div', '', warning); }
    if (this.creating && project && this.creating.projectId === project.id) this.issueModal(project, undefined, this.creating.defaults, shell);
    else if (this.issueId) { const issue = data.issues.find(i => i.id === this.issueId); if (issue) this.renderIssue(shell, issue); else { el(shell, 'p', '', '此 Issue 已移动或不存在。'); action(shell, '返回项目', () => safe(() => this.navigate(project?.id))); } }
    else if (project) this.renderProject(shell, project);
    else this.renderProjects(shell);
  }
  private markdown(parent: HTMLElement, body: string, path: string) {
    const node = el(parent, 'div', 'li-markdown markdown-rendered');
    safe(() => MarkdownRenderer.render(this.app, body || '*暂无描述*', node, path, this.renderScope));
    node.addEventListener('click', event => { const target = (event.target as HTMLElement).closest('a.internal-link') as HTMLAnchorElement | null; if (!target) return; const href = target.dataset.href || target.getAttribute('href'); if (!href) return; event.preventDefault(); const clean = href.replace(/\.md$/, ''); const item = this.data.issues.find(i => i.path.replace(/\.md$/, '') === clean); if (item) safe(() => this.navigate(item.projectId, item.id)); else safe(() => this.app.workspace.openLinkText(href, path)); });
    return node;
  }
  private renderProjects(root: HTMLElement) {
    const head = el(root, 'div', 'li-heading'); el(head, 'h2', '', '项目'); el(head, 'span', 'li-muted', `${this.data.projects.length} 个项目`); const actions = el(head, 'div', 'li-heading-actions'); action(actions, '复制仓库链接', () => safe(async () => { await navigator.clipboard.writeText(await this.host.resourceLink()); new Notice('已复制仓库链接'); })); action(actions, '+ 新建项目', () => this.projectModal(), 'mod-cta');
    const searchRow = el(root, 'div', 'li-search-row'); const search = input(searchRow, '搜索项目', this.query); search.setAttribute('aria-label', '搜索项目'); search.addEventListener('change', () => { this.query = search.value; safe(() => this.draw()); }); search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.query = search.value; safe(() => this.draw()); } });
    const tools = el(root, 'div', 'li-toolbar');
    select(tools, [['', '所有状态'], ...PROJECT_STATES.map(s => [s, STATUS_NAMES[s]] as [string, string])], this.state, value => { this.state = value; safe(() => this.draw()); });
    select(tools, [['updated', '最近更新'], ['title', '项目名称'], ['due', '截止日期']], this.sort, value => { this.sort = value; safe(() => this.draw()); });
    select(tools, [['', '不分组'], ['status', '按状态分组']], this.group, value => { this.group = value; safe(() => this.draw()); });
    this.fieldsButton(tools, this.projectFields, [['progress', '进度'], ['count', 'Issues 数'], ['status', '状态'], ['due', '截止日期']]);
    const projects = this.data.projects.filter(p => (!this.state || p.status === this.state) && `${p.title} ${p.description}`.toLowerCase().includes(this.query.toLowerCase())).sort((a, b) => this.sort === 'title' ? a.title.localeCompare(b.title) : this.sort === 'due' ? (a.dueDate || '9999').localeCompare(b.dueDate || '9999') : b.updatedAt.localeCompare(a.updatedAt));
    if (this.group === 'status') projects.sort((a, b) => PROJECT_STATES.indexOf(a.status) - PROJECT_STATES.indexOf(b.status));
    if (!this.data.projects.length) { const empty = el(root, 'div', 'li-empty'); setIcon(el(empty, 'div', 'li-empty-icon'), 'folders'); el(empty, 'h3', '', '把想法变成项目'); el(empty, 'p', 'li-muted', '为每个项目记录 Issues、讨论和进度，所有内容保存在本地 Markdown 中。'); action(empty, '创建第一个项目', () => this.projectModal(), 'mod-cta'); return; }
    const table = el(root, 'table', 'li-table li-projects'); const tr = el(el(table, 'thead'), 'tr'); for (const name of ['项目', '进度', 'Issues', '状态', '截止', '']) el(tr, 'th', '', name); const body = el(table, 'tbody');
    let group = ''; for (const project of projects) { if (this.group && group !== project.status) { group = project.status; const cell = el(el(body, 'tr', 'li-group'), 'td', '', STATUS_NAMES[project.status]); cell.colSpan = 6; }
      const row = el(body, 'tr'); this.shareContextMenu(row, project.id, '项目'); const name = el(row, 'td'); action(name, project.title, () => safe(() => this.navigate(project.id)), 'li-project-title'); if (project.description) el(name, 'div', 'li-muted li-truncate', project.description.split('\n')[0]);
      const issues = this.data.issues.filter(i => i.projectId === project.id); const done = issues.filter(i => i.status === 'closed').length; const percent = issues.length ? Math.round(done / issues.length * 100) : 0;
      const progressCell = el(row, 'td'); const progress = el(progressCell, 'progress'); progress.max = 100; progress.value = percent; progress.setAttribute('aria-label', `${project.title} 完成 ${percent}%`); el(progressCell, 'span', 'li-muted', ` ${percent}%`);
      el(row, 'td', '', `${done}/${issues.length}`); pill(el(row, 'td'), project.status); el(row, 'td', 'li-muted', project.dueDate || '—'); action(el(row, 'td'), '编辑', () => this.projectModal(project), 'li-subtle');
    }
    this.hideColumns(table, ['', 'progress', 'count', 'status', 'due', ''], this.projectFields);
    if (!projects.length) el(root, 'p', 'li-empty', '没有匹配的项目。');
  }
  private renderProject(root: HTMLElement, project: Project) {
    const head = el(root, 'div', 'li-heading'); this.shareContextMenu(head, project.id, '项目'); el(head, 'h2', '', project.title); pill(head, project.status);
    const actions = el(head, 'div', 'li-heading-actions');
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
    action(actions, '+ 新建 Issue', () => this.issueModal(project), 'mod-cta');
    if (project.description) this.markdown(root, project.description, project.path);
    const tabs = el(root, 'div', 'li-tabs'); for (const [mode, title] of [['list', 'Issues'], ['board', '看板'], ['table', '表格']] as const) action(tabs, title, () => { this.mode = mode; safe(() => this.draw()); }, this.mode === mode ? 'li-tab is-active' : 'li-tab');
    const searchRow = el(root, 'div', 'li-search-row'); const search = input(searchRow, '搜索标题、描述、评论 · label:标签 state:open', this.query); search.setAttribute('aria-label', '搜索 Issues'); search.addEventListener('change', () => { this.query = search.value; safe(() => this.draw()); }); search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); this.query = search.value; safe(() => this.draw()); } });
    const all = this.data.issues.filter(i => i.projectId === project.id); const labels = [...new Set(all.flatMap(i => i.labels))].sort(); const milestones = [...new Set(all.map(i => i.milestone).filter(Boolean))].sort();
    const filters = el(root, 'details', 'li-advanced-filters'); filters.open = !!(this.label || this.milestone);
    el(filters, 'summary', '', `更多筛选${this.label || this.milestone ? ' · 已启用' : ''}`);
    const filterFields = el(filters, 'div', 'li-filter-grid');
    select(this.field(filterFields, '标签'), [['', '所有标签'], ...labels.map(s => [s, s] as [string, string])], this.label, value => { this.label = value; safe(() => this.draw()); });
    select(this.field(filterFields, '里程碑'), [['', '所有里程碑'], ...milestones.map(s => [s, s] as [string, string])], this.milestone, value => { this.milestone = value; safe(() => this.draw()); });
    const tools = el(root, 'div', 'li-toolbar');
    select(tools, [['updated', '最近更新'], ['created', '最早创建'], ['title', '标题'], ['due', '截止日期']], this.sort, value => { this.sort = value; safe(() => this.draw()); });
    select(tools, [['', '不分组'], ['status', '按状态'], ['milestone', '按里程碑'], ['label', '按标签']], this.group, value => { this.group = value; safe(() => this.draw()); });
    this.fieldsButton(tools, this.issueFields, [['status', '状态'], ['labels', '标签'], ['milestone', '里程碑'], ['assignees', '负责人'], ['due', '截止日期']]);
    const matching = all.filter(i => this.matches(i));
    const filtered = matching.filter(i => this.mode === 'board' || (this.issueState === 'closed' ? i.status === 'closed' : i.status !== 'closed')).sort((a, b) => this.sort === 'title' ? a.title.localeCompare(b.title) : this.sort === 'created' ? a.createdAt.localeCompare(b.createdAt) : this.sort === 'due' ? (a.dueDate || '9999').localeCompare(b.dueDate || '9999') : b.updatedAt.localeCompare(a.updatedAt));
    if (this.mode !== 'board') {
      const states = el(root, 'div', 'li-state-tabs'); states.setAttribute('aria-label', 'Issue 状态');
      for (const [state, label] of [['open', '开启'], ['closed', '已关闭']] as const) {
        const count = matching.filter(i => state === 'closed' ? i.status === 'closed' : i.status !== 'closed').length;
        const button = action(states, `${count} 个${label}`, () => { this.issueState = state; this.selected.clear(); safe(() => this.draw()); }, `li-state-tab${this.issueState === state ? ' is-active' : ''}`);
        button.setAttribute('aria-pressed', String(this.issueState === state));
      }
    }

    if (this.selected.size) { const batch = el(root, 'div', 'li-batch'); el(batch, 'span', '', `已选择 ${this.selected.size} 项`); select(batch, [['', '修改状态…'], ...ISSUE_STATUSES.map(s => [s, STATUS_NAMES[s]] as [string, string])], '', value => { if (value) safe(async () => { for (const id of this.selected) await this.host.store.updateIssue(id, { status: value as Issue['status'], actor: this.host.author }); this.selected.clear(); await this.draw(); }); }); action(batch, '添加标签', () => this.textModal('批量添加标签', '', async value => { for (const id of this.selected) { const i = this.data.issues.find(item => item.id === id); if (i) await this.host.store.updateIssue(id, { labels: [...new Set([...i.labels, ...words(value)])] }, i.revision ?? i.updatedAt); } this.selected.clear(); await this.draw(); })); action(batch, '取消选择', () => { this.selected.clear(); safe(() => this.draw()); }); }
    if (!filtered.length) { const empty = el(root, 'div', 'li-empty'); el(empty, 'h3', '', !all.length ? '这个项目还没有 Issues' : this.issueState === 'closed' && !matching.some(i => i.status === 'closed') ? '没有已关闭的 Issues' : this.issueState === 'open' && !matching.some(i => i.status !== 'closed') ? '没有开启的 Issues' : '没有匹配的 Issues'); action(empty, '+ 新建 Issue', () => this.issueModal(project), 'mod-cta'); return; }
    if (this.mode === 'board') { const board = el(root, 'div', 'li-board'); for (const status of ISSUE_STATUSES) { const column = el(board, 'section', 'li-board-column'); const issues = filtered.filter(i => i.status === status); const header = el(column, 'div', 'li-board-header'); pill(header, status); el(header, 'span', 'li-muted', String(issues.length)); action(header, '+', () => this.issueModal(project, undefined, { status }), 'li-subtle'); column.addEventListener('dragover', event => { event.preventDefault(); column.addClass('is-dragover'); }); column.addEventListener('dragleave', () => column.removeClass('is-dragover')); column.addEventListener('drop', event => { event.preventDefault(); column.removeClass('is-dragover'); const id = event.dataTransfer?.getData('text/local-issues'); if (id) safe(async () => { await this.host.store.updateIssue(id, { status, actor: this.host.author }); await this.draw(); }); }); for (const issue of issues) this.issueCard(column, issue, true); } return; }
    const groups = new Map<string, Issue[]>(); for (const issue of filtered) { const key = this.group === 'status' ? STATUS_NAMES[issue.status] : this.group === 'milestone' ? issue.milestone || '无里程碑' : this.group === 'label' ? issue.labels[0] || '无标签' : ''; groups.set(key, [...(groups.get(key) || []), issue]); }
    for (const [name, issues] of groups) { if (name) el(root, 'h3', 'li-section-heading', `${name} · ${issues.length}`); if (this.mode === 'table') { const table = el(root, 'table', 'li-table li-issues-table'); const th = el(el(table, 'thead'), 'tr'); for (const name of ['', 'Issue', '状态', '标签', '里程碑', '负责人', '截止']) el(th, 'th', '', name); const body = el(table, 'tbody'); for (const issue of issues) { const row = el(body, 'tr'); this.shareContextMenu(row, issue.id, '议题'); this.checkbox(el(row, 'td'), issue); action(el(row, 'td'), `#${issue.number} ${issue.title}`, () => safe(() => this.navigate(project.id, issue.id)), 'li-issue-title'); pill(el(row, 'td'), issue.status, issue.closeReason); el(row, 'td', '', issue.labels.join('、') || '—'); el(row, 'td', '', issue.milestone || '—'); el(row, 'td', '', issue.assignees.join('、') || '—'); el(row, 'td', '', issue.dueDate || '—'); } this.hideColumns(table, ['', '', 'status', 'labels', 'milestone', 'assignees', 'due'], this.issueFields); } else { const list = el(root, 'div', 'li-issue-list'); for (const issue of issues) this.issueCard(list, issue); } }
  }
  private shareContextMenu(target: HTMLElement, ref: string, kind: string) {
    target.addEventListener('contextmenu', event => { event.preventDefault(); const menu = new Menu(); menu.addItem(item => item.setTitle('分享给 Agent').onClick(() => safe(async () => { await navigator.clipboard.writeText(await this.host.resourceLink(ref)); new Notice(`已复制${kind}链接`); }))); menu.showAtMouseEvent(event); });
  }
  private moreButton(parent: HTMLElement, options: [string, () => void][], label: string) {
    const button = action(parent, '更多', () => undefined, 'li-subtle li-more'); button.setAttribute('aria-label', label);
    button.addEventListener('click', event => { const menu = new Menu(); for (const [title, run] of options) menu.addItem(item => item.setTitle(title).onClick(run)); menu.showAtMouseEvent(event); });
  }
  private fieldsButton(parent: HTMLElement, fields: Set<string>, options: [string, string][]) { const button = action(parent, '字段', () => undefined); button.addEventListener('click', event => { const menu = new Menu(); for (const [key, name] of options) menu.addItem(item => item.setTitle(name).setChecked(fields.has(key)).onClick(() => { fields.has(key) ? fields.delete(key) : fields.add(key); safe(() => this.draw()); })); menu.showAtMouseEvent(event); }); }
  private hideColumns(table: HTMLTableElement, keys: string[], fields: Set<string>) { for (const row of table.rows) { if (row.cells.length === 1 && row.cells[0].colSpan > 1) continue; for (let i = 0; i < row.cells.length; i++) row.cells[i].hidden = !!keys[i] && !fields.has(keys[i]); } }
  private matches(issue: Issue) {
    if (this.label && !issue.labels.includes(this.label)) return false; if (this.milestone && issue.milestone !== this.milestone) return false;
    const text = `${issue.title} ${issue.body} ${issue.labels.join(' ')} ${issue.number} ${this.data.timeline.filter(e => e.issueId === issue.id && e.kind === 'comment').map(e => e.body).join(' ')}`.toLowerCase();
    return this.query.match(/(?:[^\s"]+|"[^"]*")+/g)?.every(token => { const [key, ...parts] = token.split(':'); const value = parts.join(':').replace(/^"|"$/g, ''); if (key === 'state' || key === 'is') return value === 'open' ? issue.status !== 'closed' : value === 'closed' ? issue.status === 'closed' : issue.status === value; if (key === 'label') return issue.labels.some(l => l.toLowerCase() === value.toLowerCase()); if (key === 'milestone') return issue.milestone.toLowerCase() === value.toLowerCase(); if (key === 'assignee') return issue.assignees.some(a => a.toLowerCase() === value.toLowerCase()); return text.includes(token.replace(/^"|"$/g, '').toLowerCase()); }) ?? true;
  }
  private checkbox(parent: HTMLElement, issue: Issue) { const checkbox = el(parent, 'input'); checkbox.type = 'checkbox'; checkbox.checked = this.selected.has(issue.id); checkbox.setAttribute('aria-label', `选择 #${issue.number}`); checkbox.addEventListener('change', () => { checkbox.checked ? this.selected.add(issue.id) : this.selected.delete(issue.id); safe(() => this.draw()); }); }
  private issueCard(parent: HTMLElement, issue: Issue, board = false) { const card = el(parent, 'div', board ? 'li-card' : 'li-issue-row'); this.shareContextMenu(card, issue.id, '议题'); if (board) { card.draggable = true; card.addEventListener('dragstart', event => event.dataTransfer?.setData('text/local-issues', issue.id)); } else this.checkbox(card, issue); const content = el(card, 'div', 'li-issue-content'); const title = el(content, 'div', 'li-issue-title-row'); if (!board) pill(title, issue.status, issue.closeReason); action(title, issue.title, () => safe(() => this.navigate(issue.projectId, issue.id)), 'li-issue-title'); for (const label of issue.labels) el(title, 'span', 'li-label', label); const meta = el(content, 'div', 'li-muted li-issue-meta'); el(meta, 'span', '', `#${issue.number} · ${issue.author} · ${date(issue.updatedAt)}`); if (issue.milestone) el(meta, 'span', '', `◇ ${issue.milestone}`); const comments = this.data.timeline.filter(e => e.issueId === issue.id && e.kind === 'comment').length; if (comments) el(meta, 'span', '', `◌ ${comments}`); if (board) select(card, stateOptions, stateValue(issue), value => safe(async () => { await this.host.store.updateIssue(issue.id, { ...statePatch(value), actor: this.host.author }); await this.draw(); })); }
  private renderIssue(root: HTMLElement, issue: Issue) {
    const project = this.data.projects.find(p => p.id === issue.projectId)!;
    const header = el(root, 'div', 'li-detail-header'); this.shareContextMenu(header, issue.id, '议题'); const title = el(header, 'div', 'li-detail-title');
    const showTitle = () => { title.replaceChildren(); el(title, 'h1', '', issue.title); el(title, 'span', 'li-muted', `#${issue.number}`); const button = action(title, '编辑标题', () => safe(() => this.afterEditing(() => {
      title.replaceChildren();
      const field = input(title, '议题标题', issue.title); field.setAttribute('aria-label', '议题标题'); field.dataset.editor = 'true';
      const controls = el(title, 'div', 'li-inline-actions'); action(controls, '取消', () => { this.stopEditing(true); if (this.pending) safe(() => this.draw()); });
      this.startEditing(title, '议题标题', () => field.value !== issue.title, showTitle);
      const save = action(controls, '保存', () => safe(async () => { if (!field.value.trim()) throw new Error('请输入 Issue 标题'); save.disabled = true; try { await this.host.store.updateIssue(issue.id, { title: field.value.trim(), actor: this.host.author }, issue.revision ?? issue.updatedAt); this.stopEditing(); await this.draw(); } finally { save.disabled = false; } }), 'mod-cta'); field.focus();
    })), 'li-subtle'); button.setAttribute('aria-label', '编辑标题'); }; showTitle();
    const controls = el(header, 'div', 'li-detail-actions');
    this.moreButton(controls, [
      ['打开笔记', () => safe(() => this.host.openNote(issue.path))],
      ['复制双链', () => safe(async () => { await navigator.clipboard.writeText(issueLink(issue)); new Notice('已复制双链'); })],
      ['分享给 Agent', () => safe(async () => { await navigator.clipboard.writeText(await this.host.resourceLink(issue.id)); new Notice('已复制议题链接'); })],
    ], 'Issue 更多操作');
    const summary = el(root, 'div', 'li-issue-summary'); pill(summary, issue.status, issue.closeReason); el(summary, 'span', 'li-muted', `${issue.author} 创建于 ${date(issue.createdAt)} · ${this.data.timeline.filter(e => e.issueId === issue.id && e.kind === 'comment').length} 条评论`);
    const detail = el(root, 'div', 'li-detail'); const main = el(detail, 'div', 'li-detail-main'); const sidebar = el(detail, 'aside', 'li-sidebar');
    const description = el(main, 'article', 'li-comment li-description'); const descriptionHead = el(description, 'div', 'li-comment-header'); el(descriptionHead, 'strong', '', issue.author); el(descriptionHead, 'span', 'li-muted', '描述'); el(descriptionHead, 'div', 'li-spacer');
    const content = el(description, 'div', 'li-description-content'); this.markdown(content, issue.body, issue.path);
    const edit = action(descriptionHead, '编辑', () => safe(() => this.afterEditing(() => {
      edit.hidden = true; content.replaceChildren(); const text = this.editor(content, issue.body, issue.id, issue.path); const buttons = text.actions;
      this.startEditing(text.element, '议题描述', () => text.value !== issue.body || text.uploading, () => { text.destroy(); content.replaceChildren(); this.markdown(content, issue.body, issue.path); edit.hidden = false; });
      action(buttons, '取消', () => { this.stopEditing(true); if (this.pending) safe(() => this.draw()); });
      const save = action(buttons, '保存', () => safe(async () => { if (text.uploading) throw new Error('附件正在保存，请稍后保存'); save.disabled = true; try { await this.host.store.updateIssue(issue.id, { body: text.value, actor: this.host.author }, issue.revision ?? issue.updatedAt); this.stopEditing(); await this.draw(); } finally { save.disabled = false; } }), 'mod-cta'); text.focus();
    })), 'li-subtle');
    const children = this.data.issues.filter(i => i.parent === issue.id); if (children.length) { const section = el(main, 'section', 'li-relations'); el(section, 'h3', '', `子议题 · ${children.filter(i => i.status === 'closed').length}/${children.length}`); for (const child of children) { const row = el(section, 'div', 'li-relation'); pill(row, child.status, child.closeReason); action(row, `#${child.number} ${child.title}`, () => safe(() => this.navigate(child.projectId, child.id)), 'li-subtle'); } }
    action(main, '+ 添加子议题', () => this.issueModal(project, undefined, { parent: issue.id }), 'li-subtle');
    const timeline = el(main, 'div', 'li-timeline'); const entries = this.data.timeline.filter(e => e.issueId === issue.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const entry of entries) { if (entry.kind === 'event') { const event = el(timeline, 'div', 'li-event'); pill(event, entry.to || 'open'); el(event, 'span', '', `${entry.author} ${entry.body}`); el(event, 'span', 'li-muted', date(entry.createdAt)); } else { const comment = el(timeline, 'article', 'li-comment'); comment.dataset.commentId = entry.id; const head = el(comment, 'div', 'li-comment-header'); el(head, 'strong', '', entry.author); el(head, 'span', 'li-muted', `${date(entry.createdAt)}${entry.updatedAt !== entry.createdAt ? ' · 已编辑' : ''}`); el(head, 'div', 'li-spacer'); const content = el(comment, 'div', 'li-description-content'); const edit = action(head, '编辑', () => safe(() => this.afterEditing(() => { edit.hidden = true; content.replaceChildren(); const text = this.editor(content, entry.body, issue.id, entry.path); const buttons = text.actions; this.startEditing(text.element, `评论 · ${entry.author} · ${date(entry.createdAt)} · ${entry.body.replace(/\s+/g, ' ').slice(0, 40)}`, () => text.value !== entry.body || text.uploading, () => { text.destroy(); content.replaceChildren(); this.markdown(content, entry.body, entry.path); edit.hidden = false; }); action(buttons, '取消', () => { this.stopEditing(true); if (this.pending) safe(() => this.draw()); }); const save = action(buttons, '保存', () => safe(async () => { if (!text.value.trim()) throw new Error('评论不能为空'); if (text.uploading) throw new Error('附件正在保存，请稍后保存'); save.disabled = true; try { await this.host.store.editComment(entry.id, text.value, entry.revision ?? entry.updatedAt); this.stopEditing(); await this.draw(); } finally { save.disabled = false; } }), 'mod-cta'); text.focus(); })), 'li-subtle'); action(head, '笔记', () => safe(() => this.host.openNote(entry.path)), 'li-subtle'); action(head, '删除', () => this.deleteComment(comment, entry), 'li-subtle li-delete-comment'); this.markdown(content, entry.body, entry.path); } }
    const composer = el(main, 'section', 'li-composer'); el(composer, 'h3', '', '发表评论'); const editor = this.editor(composer, this.drafts.get(issue.id) || '', issue.id, issue.path, value => this.drafts.set(issue.id, value)); const status = el(composer, 'div', 'li-composer-status'); status.setAttribute('role', 'status'); const footer = editor.actions;
    let closeReason: CloseReason = 'completed'; if (issue.status !== 'closed') select(footer, Object.entries(CLOSE_REASON_NAMES) as [string, string][], closeReason, value => { closeReason = value as CloseReason; });
    const close = action(footer, issue.status === 'closed' ? '重新打开 Issue' : '关闭 Issue', () => safe(() => this.afterEditing(async () => { close.disabled = true; try { await this.host.store.updateIssue(issue.id, { status: issue.status === 'closed' ? 'open' : 'closed', ...(issue.status !== 'closed' ? { closeReason } : {}), actor: this.host.author }, issue.revision ?? issue.updatedAt); await this.draw(); } finally { close.disabled = false; } })));
    const submit = action(footer, '发表评论', () => safe(() => this.afterEditing(async () => {
      if (this.submittingComment) return;
      const feedback = (message: string) => { status.textContent = message; new Notice(message); };
      if (!editor.value.trim()) { feedback('请输入评论内容'); return; }
      if (editor.uploading) { feedback('附件正在保存，请稍后发表评论'); return; }
      this.submittingComment = true; submit.disabled = true; submit.textContent = '正在发表…'; status.textContent = '正在发表评论…';
      try {
        await this.host.store.addComment(issue.id, editor.value, this.host.author);
        editor.clear(); this.drafts.delete(issue.id); this.submittingComment = false;
        await this.draw(); new Notice('评论已发表');
      } catch (error) { status.textContent = `发表失败：${error instanceof Error ? error.message : String(error)}`; throw error; }
      finally { this.submittingComment = false; this.submissionNotice?.hide(); this.submissionNotice = undefined; submit.disabled = false; submit.textContent = '发表评论'; }
    })), 'mod-cta');
    el(sidebar, 'h3', '', '属性'); const stateField = this.field(sidebar, '状态'); select(stateField, stateOptions, stateValue(issue), value => { const stateSelect = stateField.querySelector('select')!; stateSelect.value = stateValue(issue); safe(() => this.afterEditing(async () => { await this.host.store.updateIssue(issue.id, { ...statePatch(value), actor: this.host.author }, issue.revision ?? issue.updatedAt); await this.draw(); })); });
    for (const [name, value] of [['标签', issue.labels.join('、')], ['里程碑', issue.milestone], ['负责人', issue.assignees.join('、')], ['截止日期', issue.dueDate]]) { const field = this.field(sidebar, name); el(field, 'div', 'li-muted', value || '未设置'); }
    const parent = issue.parent && this.data.issues.find(i => i.id === issue.parent); if (parent) { const field = this.field(sidebar, '父议题'); action(field, `#${parent.number} ${parent.title}`, () => safe(() => this.navigate(parent.projectId, parent.id)), 'li-subtle'); }
    const depField = this.field(sidebar, '依赖'); for (const id of issue.dependencies) { const dep = this.data.issues.find(i => i.id === id); if (dep) { const row = el(depField, 'div', 'li-relation'); pill(row, dep.status, dep.closeReason); action(row, `#${dep.number} ${dep.title}`, () => safe(() => this.navigate(dep.projectId, dep.id)), 'li-subtle'); } else el(depField, 'span', 'li-muted', id); } if (!issue.dependencies.length) el(depField, 'span', 'li-muted', '无依赖');
    action(sidebar, '编辑属性', () => safe(() => this.afterEditing(() => { const original = [...sidebar.childNodes]; sidebar.replaceChildren(); el(sidebar, 'h3', '', '编辑属性'); this.issueModal(project, issue, {}, sidebar, () => sidebar.replaceChildren(...original)); })), 'li-subtle');
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
  private field(parent: HTMLElement, label: string) { const field = el(parent, 'div', 'li-field'); el(field, 'label', '', label); return field; }
  private projectModal(project?: Project) {
    const modal = this.modal(project ? '编辑项目' : '新建项目'); const title = input(this.field(modal.contentEl, '项目名称'), '项目名称', project?.title); title.required = true;
    const description = el(this.field(modal.contentEl, '项目说明 · Markdown'), 'textarea', 'li-textarea'); description.value = project?.description || ''; description.rows = 5; labelControl(description, '项目说明');
    let status: ProjectStatus = project?.status || 'active'; select(this.field(modal.contentEl, '状态'), PROJECT_STATES.map(s => [s, STATUS_NAMES[s]]), status, value => { status = value as ProjectStatus; }); const due = input(this.field(modal.contentEl, '截止日期'), '', project?.dueDate); due.type = 'date';
    this.saveButton(modal, async () => { if (!title.value.trim()) throw new Error('请输入项目名称'); const data = { title: title.value.trim(), description: description.value, status, dueDate: due.value }; const saved = project ? await this.host.store.updateProject(project.id, data, project.revision ?? project.updatedAt) : await this.host.store.createProject(data); modal.close(); await this.navigate(saved.id); }); modal.open(); title.focus();
  }
  private issueModal(project: Project, issue?: Issue, defaults: Partial<IssueInput> = {}, inline?: HTMLElement, restore?: () => void) {
    if (!issue && !inline) { safe(() => this.afterEditing(async () => { this.projectId = project.id; this.issueId = undefined; this.creating = { projectId: project.id, defaults }; await this.draw(); })); return; }
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
    let parent = issue?.parent || defaults.parent || ''; select(this.field(grid, '父议题'), [['', '无'], ...this.data.issues.filter(i => i.id !== issue?.id).map(i => [i.id, `${this.data.projects.find(p => p.id === i.projectId)?.title || ''} #${i.number} ${i.title}`] as [string, string])], parent, value => { parent = value; });
    const dependencies = new Set(issue?.dependencies || defaults.dependencies || []);
    const depField = this.field(properties, '依赖'); const selectedDeps = el(depField, 'div', 'li-selected-dependencies');
    const searchDeps = input(depField, '输入 @ 或 / 搜索议题'); searchDeps.setAttribute('aria-label', '搜索依赖议题');
    const suggestions = el(depField, 'div', 'li-dependency-suggestions'); suggestions.hidden = true;
    const renderSelected = () => { selectedDeps.replaceChildren(); for (const id of dependencies) { const candidate = this.data.issues.find(i => i.id === id); const chip = el(selectedDeps, 'span', 'li-dependency-chip'); el(chip, 'span', '', candidate ? `#${candidate.number} ${candidate.title}` : id); const remove = action(chip, '×', () => { dependencies.delete(id); renderSelected(); renderSuggestions(); }); remove.setAttribute('aria-label', `移除依赖 ${candidate?.title || id}`); } };
    const renderSuggestions = () => { const match = searchDeps.value.match(/^[@/](.*)$/); suggestions.replaceChildren(); suggestions.hidden = !match; if (!match) return; const query = match[1].trim().toLowerCase(); const candidates = this.data.issues.filter(i => i.id !== issue?.id && !dependencies.has(i.id) && `${this.data.projects.find(p => p.id === i.projectId)?.title || ''} #${i.number} ${i.title}`.toLowerCase().includes(query)).slice(0, 20); for (const candidate of candidates) { const name = this.data.projects.find(p => p.id === candidate.projectId)?.title || ''; action(suggestions, `${name} #${candidate.number} ${candidate.title}`, () => { dependencies.add(candidate.id); searchDeps.value = ''; renderSelected(); renderSuggestions(); searchDeps.focus(); }, 'li-dependency-option'); } if (!candidates.length) el(suggestions, 'div', 'li-muted', '没有匹配的议题'); };
    searchDeps.addEventListener('input', renderSuggestions); searchDeps.addEventListener('keydown', event => { if (event.key === 'Escape') { suggestions.hidden = true; } else if (event.key === 'Enter' && !suggestions.hidden) { event.preventDefault(); suggestions.querySelector('button')?.click(); } }); renderSelected();
    const saveIssue = async () => { if (!issue && !title?.value.trim()) throw new Error('请输入 Issue 标题'); if (form.querySelector('[data-uploading]')) throw new Error('附件正在保存，请稍后保存'); const patch: IssuePatch = { ...(!issue ? { title: title!.value.trim(), body: body!.value } : {}), ...statePatch(currentState), labels: words(labels.value), milestone: milestone.value.trim(), assignees: words(assignees.value), dueDate: due.value, parent, dependencies: [...dependencies], actor: this.host.author }; const saved = issue ? await this.host.store.updateIssue(issue.id, patch, issue.revision ?? issue.updatedAt) : await this.host.store.createIssue(project.id, { ...patch, author: this.host.author, title: title!.value.trim() }); modal?.close(); this.stopEditing(); await this.navigate(project.id, saved.id); };
    const formValue = () => JSON.stringify({ fields: [...form.querySelectorAll('input,select')].map(field => (field as HTMLInputElement).value), body: body?.value, currentState, parent, dependencies: [...dependencies] });
    const initialForm = formValue();
    if (inline) this.startEditing(frame || inline, issue ? '议题属性' : '新建议题', () => formValue() !== initialForm || !!body?.uploading, () => { body?.destroy(); this.creating = undefined; restore?.(); });
    if (frame) { const buttons = el(frame, 'div', 'li-inline-actions'); action(buttons, '取消', () => { this.stopEditing(true); safe(() => this.navigate(project.id)); }); const save = action(buttons, '创建议题', () => safe(async () => { save.disabled = true; try { await saveIssue(); } finally { save.disabled = false; } }), 'mod-cta'); }
    else if (inline) { const buttons = el(inline, 'div', 'li-inline-actions'); action(buttons, '取消', () => { this.stopEditing(true); safe(() => this.draw()); }); const save = action(buttons, '保存', () => safe(async () => { save.disabled = true; try { await saveIssue(); } finally { save.disabled = false; } }), 'mod-cta'); }
    else { this.saveButton(modal!, saveIssue); modal!.open(); } title?.focus();
  }
  private textModal(title: string, value: string, save: (value: string) => Promise<void>) { const modal = this.modal(title); const text = input(modal.contentEl, title, value); this.saveButton(modal, async () => { await save(text.value); modal.close(); }); modal.open(); text.focus(); }
  private modal(title: string) { const modal = new Modal(this.app); modal.modalEl.addClass('li-modal-container'); modal.contentEl.addClass('local-issues', 'li-modal'); modal.titleEl.setText(title); return modal; }
  private saveButton(modal: Modal, run: () => Promise<void>) { const buttons = el(modal.modalEl, 'div', 'li-modal-actions'); action(buttons, '取消', () => modal.close()); const save = action(buttons, '保存', () => safe(async () => { save.disabled = true; try { if (modal.contentEl.querySelector('[data-uploading]')) throw new Error('附件正在保存，请稍后保存'); await run(); } finally { save.disabled = false; } }), 'mod-cta'); }
  private editor(parent: HTMLElement, initial: string, ref: string, sourcePath: string, changed?: (body: string) => void) {
    const container = el(parent, 'div', 'li-editor'); const tools = el(container, 'div', 'li-editor-toolbar');
    const liveContainer = el(container, 'div', 'li-live-editor');
    const preview = el(container, 'div', 'li-editor-preview markdown-rendered'); preview.hidden = true;
    const footer = el(container, 'div', 'li-editor-footer');
    let disposed = false, uploads = 0;
    const view = createLiveMarkdown(this.app, liveContainer, initial, sourcePath, value => changed?.(value));
    const destroy = () => { if (!disposed) { disposed = true; view.destroy(); } };
    this.renderScope.register(destroy);
    const getValue = () => view.state.doc.toString();
    const focus = () => view.focus();
    const insert = (text: string) => { const { from, to } = view.state.selection.main; view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } }); focus(); };
    const write = action(tools, '编写', () => { liveContainer.hidden = false; preview.hidden = true; write.addClass('is-active'); previewButton.removeClass('is-active'); focus(); });
    const previewButton = action(tools, '预览', () => { liveContainer.hidden = true; preview.hidden = false; preview.replaceChildren(); safe(() => MarkdownRenderer.render(this.app, getValue() || '*暂无内容*', preview, sourcePath, this.renderScope)); write.removeClass('is-active'); previewButton.addClass('is-active'); });
    write.addClass('is-active');
    const uploadStatus = el(footer, 'span', 'li-upload-status li-muted'); uploadStatus.setAttribute('aria-live', 'polite');
    const actions = el(footer, 'div', 'li-editor-actions');
    const attach = async (list: File[]) => { uploads++; container.dataset.uploading = 'true'; uploadStatus.textContent = '正在保存附件…'; try { for (const file of list) { const saved = await this.host.store.attach(ref, file.name, new Uint8Array(await file.arrayBuffer())); if (!disposed) insert(`\n${saved.markdown}\n`); } } finally { if (--uploads === 0) { delete container.dataset.uploading; uploadStatus.textContent = ''; } } };
    view.contentDOM.addEventListener('paste', event => { const list = [...(event.clipboardData?.files || [])]; if (!list.length) return; event.preventDefault(); safe(() => attach(list)); }, true);
    container.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); container.addClass('is-dragover'); } }); container.addEventListener('dragleave', () => container.removeClass('is-dragover')); container.addEventListener('drop', event => { container.removeClass('is-dragover'); const list = [...(event.dataTransfer?.files || [])]; if (!list.length) return; event.preventDefault(); safe(() => attach(list)); });
    return { element: container, get value() { return getValue(); }, get uploading() { return uploads > 0; }, actions, focus, destroy, clear: () => { if (!disposed) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }); } };
  }
}
