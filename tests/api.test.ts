import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { fixture } from './api-fixture';

test('API uses Markdown store for project → issue → comments, edits and state history', async () => {
  const f = await fixture();
  try {
    const project = await f.request('/api/projects', 'POST', { title: '网站', description: '[[设计稿]]' });
    assert.equal(project.status, 201);
    const issue = await f.request('/api/issues', 'POST', { project: project.data.id, title: '图片', body: '# 需求', labels: ['功能'], author: '测试Agent' });
    assert.equal(issue.status, 201);
    const id = issue.data.id;
    const comment = await f.request(`/api/issues/${id}/comments`, 'POST', { body: '第一条 **评论** [[设计稿]]', author: 'Agent A' });
    const second = await f.request(`/api/issues/${id}/comments`, 'POST', { body: '第二条评论' });
    assert.equal(second.status, 201);
    assert.equal((await f.request(`/api/comments/${comment.data.id}`, 'PATCH', { body: '修改后的评论' })).data.body, '修改后的评论');
    const closed = await f.request(`/api/issues/${id}/close`, 'POST', { closeReason: 'on-hold' }); assert.equal(closed.data.status, 'closed'); assert.equal(closed.data.closeReason, 'on-hold');
    assert.equal((await f.request(`/api/issues/${id}/reopen`, 'POST')).data.status, 'open');
    const detail = await f.request(`/api/issues/${id}`);
    assert.equal(detail.data.comments.length, 2);
    assert.deepEqual(detail.data.timeline.filter((x: any) => x.kind === 'event').map((x: any) => x.to), ['closed', 'open']);
    assert.equal(detail.data.issue.author, '测试Agent');
    const files = await f.adapter.list();
    assert.equal(files.filter(p => p.endsWith('.md')).length, 6);
    const link = `[[${issue.data.path.replace(/\.md$/, '')}|别名]]`;
    assert.equal((await f.request(`/api/resolve?ref=${encodeURIComponent(link)}`)).data.issue.id, id);
    assert.equal((await f.request(`/api/issues/1?project=${project.data.id}`)).data.issue.id, id);
    assert.equal((await f.request(`/api/issues/${id}`, 'PATCH', { body: '覆盖' }, { 'If-Match': 'old-revision' })).status, 409);
    assert.equal((await f.request(`/api/issues/${id}`)).data.issue.body, '# 需求');
    assert.equal((await f.request(`/api/comments/${second.data.id}`, 'DELETE', {}, { 'If-Match': 'stale' })).status, 409);
    assert.equal((await f.request(`/api/comments/${second.data.id}`, 'DELETE')).data.deleted, true);
    assert.equal((await f.request(`/api/issues/${id}`)).data.comments.length, 1);
  } finally { await f.close(); }
});

