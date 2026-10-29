import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { fixture } from './api-fixture';

const browser = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Sec-Fetch-Site': 'none' };

test('browser links render projects, default-open lists, filters, board, table and full issue timeline; CLI remains JSON', async () => {
  const f = await fixture();
  try {
    const project = await f.store.createProject({ title: '产品', description: '**本地需求**' });
    const one = await f.store.createIssue(project.id, { title: '开始工作', body: '# 正文\n\n**重点**\n\n- [x] 已完成\n\n| 项目 | 值 |\n| --- | --- |\n| A | B |', labels: ['ux'], milestone: '秋季', assignees: ['我'] });
    const two = await f.store.createIssue(project.id, { title: '已经完成', labels: ['ux'], status: 'closed' });
    await f.store.createIssue(project.id, { title: '别的标签', labels: ['other'] });
    const child = await f.store.createIssue(project.id, { title: '子议题', parent: one.id });
    const comment = await f.store.addComment(one.id, `评论 **加粗** [[${two.path.replace(/\.md$/, '')}|已完成的事项]]\n\n\`[[不应转换]]\``);
    const html = async (path: string) => { const response = await fetch(new URL(path, f.url), { headers: browser }); assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/html/); return new JSDOM(await response.text()).window.document; };
    assert.match((await html('/')).title, /Tests/);
    assert.equal((await html('/')).querySelector('.row .title')?.textContent, '产品');
    const list = await html('/产品/issues?label=ux');
    assert.deepEqual([...list.querySelectorAll('.row .title')].map(a => a.textContent), ['开始工作']);
    assert.equal(list.querySelector('[aria-current=page]')?.textContent, '1 个开启');
    assert.match(list.querySelector('.tabs a:nth-child(2)')!.getAttribute('href')!, /label=ux/);
    assert.deepEqual([...((await html('/产品/issues?label=ux&state=closed')).querySelectorAll('.row .title'))].map(a => a.textContent), ['已经完成']);
    assert.equal((await html('/产品/issues?state=all&view=board')).querySelectorAll('.column').length, 4);
    assert.equal((await html('/产品/issues?state=all&view=table')).querySelectorAll('tbody tr').length, 4);
    assert.equal((await html('/产品/issues?q=重点&state=all')).querySelectorAll('.row').length, 1);
    assert.equal((await html('/产品/issues?q=评论&state=all')).querySelectorAll('.row').length, 1);
    assert.match((await html('/产品/issues?q=missing')).querySelector('.empty')!.textContent!, /没有符合/);
    const doc = await html('/产品/issues/1');
    assert.match(doc.title, /#1 开始工作/);
    assert.equal(doc.querySelector('.markdown strong')?.textContent, '重点');
    assert.ok(doc.querySelector('.markdown input[type=checkbox][disabled][checked]'));
    assert.ok(doc.querySelector('.markdown table'));
    assert.ok(doc.getElementById(comment.id));
    assert.ok([...doc.querySelectorAll('a')].some(a => a.textContent === '子议题' && a.href.endsWith(`/issues/${child.number}`)));
    assert.ok([...doc.querySelectorAll('a')].some(a => a.textContent === '已完成的事项' && a.href.endsWith(`/issues/${two.number}`)));
    assert.equal(doc.querySelector('code')?.textContent, '[[不应转换]]');
    assert.match(doc.querySelector('nav a.button')!.getAttribute('href')!, /^obsidian:\/\/local-issues\?vault=Tests&issue=i-/);
    assert.equal(doc.querySelector('form[data-api]')?.getAttribute('data-method'), 'POST');
    assert.equal((await f.request('/产品/issues/1')).data.issue.id, one.id);
    const explicit = await fetch(`${f.url}/产品/issues/1`, { headers: { Accept: 'text/html;q=0.5,application/json' } });
    assert.match(explicit.headers.get('content-type')!, /application\/json/);
    assert.equal((await f.request('/产品/issues/1', 'PATCH', { title: 'CLI 仍可修改' })).data.title, 'CLI 仍可修改');
    const error = await fetch(`${f.url}/产品/issues/999`, { headers: browser });
    assert.equal(error.status, 404); assert.match(await error.text(), /无法打开此页面/);
  } finally { await f.close(); }
});

test('archived projects leave the working list for a strip that can revive or delete them', async () => {
  const f = await fixture();
  try {
    const live = await f.store.createProject({ title: '进行中', description: '' });
    const gone = await f.store.createProject({ title: '归档了', description: '', status: 'archived' });
    const page = async () => new JSDOM(await (await fetch(new URL('/', f.url), { headers: browser })).text()).window.document;
    const doc = await page();
    assert.deepEqual([...doc.querySelectorAll('.rows > .row .title')].map(a => a.textContent), ['进行中'], '归档项目不在主列表');
    const strip = doc.querySelector('details.archived-projects');
    assert.ok(strip, '归档项目单独成段');
    assert.match(strip!.querySelector('summary')!.textContent!, /已归档 · 1 个项目/);
    assert.equal(strip!.querySelector('.archived-row .title')?.textContent, '归档了');
    assert.equal(strip!.querySelector('[data-project-status]')?.getAttribute('data-project-status'), gone.id, '提供启用入口');
    assert.equal(strip!.querySelector('[data-delete-project]')?.getAttribute('data-delete-project'), gone.id, '提供删除入口');
    await f.request(`/api/projects/${gone.id}`, 'PATCH', { status: 'active' });
    const revived = await page();
    assert.equal(revived.querySelector('details.archived-projects'), null, '启用后归档段消失');
    assert.deepEqual([...revived.querySelectorAll('.rows > .row .title')].map(a => a.textContent).sort(), ['进行中', '归档了'].sort());
    await f.request(`/api/projects/${gone.id}`, 'PATCH', { status: 'archived' });
    const removed = await (await fetch(new URL(`/api/projects/${gone.id}?force=1`, f.url), { method: 'DELETE' })).json();
    assert.equal(removed.data.deleted, true);
    assert.equal((await page()).querySelector('details.archived-projects'), null, '删除后归档段消失');
    assert.ok(live);
  } finally { await f.close(); }
});

