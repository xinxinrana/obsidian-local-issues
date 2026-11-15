import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store';
import type { VaultAdapter } from '../src/types';

class Memory implements VaultAdapter {
  files = new Map<string, string>();
  binary = new Map<string, Uint8Array>();
  async list() { return [...this.files.keys()]; }
  async exists(path: string) { return this.files.has(path) || this.binary.has(path) || [...this.files.keys()].some(p => p.startsWith(path + '/')); }
  async read(path: string) { if (!this.files.has(path)) throw new Error('missing'); return this.files.get(path)!; }
  async write(path: string, content: string) { this.files.set(path, content); }
  async rename(path: string, destination: string) {
    if (await this.exists(destination)) throw new Error('目标已存在');
    for (const [key, value] of [...this.files]) if (key === path || key.startsWith(path + '/')) { this.files.set(destination + key.slice(path.length), value); this.files.delete(key); }
  }
  async writeBinary(path: string, data: Uint8Array) { this.binary.set(path, data); }
  async removeFolder(path: string) {
    for (const key of [...this.files.keys()]) if (key.startsWith(`${path}/`)) this.files.delete(key);
    for (const key of [...this.binary.keys()]) if (key.startsWith(`${path}/`)) this.binary.delete(key);
  }
}
function setup() { const adapter = new Memory(); return { adapter, store: new Store(adapter) }; }

test('issue deletion hides its timeline, preserves records and children, checks conflicts and never reuses numbers', async () => {
  const { adapter, store } = setup();
  const project = await store.createProject({ title: '删除议题' });
  const issue = await store.createIssue(project.id, { title: '原议题', body: '原正文' });
  const child = await store.createIssue(project.id, { title: '子议题', parent: issue.id, dependencies: [issue.id] });
  const comment = await store.addComment(issue.id, '原评论');
  const changed = await store.updateIssue(issue.id, { body: '更新正文' });
  await assert.rejects(store.deleteIssue(issue.id, issue.revision), /冲突/);
  await store.deleteIssue(issue.id, changed.revision);
  const snap = await new Store(adapter).snapshot();
  assert.deepEqual(snap.issues.map(i => i.id), [child.id]);
  assert.equal(snap.timeline.length, 0); assert.equal(snap.issues[0].parent, ''); assert.deepEqual(snap.issues[0].dependencies, []);
  assert.match(adapter.files.get(issue.path)!, /deletedAt:/); assert.match(adapter.files.get(issue.path)!, /更新正文/);
  assert.match(adapter.files.get(comment.path)!, /原评论/);
  await assert.rejects(store.getIssue(issue.id), /找不到/);
  await assert.rejects(store.addComment(issue.id, '不能复活已删除议题'), /找不到/);
  await store.deleteIssue(child.id);
  assert.equal((await store.createIssue(project.id, { title: '新议题' })).number, 3);
});