test('API loopback Host, browser rejection and legacy target routes', async () => {
  const f = await fixture();
  try {
    const health = await fetch(`${f.url}/api/health`); assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, data: { name: 'Local Issues', version: '0.2.4' } });
    assert.equal((await fetch(`${f.url}/api/projects`)).status, 200);
    const invalidHost = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(`${f.url}/api/projects`, { headers: { Host: 'evil.test' } }, res => { res.resume(); resolve(res.statusCode!); }); req.on('error', reject); req.end();
    });
    assert.equal(invalidHost, 403);
    const doomed = await f.store.createProject({ title: '待删除项目' });
    await f.store.createIssue(doomed.id, { title: '里面还有议题' });
    const refused = await f.request(`/api/projects/${doomed.id}`, 'DELETE');
    assert.equal(refused.status, 400, 'a non-empty project needs force');
    assert.match(refused.error!.message, /还有 1 条议题/);
    assert.equal((await f.request(`/api/projects/${doomed.id}`, 'GET')).status, 200, 'the refused delete keeps the project');
    const forced = await f.request(`/api/projects/${doomed.id}?force=1`, 'DELETE');
    assert.equal(forced.status, 200);
    assert.equal(forced.data.deleted, true); assert.equal(forced.data.issues, 1);
    assert.equal((await f.request(`/api/projects/${doomed.id}`, 'GET')).status, 404, 'the project is gone afterwards');
    assert.equal((await f.request('/api/projects', 'GET', undefined, { Origin: 'http://evil.test' })).status, 403);
    const project = await f.store.createProject({ title: 'Only project', description: 'PRIVATE PROJECT DESCRIPTION' });
    const one = await f.store.createIssue(project.id, { title: 'Shared' });
    const two = await f.store.createIssue(project.id, { title: 'Private' });
    const elsewhere = await f.store.createProject({ title: 'Elsewhere' });
    const dependency = await f.store.createIssue(elsewhere.id, { title: 'Dependency', body: 'CROSS PROJECT SECRET' });
    await f.store.updateIssue(one.id, { dependencies: [dependency.id] });
    const privateComment = await f.store.addComment(two.id, 'PRIVATE COMMENT');
    const share = await f.request('/api/shares', 'POST', { ref: one.id });
    assert.equal(share.status, 201);
    const response = await fetch(share.data.url); const shared: any = await response.json();
    assert.equal(shared.data.issue.id, one.id); assert.equal(JSON.stringify(shared).includes(two.id), false);
    assert.equal(JSON.stringify(shared).includes('PRIVATE PROJECT DESCRIPTION'), false);
    assert.equal(JSON.stringify(shared).includes('CROSS PROJECT SECRET'), false);
    const withoutKey = new URL(share.data.url); withoutKey.search = '';
    assert.equal((await fetch(withoutKey)).status, 200);
    const changed = await fetch(share.data.url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Shared edited', id: two.id }) });
    assert.equal(changed.status, 200); assert.equal((await f.store.getIssue(one.id)).title, 'Shared edited'); assert.equal((await f.store.getIssue(two.id)).title, 'Private');
    const commentUrl = new URL(share.data.url); commentUrl.pathname = commentUrl.pathname.replace(/resolve$/, 'comments');
    const commentResponse = await fetch(commentUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Scoped comment' }) });
    assert.equal(commentResponse.status, 201); const ownComment: any = await commentResponse.json();
    const ownEdit = new URL(commentUrl); ownEdit.pathname += `/${ownComment.data.id}`;
    assert.equal((await fetch(ownEdit, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Scoped edited comment' }) })).status, 200);
    const foreignEdit = new URL(commentUrl); foreignEdit.pathname += `/${privateComment.id}`;
    assert.equal((await fetch(foreignEdit, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: 'Attack' }) })).status, 403);
    assert.equal((await f.store.snapshot()).timeline.find(t => t.id === privateComment.id)?.body, 'PRIVATE COMMENT');
    const global = new URL(share.data.url); global.pathname = '/api/issues';
    assert.equal((await fetch(global)).status, 200);
    const invalid = new URL(share.data.url); invalid.pathname = invalid.pathname.replace('/resolve', '/issues');
    assert.equal((await fetch(invalid)).status, 404);
  } finally { await f.close(); }
});