test('HTML escapes executable content and legacy shares retain their narrow view', async () => {
  const f = await fixture();
  try {
    const p = await f.store.createProject({ title: 'Demo', description: 'PRIVATE DESCRIPTION' });
    const body = '<script>alert(1)</script>\n\n<img src=x onerror=alert(2)>\n\n[run](javascript:alert%281%29)\n\n[encoded](jav&#x61;script:alert%281%29)\n\n[control](java\tscript:alert)\n\n[raw](data:text/html,attack)\n\n![remote](https://example.com/tracker.png)\n\n[[secret|<img onerror=attack>]]';
    const issue = await f.store.createIssue(p.id, { title: '</title><script>bad()</script>', body, labels: ['<svg/onload=bad()>'], assignees: ['<iframe>'], author: '<script>author</script>' });
    const hidden = await f.store.createIssue(p.id, { title: 'PRIVATE ISSUE', body: 'PRIVATE BODY' });
    await f.store.addComment(hidden.id, 'PRIVATE COMMENT');
    const response = await fetch(`${f.url}/demo/issues/1`, { headers: browser });
    assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const doc = new JSDOM(await response.text()).window.document;
    assert.equal(doc.querySelectorAll('script:not([src="/api/web-client.js"]),iframe,svg,img,[onerror],[onload]').length, 0);
    assert.ok([...doc.querySelectorAll('a')].every(a => !/^(?:javascript|data):/i.test(a.getAttribute('href')!)));
    assert.match(doc.querySelector('h1')!.textContent!, /<script>bad/);
    const share = await f.request('/api/shares', 'POST', { ref: issue.id });
    const shared = await fetch(share.data.url, { headers: browser });
    assert.equal(shared.status, 200);
    const text = await shared.text();
    for (const secret of ['PRIVATE DESCRIPTION', 'PRIVATE ISSUE', 'PRIVATE BODY', 'PRIVATE COMMENT']) assert.equal(text.includes(secret), false);
    // Browsers may read only local pages/attachments; API mutations retain the CLI-only boundary.
    assert.equal((await fetch(`${f.url}/demo`, { headers: { ...browser, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    assert.equal((await fetch(`${f.url}/demo`, { headers: { ...browser, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await f.request('/api/projects', 'POST', { title: 'No' }, { Origin: f.url, 'Sec-Fetch-Site': 'same-origin' })).status, 403);
    assert.equal((await fetch(`${f.url}/demo`, { headers: { ...browser, Origin: 'http://evil.test' } })).status, 403);
  } finally { await f.close(); }
});

test('web images and downloads are bounded to existing attachment references, without arbitrary vault reads', async () => {
  const f = await fixture();
  try {
    const p = await f.store.createProject({ title: 'Demo' });
    const issue = await f.store.createIssue(p.id, { title: 'Images' });
    const other = await f.store.createIssue(p.id, { title: 'Other' });
    const bytes = Buffer.from([137, 80, 78, 71, 0, 10, 42]);
    const image = await f.store.attach(issue.id, '带空格 图片.png', bytes);
    const svg = await f.store.attach(issue.id, 'unsafe.svg', Buffer.from('<svg onload="alert(1)"></svg>'));
    const percent = await f.store.attach(issue.id, '100% 示例.png', bytes);
    await f.store.addComment(issue.id, `${image.markdown}\n\n${svg.markdown}\n\n${percent.markdown}\n\n![Markdown image](${encodeURI(image.path)})`);
    const html = await fetch(`${f.url}/demo/issues/1`, { headers: browser });
    const doc = new JSDOM(await html.text()).window.document;
    const img = doc.querySelector('img')!;
    assert.ok(img); assert.equal(doc.querySelectorAll('img').length, 3);
    const attachment = await fetch(new URL(img.getAttribute('src')!, f.url), { headers: { 'Sec-Fetch-Site': 'same-origin' } });
    assert.equal(attachment.status, 200); assert.equal(attachment.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), bytes);
    for (const img of doc.querySelectorAll('img')) assert.equal((await fetch(new URL(img.getAttribute('src')!, f.url))).status, 200);
    const svgLink = [...doc.querySelectorAll('a')].find(a => a.getAttribute('href')?.includes(encodeURIComponent(svg.path)))!;
    const download = await fetch(new URL(svgLink.getAttribute('href')!, f.url));
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    assert.match(download.headers.get('content-disposition')!, /^attachment/);
    const get = (id: string, path: string, headers = {}) => fetch(`${f.url}/api/attachments?issue=${id}&path=${encodeURIComponent(path)}`, { headers });
    assert.equal((await get(other.id, image.path)).status, 404);
    assert.equal((await get(issue.id, '../.obsidian/data.json')).status, 404);
    assert.equal((await get(issue.id, 'resource/local-issues/../private.md')).status, 404);
    assert.equal((await get(issue.id, issue.path)).status, 404);
    assert.equal((await get(issue.id, image.path, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    await f.store.updateIssue(issue.id, { body: image.markdown });
    assert.equal((await get(issue.id, image.path)).status, 200);
  } finally { await f.close(); }
});