test('moving issues preserves identity, comments, attachments, metadata, relations and old references across reconstruction', async () => {
  const { adapter, store } = setup();
  const source = await store.createProject({ title: '来源' }), target = await store.createProject({ title: '目标' });
  await store.createIssue(target.id, { title: '已有议题' });
  const parent = await store.createIssue(source.id, { title: '待移动', body: '正文', labels: ['P1'], milestone: '下一步' });
  const attachment = await store.attach(parent.id, '截图.png', new Uint8Array([137, 80]));
  await store.updateIssue(parent.id, { body: '正文 ' + attachment.markdown, status: 'closed', closeReason: 'on-hold' });
  const child = await store.createIssue(source.id, { title: '关联', parent: parent.id, dependencies: [parent.id] });
  const comment = await store.addComment(parent.id, '保留评论');
  const deleted = await store.addComment(parent.id, '已删评论'); await store.deleteComment(deleted.id);
  adapter.files.set(parent.path, adapter.files.get(parent.path)!.replace('labels:', '# 用户注释\ncustom: keep\nlabels:'));
  await assert.rejects(store.moveIssue(parent.id, target.id, parent.revision), /冲突/);
  const current = await store.getIssue(parent.id);
  const moved = await store.moveIssue(parent.id, target.id, current.revision);
  assert.equal(moved.id, parent.id); assert.equal(moved.projectId, target.id); assert.equal(moved.number, 2);
  assert.equal(moved.body, current.body); assert.deepEqual(moved.labels, ['P1']); assert.equal(moved.milestone, '下一步'); assert.equal(moved.closeReason, 'on-hold');
  assert.equal(adapter.files.has(parent.path), false); assert.match(adapter.files.get(moved.path)!, /custom: keep/); assert.match(adapter.files.get(moved.path)!, /# 用户注释/);
  const fresh = new Store(adapter), snap = await fresh.snapshot();
  assert.equal((await fresh.getIssue(parent.path)).id, parent.id);
  assert.equal((await fresh.getIssue('来源#1')).id, parent.id);
  assert.equal((await fresh.getIssue('1', source.id)).id, parent.id);
  assert.equal((await fresh.resolve(`[[${parent.path}|旧链接]]`)).kind, 'issue');
  assert.equal((await fresh.getIssue(child.id)).parent, parent.id); assert.deepEqual((await fresh.getIssue(child.id)).dependencies, [parent.id]);
  assert.equal(snap.timeline.find(t => t.id === comment.id)?.issueId, parent.id);
  assert.ok(snap.timeline.filter(t => t.issueId === parent.id).every(t => t.path.startsWith(target.path.slice(0, -'project.md'.length))));
  assert.equal(adapter.files.has(deleted.path), false, '已删除的评论记录也随目录移动');
  assert.ok(adapter.binary.has(attachment.path));
  assert.equal((await fresh.createIssue(source.id, { title: '原项目的新议题' })).number, 3);
  await fresh.deleteProject(source.id, true);
  assert.equal((await fresh.getIssue(parent.id)).body, current.body);
  assert.equal((await fresh.snapshot()).timeline.find(t => t.id === comment.id)?.body, '保留评论');
});

test('a failed file move rolls back the metadata and comment folder', async () => {
  const { adapter, store } = setup();
  const source = await store.createProject({ title: 'A' }), target = await store.createProject({ title: 'B' });
  const issue = await store.createIssue(source.id, { title: '保留' }); const comment = await store.addComment(issue.id, '评论');
  const before = adapter.files.get(issue.path);
  const rename = adapter.rename.bind(adapter);
  adapter.rename = async (from, to) => { if (from === issue.path) throw new Error('移动失败'); return rename(from, to); };
  await assert.rejects(store.moveIssue(issue.id, target.id), /移动失败/);
  assert.equal(adapter.files.get(issue.path), before); assert.ok(adapter.files.has(comment.path));
  assert.equal((await new Store(adapter).getIssue(issue.id)).projectId, source.id);
});

test('comment deletion checks revisions and preserves a recoverable Markdown record', async () => {
  const { adapter, store } = setup();
  const project = await store.createProject({ title: '删除评论' });
  const issue = await store.createIssue(project.id, { title: '讨论' });
  const comment = await store.addComment(issue.id, '原评论 ![[image.png]]');
  const changed = await store.editComment(comment.id, '更新后的评论');
  await assert.rejects(store.deleteComment(comment.id, comment.revision), /冲突/);
  assert.equal((await store.snapshot()).timeline.length, 1);
  await store.deleteComment(comment.id, changed.revision);
  assert.equal((await new Store(adapter).snapshot()).timeline.length, 0);
  assert.match(adapter.files.get(comment.path)!, /deletedAt:/);
  assert.match(adapter.files.get(comment.path)!, /更新后的评论/);
  await assert.rejects(store.editComment(comment.id, '覆盖已删除评论'), /找不到评论/);
  await store.updateIssue(issue.id, { status: 'closed' });
  const event = (await store.snapshot()).timeline[0];
  await assert.rejects(store.deleteComment(event.id), /找不到评论/);
});

test('comment editing can correct the author and preserves it when omitted', async () => {
  const { adapter, store } = setup();
  const project = await store.createProject({ title: '评论作者' });
  const issue = await store.createIssue(project.id, { title: '讨论' });
  const comment = await store.addComment(issue.id, '原评论', 'Agent');
  const corrected = await store.editComment(comment.id, '更正作者', undefined, 'WorkBuddy');
  assert.equal(corrected.author, 'WorkBuddy');
  assert.match(adapter.files.get(comment.path)!, /author: WorkBuddy/);
  const edited = await store.editComment(comment.id, '只改正文', corrected.revision);
  assert.equal(edited.author, 'WorkBuddy');
  assert.equal((await new Store(adapter).snapshot()).timeline[0].author, 'WorkBuddy');
});

test('project / issue / multiple comments / close and reopen roundtrip remains readable Markdown', async () => {
  const { adapter, store } = setup();
  const p = await store.createProject({ title: '本地项目', description: '项目正文 [[知识库]]', dueDate: '2026-12-31' });
  const i = await store.createIssue(p.id, { title: '支持 Markdown', body: '**说明**\n\n[[知识库]]', labels: ['功能'], assignees: ['Evan'] });
  const first = await store.addComment(i.id, '人的评论 ![[resource/example.png]]');
  const second = await store.addComment(i.id, 'Agent 的评论', 'Agent');
  await store.updateIssue(i.id, { status: 'closed' });
  await store.updateIssue(i.id, { status: 'open' });
  await store.editComment(first.id, '修改后的评论');
  const snap = await store.snapshot();
  assert.equal(snap.projects[0].description, '项目正文 [[知识库]]');
  assert.equal(snap.issues[0].body, '**说明**\n\n[[知识库]]');
  assert.deepEqual(snap.timeline.map(x => x.kind), ['comment', 'comment', 'event', 'event']);
  assert.equal(snap.timeline[0].body, '修改后的评论');
  assert.equal(snap.timeline[1].id, second.id);
  assert.deepEqual(snap.timeline.slice(2).map(x => [x.from, x.to]), [['open', 'closed'], ['closed', 'open']]);
  assert.equal(snap.warnings.length, 0);
  assert.match(adapter.files.get(i.path)!, /project:.*\[\[/);
  assert.match(i.path, /0001-支持-Markdown-[a-f0-9]+\.md$/);
  assert.match(adapter.files.get(first.path)!, /issue:.*\[\[/);
  assert.ok(!adapter.files.has('data.json'));
});

test('concurrent issue creation allocates unique numbers, separately per project', async () => {
  const { store } = setup();
  const a = await store.createProject({ title: 'A' }); const b = await store.createProject({ title: 'B' });
  const created = await Promise.all(Array.from({ length: 12 }, (_, n) => store.createIssue(a.id, { title: `Issue ${n}` })));
  assert.deepEqual(created.map(i => i.number), Array.from({ length: 12 }, (_, n) => n + 1));
  assert.equal((await store.createIssue(b.id, { title: 'Another' })).number, 1);
  await assert.rejects(store.getIssue('1'), /不唯一/);
  assert.equal((await store.getIssue('1', 'A')).id, created[0].id);
  assert.equal((await store.getIssue('A#1')).id, created[0].id);
});

test('native double links, alias, note links and stable ids resolve with explicit ambiguity', async () => {
  const { store, adapter } = setup();
  const p = await store.createProject({ title: '项目 A' }); const i = await store.createIssue(p.id, { title: 'Title' });
  assert.equal((await store.getIssue(`[[${i.path.replace(/\.md$/, '')}|#1 Title]]`)).id, i.id);
  assert.equal((await store.resolve(`[[${p.path}|项目名称]]`)).kind, 'project');
  assert.equal((await store.resolve(i.id)).kind, 'issue');
  adapter.files.set('知识库/参考.md', '# 普通笔记\n\n正文');
  const resolved = await store.resolve('[[参考#标题|别名]]');
  assert.deepEqual(resolved, { kind: 'note', path: '知识库/参考.md', body: '# 普通笔记\n\n正文' });
  adapter.files.set('其他/参考.md', '同名笔记');
  await assert.rejects(store.resolve('[[参考]]'), /不唯一/);
  assert.equal((await store.resolve('[[知识库/参考]]')).kind, 'note');
});

test('manual edits are read immediately, unknown YAML values and comments survive mutations', async () => {
  const { store, adapter } = setup();
  const p = await store.createProject({ title: 'A' }); const i = await store.createIssue(p.id, { title: 'Before', body: 'before' });
  adapter.files.set(i.path, adapter.files.get(i.path)!.replace('title: Before', 'title: After\n# 用户自己的注释\ncustom: keep').replace('\nbefore\n', '\n手动编辑正文\n'));
  assert.equal((await store.getIssue(i.id)).title, 'After');
  assert.equal((await store.getIssue(i.id)).body, '手动编辑正文');
  await store.updateIssue(i.id, { labels: ['manual'] });
  assert.match(adapter.files.get(i.path)!, /custom: keep/);
  assert.match(adapter.files.get(i.path)!, /# 用户自己的注释/);
  assert.equal((await store.getIssue(i.id)).body, '手动编辑正文');
});

test('expectedUpdatedAt rejects stale edits for issues, projects and comments', async () => {
  const { store } = setup();
  const p = await store.createProject({ title: 'A' }); const i = await store.createIssue(p.id, { title: 'Issue' }); const c = await store.addComment(i.id, 'initial');
  await store.updateIssue(i.id, { body: 'new' }, i.updatedAt);
  await assert.rejects(store.updateIssue(i.id, { body: 'stale' }, i.updatedAt), /冲突/);
  await store.updateProject(p.id, { description: 'new' }, p.updatedAt);
  await assert.rejects(store.updateProject(p.id, { description: 'stale' }, p.updatedAt), /冲突/);
  await store.editComment(c.id, 'new', c.updatedAt);
  await assert.rejects(store.editComment(c.id, 'stale', c.updatedAt), /冲突/);
  assert.equal((await store.getIssue(i.id)).body, 'new');
});

test('parent links and cross-project dependencies persist as wikilinks; cycles are rejected', async () => {
  const { store, adapter } = setup();
  const p = await store.createProject({ title: 'A' }); const p2 = await store.createProject({ title: 'B' });
  const a = await store.createIssue(p.id, { title: 'Parent' }); const b = await store.createIssue(p.id, { title: 'Child', parent: a.id });
  const dep = await store.createIssue(p2.id, { title: 'Cross project', dependencies: [b.id] });
  assert.equal((await store.getIssue(b.id)).parent, a.id);
  assert.deepEqual((await store.getIssue(dep.id)).dependencies, [b.id]);
  assert.match(adapter.files.get(b.path)!, /parent:.*\[\[/);
  assert.match(adapter.files.get(dep.path)!, /dependencies:\n\s+-.*\[\[/);
  await assert.rejects(store.updateIssue(a.id, { parent: b.id }), /循环/);
  await assert.rejects(store.updateIssue(b.id, { dependencies: [dep.id] }), /循环/);
  await assert.rejects(store.updateIssue(a.id, { parent: a.id }), /自身/);
  await assert.rejects(store.updateIssue(a.id, { dependencies: ['unknown'] }), /找不到/);
});

test('attachments are bounded to resource, pasted images embed, ordinary files link, and project drafts can attach', async () => {
  const { store, adapter } = setup();
  const p = await store.createProject({ title: 'A' }); const i = await store.createIssue(p.id, { title: 'I' });
  const png = await store.attach(i.id, '截图.png', new Uint8Array([1, 2]));
  const pdf = await store.attach(p.id, 'report.pdf', new Uint8Array([3]));
  assert.match(png.path, /^resource\/local-issues\/[^/]+-截图\.png$/);
  assert.equal(png.markdown, `![[${png.path}]]`); assert.equal(pdf.markdown, `[[${pdf.path}]]`);
  assert.deepEqual([...adapter.binary.get(png.path)!], [1, 2]);
  for (const bad of ['../secret', '/etc/passwd', 'folder\\name', '..', 'bad\nname']) await assert.rejects(store.attach(i.id, bad, new Uint8Array([1])), /文件名/);
  await assert.rejects(store.attach(i.id, 'empty.png', new Uint8Array()), /附件/);
});

test('input validation, path traversal and malformed notes fail safely without breaking valid projects', async () => {
  const { store, adapter } = setup();
  assert.throws(() => new Store(adapter, '../outside'), /路径/);
  await assert.rejects(store.createProject({ title: '' }), /标题/);
  const p = await store.createProject({ title: 'A' });
  await assert.rejects(store.createProject({ title: 'A' }), /同名/);
  await assert.rejects(store.createIssue(p.id, { title: 'Bad', status: 'garbage' as any }), /未知状态/);
  await assert.rejects(store.createIssue(p.id, { title: 'Bad', dueDate: '2026-02-30' }), /截止日期/);
  await assert.rejects(store.createIssue(p.id, { title: 'Bad', labels: 'label' as any }), /数组/);
  adapter.files.set('Local Issues/broken.md', '---\ntype: local-issues/issue\nid: [\n---\nBroken');
  const snap = await store.snapshot(); assert.equal(snap.projects.length, 1); assert.equal(snap.warnings.length, 1);
  await assert.rejects(store.resolve('[[../../secret]]'), /路径/);
  await assert.rejects(store.resolve('/etc/passwd'), /路径/);
});

test('revision detects direct Markdown edits even when frontmatter time stays unchanged', async () => {
  const { store, adapter } = setup();
  const p = await store.createProject({ title: 'A', description: 'project before' });
  const i = await store.createIssue(p.id, { title: 'I', body: 'issue before' });
  const c = await store.addComment(i.id, 'comment before');
  assert.ok(p.revision && i.revision && c.revision);
  adapter.files.set(i.path, adapter.files.get(i.path)!.replace('issue before', 'human edit'));
  await assert.rejects(store.updateIssue(i.id, { body: 'stale UI' }, i.revision), /冲突/);
  adapter.files.set(p.path, adapter.files.get(p.path)!.replace('project before', 'human project'));
  await assert.rejects(store.updateProject(p.id, { description: 'stale UI' }, p.revision), /冲突/);
  adapter.files.set(c.path, adapter.files.get(c.path)!.replace('comment before', 'human comment'));
  await assert.rejects(store.editComment(c.id, 'stale UI', c.revision), /冲突/);
  assert.equal((await store.getIssue(i.id)).body, 'human edit');
  const fresh = await store.getIssue(i.id); const updated = await store.updateIssue(i.id, { body: 'fresh UI' }, fresh.revision);
  assert.ok(updated.revision !== fresh.revision);
});

test('unknown manually authored dependency references survive unrelated edits', async () => {
  const { store, adapter } = setup();
  const p = await store.createProject({ title: 'A' }); const i = await store.createIssue(p.id, { title: 'I' });
  adapter.files.set(i.path, adapter.files.get(i.path)!.replace('dependencies: []', 'dependencies:\n  - "[[暂未建立的依赖]]"'));
  await store.updateIssue(i.id, { labels: ['keep'] });
  assert.deepEqual((await store.getIssue(i.id)).dependencies, ['[[暂未建立的依赖]]']);
});

test('Agent state actor is recorded in history without changing the original issue author', async () => {
  const { store } = setup();
  const p = await store.createProject({ title: 'A' });
  const i = await store.createIssue(p.id, { title: 'I', author: 'Evan' });
  await store.updateIssue(i.id, { status: 'closed', actor: 'Coding Agent' });
  assert.equal((await store.getIssue(i.id)).author, 'Evan');
  assert.equal((await store.snapshot()).timeline[0].author, 'Coding Agent');
  store.author = '新用户';
  await store.updateIssue(i.id, { status: 'open' });
  assert.equal((await store.snapshot()).timeline[1].author, '新用户');
});

test('atomic adapter compare rejects a disk edit injected between final read and write', async () => {
  class CompareMemory extends Memory {
    inject?: { path: string; before: string; after: string };
    override async write(path: string, content: string, expectedRaw?: string) {
      if (expectedRaw !== undefined && this.inject?.path === path) {
        this.files.set(path, this.files.get(path)!.replace(this.inject.before, this.inject.after));
        this.inject = undefined;
      }
      if (expectedRaw !== undefined && this.files.get(path) !== expectedRaw) throw new Error('原文已经变化（冲突）');
      await super.write(path, content);
    }
  }
  const adapter = new CompareMemory(), store = new Store(adapter);
  const p = await store.createProject({ title: 'A', description: 'project original' });
  const i = await store.createIssue(p.id, { title: 'I', body: 'issue original' });
  const c = await store.addComment(i.id, 'comment original');
  adapter.inject = { path: p.path, before: 'project original', after: 'project external' };
  await assert.rejects(store.updateProject(p.id, { description: 'project UI' }, p.revision), /冲突/);
  assert.equal((await store.getProject(p.id)).description, 'project external');
  adapter.inject = { path: i.path, before: 'issue original', after: 'issue external' };
  await assert.rejects(store.updateIssue(i.id, { body: 'issue UI', status: 'closed' }, i.revision), /冲突/);
  assert.equal((await store.getIssue(i.id)).body, 'issue external');
  assert.equal((await store.getIssue(i.id)).status, 'open');
  assert.equal((await store.snapshot()).timeline.filter(x => x.kind === 'event').length, 0);
  adapter.inject = { path: c.path, before: 'comment original', after: 'comment external' };
  await assert.rejects(store.editComment(c.id, 'comment UI', c.revision), /冲突/);
  assert.equal((await store.snapshot()).timeline.find(x => x.id === c.id)!.body, 'comment external');
});


test('closed reasons persist, reopen clears the reason and legacy statuses remain readable', async () => {
  const { store, adapter } = setup(); const p = await store.createProject({ title: '项目' }); const i = await store.createIssue(p.id, { title: '议题' });
  adapter.files.set(i.path, adapter.files.get(i.path)!.replace('status: open', 'status: in-progress'));
  assert.equal((await store.getIssue(i.id)).status, 'open');
  for (const reason of ['completed', 'on-hold', 'not-planned'] as const) {
    await store.updateIssue(i.id, { status: 'closed', closeReason: reason });
    assert.equal((await store.getIssue(i.id)).closeReason, reason);
    assert.match(adapter.files.get(i.path)!, new RegExp(`closeReason: "?${reason}"?`));
  }
  await store.updateIssue(i.id, { status: 'open' }); assert.equal((await store.getIssue(i.id)).closeReason, undefined);
  await store.updateIssue(i.id, { status: 'closed' }); assert.equal((await store.getIssue(i.id)).closeReason, 'completed');
  await assert.rejects(store.updateIssue(i.id, { closeReason: 'invalid' as any }), /未知状态/);
  adapter.files.set(i.path, adapter.files.get(i.path)!.replace(/closeReason: "?completed"?\n/, ''));
  assert.equal((await store.getIssue(i.id)).closeReason, 'completed');
});

test('project deletion needs force while issues remain and clears the folder', async () => {
  const { adapter, store } = setup();
  const empty = await store.createProject({ title: '空项目' });
  const removed = await store.deleteProject(empty.id);
  assert.equal(removed.issues, 0);
  assert.equal(adapter.files.size, 0, 'the project folder is gone');
  const busy = await store.createProject({ title: '非空项目' });
  await store.createIssue(busy.id, { title: '议题' });
  await assert.rejects(() => store.deleteProject(busy.id), /还有 1 条议题/);
  assert.equal((await store.snapshot()).projects.length, 1, 'a refused delete leaves the project alone');
  const forced = await store.deleteProject(busy.id, true);
  assert.equal(forced.issues, 1);
  assert.equal((await store.snapshot()).projects.length, 0);
  assert.equal(adapter.files.size, 0);
});