test('API filtering, attachment persistence and invalid input', async () => {
  const f = await fixture();
  try {
    const project = await f.store.createProject({ title: 'A' });
    const issue = await f.store.createIssue(project.id, { title: 'Picture', body: 'target text', status: 'in-progress', labels: ['ux'], assignees: ['Evan'], milestone: 'Launch' });
    await f.store.createIssue(project.id, { title: 'Other', status: 'closed' });
    const filtered = await f.request(`/api/issues?project=${project.id}&state=open&label=ux&assignee=Evan&milestone=Launch&search=target`);
    assert.deepEqual(filtered.data.map((i: any) => i.id), [issue.id]);
    await f.store.addComment(issue.id, 'Unique comment keyword');
    assert.deepEqual((await f.request(`/api/issues?search=Unique%20comment`)).data.map((i: any) => i.id), [issue.id]);
    const bytes = Buffer.from([137, 80, 78, 71, 0, 10, 42]);
    const attach = await f.request(`/api/issues/${issue.id}/attachments`, 'POST', { name: 'screen.png', base64: bytes.toString('base64') });
    assert.equal(attach.status, 201); assert.match(attach.data.markdown, /^!\[\[resource\/local-issues\//);
    assert.equal(await f.adapter.exists(attach.data.path), true);
    assert.equal((await f.request(`/api/issues/${issue.id}/attachments`, 'POST', { name: 'screen.png', base64: '@bad' })).status, 400);
    assert.equal((await f.request('/api/issues', 'POST', { project: project.id, title: 123 })).status, 400);
    const raw = await fetch(`${f.url}/api/issues`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
    assert.equal(raw.status, 400);
    assert.equal((await f.request('/api/does-not-exist')).status, 404);
  } finally { await f.close(); }
});

test('semantic resource URLs identify repo, project, list and issue without credentials and keep stable routes', async () => {
  const f = await fixture();
  try {
    const p = await f.store.createProject({ title: 'Local Issues' });
    const one = await f.store.createIssue(p.id, { title: 'One', labels: ['bug'] });
    const link = (await f.request(`/api/links?ref=${one.id}`)).data.url;
    assert.equal(link, `${f.url.replace('127.0.0.1', 'localhost')}/local-issues/issues/1`);
    assert.equal(new URL(link).search, '');
    const oldLink = `${f.url}/repos/tests/projects/local-issues/issues/1`;
    assert.equal((await f.request(oldLink)).data.issue.id, one.id);
    assert.equal((await f.request(f.url + '/')).data.kind, 'repo');
    const other = await f.store.createProject({ title: 'Local-Issues' });
    const two = await f.store.createIssue(other.id, { title: 'Other project' });
    assert.equal((await fetch(link)).status, 200);
    assert.equal((await f.request(link)).data.issue.id, one.id);
    const listUrl = link.replace('/issues/1', '/issues');
    // A query cannot redirect a project route to another project's issues.
    const list = await f.request(`${listUrl}?state=open&label=bug&project=${other.id}`);
    assert.deepEqual(list.data.map((i: any) => i.id), [one.id]);
    const projectUrl = link.replace('/issues/1', '');
    assert.equal((await f.request(projectUrl)).data.project.id, p.id);
    assert.equal((await f.request(`${f.url}/repos/tests`)).data.projects.length, 2);
    assert.match((await f.request(`/api/links?ref=${two.id}`)).data.url, /\/local-issues-2\/issues\/1$/);
    await f.store.updateProject(p.id, { title: 'Renamed project' });
    assert.equal((await f.request(link)).data.issue.id, one.id);
    assert.equal((await f.request(`/api/links?ref=${one.id}`)).data.url, link);
    assert.equal((await f.request(link, 'PATCH', { title: 'Edited', actor: 'Agent' })).data.title, 'Edited');
    assert.equal((await f.request(`${link}/comments`, 'POST', { body: 'Via semantic URL' })).status, 201);
    assert.equal((await f.request(`${link}/close`, 'POST')).data.status, 'closed');
    assert.equal((await f.request(`${f.url}/repos/wrong/projects/local-issues/issues/1`)).status, 404);
    assert.equal((await f.request(`${projectUrl}/issues/999`)).status, 404);
    assert.equal((await f.request(`${projectUrl}/issues/0`)).status, 400);
    const reserved = await f.store.createProject({ title: 'API' });
    assert.match((await f.request(`/api/links?ref=${reserved.id}`)).data.url, /\/api-project$/);
    const chinese = await f.store.createProject({ title: '产品 / 设计 #方案' });
    const chineseUrl = (await f.request(`/api/links?ref=${chinese.id}`)).data.url;
    assert.match(chineseUrl, /产品-设计-方案/);
    assert.equal((await f.request(chineseUrl)).data.project.id, chinese.id);
  } finally { await f.close(); }
});

test('agent docs bootstrap a skill without hard-coded agent directories', async () => {
  const f = await fixture();
  try {
    const skill = (await f.request('/api/skill')).data as string;
    assert.match(skill, /^---\nname: local-issues\n/);
    assert.ok(skill.includes(`local-issues view 'http://localhost:${new URL(f.url).port}/项目/issues/5'`), 'skill uses the running origin');
    assert.match(skill, /## 查[\s\S]*## 改[\s\S]*## 兜底/);
    assert.match(skill, /标签写重要性和类别[\s\S]*里程碑/, 'skill states the label/milestone convention');
    const guide = await (await fetch(`${f.url}/llms.txt`)).text();
    assert.match(guide, /## 给 Agent：保存这份 skill/);
    assert.match(guide, /local-issues skill/);
    assert.ok(guide.includes(`http://localhost:${new URL(f.url).port}/api/cli.mjs`), 'guide points at the downloadable CLI');
    assert.doesNotMatch(guide, /\.claude|\.codex|\.pi\//, 'never hard-code another agent skill directory');

    const p = await f.store.createProject({ title: 'Slug 项目' });
    const folder = p.path.split('/').slice(-2, -1)[0]!;
    assert.equal((await f.request(`/api/projects/${encodeURIComponent(folder)}`)).data.project.id, p.id);
    const slugOfUrl = decodeURIComponent(new URL((await f.request(`/api/links?ref=${p.id}`)).data.url).pathname.split('/').filter(Boolean)[0]!);
    await f.store.createIssue(p.id, { title: '跨项目同号' });
    const crossProject = await f.request('/api/issues?state=all');
    assert.equal(crossProject.status, 200);
    assert.equal(crossProject.data[0].project, 'Slug 项目', 'issues carry their project name for cross-project lists');
    assert.equal((await f.request(`/api/issues?project=${encodeURIComponent(slugOfUrl)}`)).status, 200);
    assert.equal((await f.request(`/api/issues?project=${encodeURIComponent(folder)}`)).status, 200);
  } finally { await f.close(); }
});
