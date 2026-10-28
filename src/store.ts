import { createHash, randomUUID } from 'node:crypto';
import { parseDocument, Document } from 'yaml';
import type { Issue, IssueInput, IssuePatch, IssueStore, IssueStatus, CloseReason, Project, ProjectInput, ProjectPatch, Resolved, Snapshot, TimelineEntry, VaultAdapter } from './types';

const PROJECT_STATUSES = ['active', 'paused', 'completed', 'archived'];
const ISSUE_STATUSES = ['open', 'in-progress', 'closed'];
const CLOSE_REASONS = ['completed', 'on-hold', 'not-planned'];
const TYPES = ['local-issues/project', 'local-issues/issue', 'local-issues/comment', 'local-issues/event'];
type Metadata = Record<string, unknown>;
interface Parsed { data: Metadata; body: string; doc: Document; }
function safePath(value: string): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').some(p => p === '..' || p === '.' || !p) || /[\0\r\n]/.test(value)) throw new Error('路径必须是笔记库内的相对路径');
  return value;
}
function text(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []; }
function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 500 || /[\r\n\0]/.test(value)) throw new Error('标题不能为空，且必须为不超过 500 字的单行文字');
  return value.trim();
}
function fieldText(value: unknown, name: string): string { if (typeof value !== 'string') throw new Error(`${name} 必须是文本`); return value; }
function fieldList(value: unknown, name: string): string[] { if (!Array.isArray(value) || value.some(x => typeof x !== 'string' || !x.trim())) throw new Error(`${name} 必须是文本数组`); return [...new Set(value.map(x => x.trim()))]; }
function date(value: unknown): string { const s = fieldText(value, '截止日期'); if (s && (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s)) || new Date(s).toISOString().slice(0, 10) !== s)) throw new Error('截止日期格式应为 YYYY-MM-DD'); return s; }
function status<T extends string>(value: unknown, choices: string[]): T { if (typeof value !== 'string' || !choices.includes(value)) throw new Error(`未知状态：${String(value)}`); return value as T; }
function parse(raw: string): Parsed {
  const match = raw.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error('缺少 YAML 属性');
  const doc = parseDocument(match[1], { uniqueKeys: true });
  if (doc.errors.length) throw new Error(doc.errors[0].message);
  const data = doc.toJSON();
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('YAML 属性必须为对象');
  return { data, doc, body: raw.slice(match[0].length).replace(/^\r?\n/, '').replace(/\r?\n$/, '') };
}
function markdown(values: Metadata, body: string, old?: Parsed): string {
  const doc = old?.doc ?? new Document();
  for (const [key, value] of Object.entries(values)) doc.set(key, value);
  return `---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n\n${body.replace(/\s+$/, '')}\n`;
}
function slug(s: string): string { return s.normalize('NFKC').replace(/[\[\]#|\\/:*?"<>\x00-\x1f]/g, '-').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled'; }
function normalizedRef(ref: string): string {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('请提供项目、Issue 或双链');
  let s = ref.trim();
  if (s.startsWith('[[') && s.endsWith(']]')) s = s.slice(2, -2).split('|')[0].split('#')[0];
  return s.replace(/\.md$/i, '').trim();
}
function matchesPath(path: string, ref: string): boolean { const p = path.replace(/\.md$/, ''); return p === ref || p.split('/').pop() === ref; }
/** Project folder is `<title slug>-<id prefix>`; accept both the folder and the stripped slug. */
function matchesProject(project: Project, ref: string): boolean {
  if (project.id === ref || project.title === ref || matchesPath(project.path, ref)) return true;
  const folder = project.path.split('/').slice(-2, -1)[0] ?? '';
  return !!folder && (folder === ref || folder.replace(/-[0-9a-f]{8}$/i, '') === ref);
}
function unique<T>(items: T[], label: string): T { if (!items.length) throw new Error(`找不到${label}`); if (items.length > 1) throw new Error(`${label}不唯一，请使用完整双链或 ID`); return items[0]; }
function revision(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }
function link(path: string): string { return `[[${path.replace(/\.md$/, '')}]]`; }

/** The Vault's Markdown files are authoritative; no hidden database or side index. */
export class Store implements IssueStore {
  readonly root: string;
  private pending: Promise<unknown> = Promise.resolve();
  private lastTimestamp = 0;
  constructor(readonly adapter: VaultAdapter, root = 'Local Issues', public author = '我') { this.root = safePath(root); }
  private now(): string { this.lastTimestamp = Math.max(Date.now(), this.lastTimestamp + 1); return new Date(this.lastTimestamp).toISOString(); }
  private mutate<T>(fn: () => Promise<T>): Promise<T> { const result = this.pending.then(fn); this.pending = result.catch(() => undefined); return result; }
  async snapshot(): Promise<Snapshot> {
    const result: Snapshot = { projects: [], issues: [], timeline: [], warnings: [] };
    const entries = await this.adapter.list();
    for (const path of entries.filter(p => p.startsWith(`${this.root}/`) && p.endsWith('.md')).sort()) {
      try {
        safePath(path);
        const raw = await this.adapter.read(path); const parsed = parse(raw); const d = parsed.data;
        if (!TYPES.includes(text(d.type))) continue;
        if (d.type === 'local-issues/comment' && d.deletedAt) continue;
        if (!text(d.id) || !text(d.createdAt) || !text(d.updatedAt)) throw new Error('缺少 ID 或时间属性');
        const base = { id: text(d.id), createdAt: text(d.createdAt), updatedAt: text(d.updatedAt), path, revision: revision(raw) };
        if (d.type === 'local-issues/project') {
          result.projects.push({ ...base, title: title(d.title), description: parsed.body, status: status(d.status, PROJECT_STATUSES), dueDate: text(d.dueDate) });
        } else if (d.type === 'local-issues/issue') {
          if (!text(d.projectId) || !Number.isInteger(d.number) || Number(d.number) < 1) throw new Error('缺少项目 ID 或有效编号');
          result.issues.push({ ...base, projectId: text(d.projectId), number: Number(d.number), title: title(d.title), body: parsed.body, status: d.status === 'in-progress' ? 'open' : status(d.status, ISSUE_STATUSES), ...(d.status === 'closed' ? { closeReason: d.closeReason ? status<CloseReason>(d.closeReason, CLOSE_REASONS) : 'completed' as const } : {}), labels: strings(d.labels), milestone: text(d.milestone), assignees: strings(d.assignees), parent: text(d.parent), dependencies: strings(d.dependencies), dueDate: text(d.dueDate), author: text(d.author, this.author) });
        } else {
          if (!text(d.issueId)) throw new Error('缺少 Issue ID');
          const kind = d.type === 'local-issues/comment' ? 'comment' : 'event';
          result.timeline.push({ ...base, issueId: text(d.issueId), kind, body: parsed.body, author: text(d.author, this.author), ...(kind === 'event' ? { from: status<IssueStatus>(d.from, ISSUE_STATUSES), to: status<IssueStatus>(d.to, ISSUE_STATUSES) } : {}) });
        }
      } catch (error) { result.warnings.push(`${path}：${error instanceof Error ? error.message : String(error)}`); }
    }
    for (const collection of [result.projects, result.issues, result.timeline]) {
      const seen = new Set<string>();
      for (const entry of collection) { if (seen.has(entry.id)) result.warnings.push(`重复 ID：${entry.id}（${entry.path}）`); seen.add(entry.id); }
    }
    const issueIds = new Set(result.issues.map(x => x.id));
    for (const issue of result.issues) {
      if (issue.parent && !issueIds.has(issue.parent)) issue.parent = this.findRelated(result, issue.parent) ?? issue.parent;
      issue.dependencies = issue.dependencies.map(ref => issueIds.has(ref) ? ref : this.findRelated(result, ref) ?? ref);
      if (!result.projects.some(p => p.id === issue.projectId)) result.warnings.push(`${issue.path}：项目不存在`);
    }
    result.timeline.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    result.projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    result.issues.sort((a, b) => b.number - a.number);
    return result;
  }
  private findRelated(snap: Snapshot, ref: string): string | undefined {
    try { return this.pickIssue(snap, ref).id; } catch { return undefined; }
  }
  private pickProject(snap: Snapshot, ref: string): Project {
    const r = normalizedRef(ref);
    return unique(snap.projects.filter(p => matchesProject(p, r)), '项目');
  }
  private pickIssue(snap: Snapshot, ref: string, project?: string): Issue {
    const r = normalizedRef(ref);
    let items = snap.issues;
    if (project) items = items.filter(i => i.projectId === this.pickProject(snap, project).id);
    const numbered = r.match(/^(.*?)#(\d+)$/);
    if (numbered && numbered[1]) { const p = this.pickProject(snap, numbered[1]); return unique(items.filter(i => i.projectId === p.id && i.number === Number(numbered[2])), 'Issue'); }
    const n = /^#?\d+$/.test(r) ? Number(r.replace('#', '')) : undefined;
    return unique(items.filter(i => i.id === r || matchesPath(i.path, r) || (n !== undefined && i.number === n)), 'Issue');
  }
  async getProject(ref: string): Promise<Project> { return this.pickProject(await this.snapshot(), ref); }
  async getIssue(ref: string, project?: string): Promise<Issue> { return this.pickIssue(await this.snapshot(), ref, project); }
  private conflict(actual: { updatedAt: string; revision?: string }, expected?: string): void { if (expected && actual.updatedAt !== expected && actual.revision !== expected) throw new Error('内容已被修改，请刷新后重试（冲突）'); }
  private projectMeta(p: Project): Metadata { return { type: 'local-issues/project', id: p.id, title: p.title, status: p.status, dueDate: p.dueDate, createdAt: p.createdAt, updatedAt: p.updatedAt }; }
  private issueMeta(i: Issue, snap: Snapshot): Metadata {
    const p = snap.projects.find(p => p.id === i.projectId);
    return { type: 'local-issues/issue', id: i.id, projectId: i.projectId, project: p ? link(p.path) : '', number: i.number, title: i.title, status: i.status, closeReason: i.status === 'closed' ? (i.closeReason || 'completed') : '', labels: i.labels, milestone: i.milestone, assignees: i.assignees, parent: snap.issues.find(x => x.id === i.parent) ? link(snap.issues.find(x => x.id === i.parent)!.path) : i.parent, dependencies: i.dependencies.map(id => { const item = snap.issues.find(x => x.id === id); return item ? link(item.path) : id; }), dueDate: i.dueDate, author: i.author, createdAt: i.createdAt, updatedAt: i.updatedAt };
  }
  async createProject(input: ProjectInput): Promise<Project> {
    return this.mutate(async () => {
      const name = title(input.title); const id = `p-${randomUUID()}`; const time = this.now();
      const value: Project = { id, title: name, description: input.description === undefined ? '' : fieldText(input.description, '描述'), status: input.status === undefined ? 'active' : status(input.status, PROJECT_STATUSES), dueDate: input.dueDate === undefined ? '' : date(input.dueDate), createdAt: time, updatedAt: time, path: `${this.root}/${slug(name)}-${id.slice(2, 10)}/project.md` };
      if ((await this.snapshot()).projects.some(p => p.title === name)) throw new Error('已经存在同名项目');
      const raw = markdown(this.projectMeta(value), value.description);
      await this.adapter.write(value.path, raw); return { ...value, revision: revision(raw) };
    });
  }
  async updateProject(ref: string, patch: ProjectPatch, expectedUpdatedAt?: string): Promise<Project> {
    return this.mutate(async () => {
      const snap = await this.snapshot(); const old = this.pickProject(snap, ref); this.conflict(old, expectedUpdatedAt);
      const next = { ...old, updatedAt: this.now() };
      if (patch.title !== undefined) { next.title = title(patch.title); if (snap.projects.some(p => p.id !== old.id && p.title === next.title)) throw new Error('已经存在同名项目'); }
      if (patch.description !== undefined) next.description = fieldText(patch.description, '描述');
      if (patch.status !== undefined) next.status = status(patch.status, PROJECT_STATUSES);
      if (patch.dueDate !== undefined) next.dueDate = date(patch.dueDate);
      const previousRaw = await this.adapter.read(next.path); this.conflict({ updatedAt: '', revision: revision(previousRaw) }, old.revision);
      const raw = markdown(this.projectMeta(next), next.description, parse(previousRaw));
      await this.adapter.write(next.path, raw, previousRaw); return { ...next, revision: revision(raw) };
    });
  }
  private async issueFields(base: Issue, patch: IssueInput | IssuePatch, snap: Snapshot): Promise<Issue> {
    const i = { ...base };
    if (patch.title !== undefined) i.title = title(patch.title);
    if (patch.body !== undefined) i.body = fieldText(patch.body, '描述');
    if (patch.status !== undefined) { const next = status<IssueStatus>(patch.status, ISSUE_STATUSES); i.status = next === 'in-progress' ? 'open' : next; }
    if (patch.closeReason !== undefined) i.closeReason = status<CloseReason>(patch.closeReason, CLOSE_REASONS);
    if (i.status === 'closed') i.closeReason ||= 'completed'; else delete i.closeReason;
    if (patch.labels !== undefined) i.labels = fieldList(patch.labels, '标签');
    if (patch.assignees !== undefined) i.assignees = fieldList(patch.assignees, '负责人');
    if (patch.milestone !== undefined) i.milestone = fieldText(patch.milestone, '里程碑');
    if (patch.dueDate !== undefined) i.dueDate = date(patch.dueDate);
    if (patch.author !== undefined) i.author = fieldText(patch.author, '作者').trim() || this.author;
    if (patch.parent !== undefined) { const r = fieldText(patch.parent, '父议题'); i.parent = r ? this.pickIssue(snap, r).id : ''; }
    if (patch.dependencies !== undefined) i.dependencies = fieldList(patch.dependencies, '依赖').map(r => this.pickIssue(snap, r).id);
    if (i.parent === i.id || i.dependencies.includes(i.id)) throw new Error('Issue 不能关联自身');
    const all = [...snap.issues.filter(x => x.id !== i.id), i];
    const check = (field: 'parent' | 'dependencies') => {
      const visit = (id: string, visiting: Set<string>, done: Set<string>): void => {
        if (visiting.has(id)) throw new Error(field === 'parent' ? '父子议题不能形成循环' : '依赖不能形成循环');
        if (done.has(id)) return;
        visiting.add(id); const item = all.find(x => x.id === id);
        for (const dep of item ? (field === 'parent' ? [item.parent].filter(Boolean) : item.dependencies) : []) visit(dep, visiting, done);
        visiting.delete(id); done.add(id);
      }; visit(i.id, new Set(), new Set());
    }; check('parent'); check('dependencies'); return i;
  }
  async createIssue(project: string, input: IssueInput): Promise<Issue> {
    return this.mutate(async () => {
      const snap = await this.snapshot(); const p = this.pickProject(snap, project); const id = `i-${randomUUID()}`; const time = this.now();
      const number = Math.max(0, ...snap.issues.filter(i => i.projectId === p.id).map(i => i.number)) + 1;
      const base: Issue = { id, projectId: p.id, number, title: title(input.title), body: '', status: 'open', labels: [], milestone: '', assignees: [], parent: '', dependencies: [], dueDate: '', author: this.author, createdAt: time, updatedAt: time, path: `${p.path.slice(0, p.path.lastIndexOf('/'))}/issues/${String(number).padStart(4, '0')}-${slug(title(input.title))}-${id.slice(2, 10)}.md` };
      const value = await this.issueFields(base, input, snap);
      const raw = markdown(this.issueMeta(value, snap), value.body);
      await this.adapter.write(value.path, raw); return { ...value, revision: revision(raw) };
    });
  }
  async updateIssue(ref: string, patch: IssuePatch, expectedUpdatedAt?: string): Promise<Issue> {
    return this.mutate(async () => {
      const snap = await this.snapshot(); const old = this.pickIssue(snap, ref); this.conflict(old, expectedUpdatedAt);
      const actor = patch.actor === undefined ? this.author : fieldText(patch.actor, '操作者').trim() || this.author;
      const value = await this.issueFields({ ...old, updatedAt: this.now() }, patch, snap);
      const previousRaw = await this.adapter.read(old.path); this.conflict({ updatedAt: '', revision: revision(previousRaw) }, old.revision);
      const raw = markdown(this.issueMeta(value, snap), value.body, parse(previousRaw));
      await this.adapter.write(value.path, raw, previousRaw);
      if (value.status !== old.status || value.closeReason !== old.closeReason) await this.writeTimeline(value, 'event', value.status === 'closed' ? `关闭了此 Issue（${({ completed: '完成', 'on-hold': '搁置', 'not-planned': '不做' } as const)[value.closeReason || 'completed']}）` : '重新打开了此 Issue', actor, { from: old.status, to: value.status });
      return { ...value, revision: revision(raw) };
    });
  }
  private async writeTimeline(issue: Issue, kind: 'comment' | 'event', body: string, author: string, event: Metadata = {}): Promise<TimelineEntry> {
    const id = `${kind === 'comment' ? 'c' : 'e'}-${randomUUID()}`; const time = this.now();
    const path = `${issue.path.slice(0, issue.path.lastIndexOf('/issues/'))}/timeline/${issue.id}/${id}.md`;
    const value: TimelineEntry = { id, issueId: issue.id, kind, body, author, createdAt: time, updatedAt: time, path, ...(event as { from?: IssueStatus; to?: IssueStatus }) };
    const raw = markdown({ type: `local-issues/${kind}`, id, issueId: issue.id, issue: link(issue.path), author, createdAt: time, updatedAt: time, ...event }, body);
    await this.adapter.write(path, raw); return { ...value, revision: revision(raw) };
  }
  async addComment(ref: string, body: string, author = this.author): Promise<TimelineEntry> {
    return this.mutate(async () => {
      if (!fieldText(body, '评论').trim()) throw new Error('评论不能为空');
      return this.writeTimeline(this.pickIssue(await this.snapshot(), ref), 'comment', body, fieldText(author, '作者').trim() || this.author);
    });
  }
  async editComment(id: string, body: string, expectedUpdatedAt?: string): Promise<TimelineEntry> {
    return this.mutate(async () => {
      if (!fieldText(body, '评论').trim()) throw new Error('评论不能为空');
      const old = unique((await this.snapshot()).timeline.filter(c => c.id === id && c.kind === 'comment'), '评论'); this.conflict(old, expectedUpdatedAt);
      const value = { ...old, body, updatedAt: this.now() };
      const previousRaw = await this.adapter.read(value.path); this.conflict({ updatedAt: '', revision: revision(previousRaw) }, old.revision);
      const raw = markdown({ updatedAt: value.updatedAt }, body, parse(previousRaw));
      await this.adapter.write(value.path, raw, previousRaw); return { ...value, revision: revision(raw) };
    });
  }
  async deleteComment(id: string, expectedUpdatedAt?: string): Promise<void> {
    await this.mutate(async () => {
      const old = unique((await this.snapshot()).timeline.filter(c => c.id === id && c.kind === 'comment'), '评论'); this.conflict(old, expectedUpdatedAt);
      const previousRaw = await this.adapter.read(old.path); this.conflict({ updatedAt: '', revision: revision(previousRaw) }, old.revision);
      const raw = markdown({ deletedAt: this.now() }, old.body, parse(previousRaw));
      await this.adapter.write(old.path, raw, previousRaw);
    });
  }
  async attach(ref: string, name: string, data: Uint8Array): Promise<{ path: string; markdown: string }> {
    return this.mutate(async () => {
      const snap = await this.snapshot();
      try { this.pickIssue(snap, ref); } catch { this.pickProject(snap, ref); }
      if (typeof name !== 'string' || !name.trim() || /[\\/\0\r\n]/.test(name) || name === '.' || name === '..') throw new Error('附件文件名无效');
      if (!(data instanceof Uint8Array) || !data.length || data.length > 50 * 1024 * 1024) throw new Error('附件必须为 1 字节至 50 MB');
      const clean = name.replace(/[\[\]#|:*?"<>]/g, '-').slice(-150);
      const path = safePath(`resource/local-issues/${randomUUID().slice(0, 8)}-${clean}`);
      await this.adapter.writeBinary(path, data);
      const image = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(clean);
      return { path, markdown: `${image ? '!' : ''}[[${path}]]` };
    });
  }
  async resolve(ref: string): Promise<Resolved> {
    const r = normalizedRef(ref); const snap = await this.snapshot();
    const issues = snap.issues.filter(i => i.id === r || matchesPath(i.path, r));
    const projects = snap.projects.filter(p => matchesProject(p, r));
    if (issues.length + projects.length > 1) throw new Error('链接不唯一，请使用完整路径或 ID');
    if (issues.length) return { kind: 'issue', value: issues[0] };
    if (projects.length) return { kind: 'project', value: projects[0] };
    if (r.includes('#') || /^\d+$/.test(r)) return { kind: 'issue', value: this.pickIssue(snap, r) };
    safePath(r);
    const path = unique((await this.adapter.list()).filter(p => p.endsWith('.md') && matchesPath(p, r)), '笔记');
    return { kind: 'note', path, body: await this.adapter.read(path) };
  }
}
