import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JSDOM } from 'jsdom';
import { fixture } from './api-fixture';

const browser = { Accept: 'text/html', 'Sec-Fetch-Site': 'none' };
async function waitFor(check: () => boolean, message = 'operation did not complete'): Promise<void> {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(message);
}
async function page(f: Awaited<ReturnType<typeof fixture>>, path: string) {
  const response = await fetch(new URL(path, f.url), { headers: browser });
  assert.equal(response.status, 200);
  const dom = new JSDOM(await response.text(), { url: new URL(path, f.url).href, runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window, doc = w.document, destinations: string[] = [], confirmations: string[] = [];
  let accept = true, writes = 0, failNext = false, pause: Promise<void> | undefined;
  const services = { navigate: (url: string) => { destinations.push(url); }, request: async (path: string, options: RequestInit = {}) => {
    if (options.method !== 'GET') { writes++; if (pause) await pause; }
    if (failNext) { failNext = false; throw new w.Error('模拟网络中断'); }
    return fetch(new URL(path, f.url), { ...options, headers: { ...options.headers, Origin: f.url, 'Sec-Fetch-Site': 'same-origin' } });
  } };
  Object.assign(w, { __services: services, AbortController, CSS: { escape: (value: string) => value.replace(/[^\w-]/g, '\\$&') } });
  w.confirm = message => { confirmations.push(message || ''); return accept; };
  const script = await fetch(`${f.url}/api/web-client.js`, { headers: { 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(script.status, 200);
  // Execute the exact client served by the API, including the production function serialization.
  w.eval((await script.text()).replace(/\)\(\);$/, ')(window.__services);'));
  function click(selector: string) { const el = doc.querySelector<HTMLElement>(selector); assert.ok(el, selector); el.click(); }
  function edit(selector: string) { click(selector); const form = doc.querySelector<HTMLFormElement>('.editing form[data-api]'); assert.ok(form, selector); return form; }
  function set(form: Element, name: string, value: string) {
    const control = form.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[name="${name}"]`); assert.ok(control, name);
    control.value = value; control.dispatchEvent(new w.Event('input', { bubbles: true }));
  }
  function submit(form: HTMLFormElement) { form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); }
  return { w, doc, destinations, confirmations, click, edit, set, submit, get writes() { return writes; }, set accept(value: boolean) { accept = value; }, fail() { failNext = true; }, pause(value?: Promise<void>) { pause = value; }, close() { dom.window.close(); } };
}

test('served web client creates projects/issues, edits in place, previews and posts/edits/deletes comments against the Markdown store', async () => {
  const f = await fixture(); let p: Awaited<ReturnType<typeof page>> | undefined;
  try {
    p = await page(f, '/');
    let form = p.edit('[data-edit]'); p.set(form, 'title', '网页项目'); p.set(form, 'description', '**网页描述**'); p.submit(form);
    await waitFor(() => p!.destinations.length === 1);
    let snapshot = await f.store.snapshot(); const project = snapshot.projects[0];
    assert.equal(project.title, '网页项目'); assert.equal(project.description, '**网页描述**'); p.close();
    p = await page(f, '/网页项目');
    const create = [...p.doc.querySelectorAll<HTMLButtonElement>('[data-edit]')].find(button => button.textContent === '新建 Issue')!;
    form = p.edit(`[data-edit="${create.dataset.edit}"]`);
    p.set(form, 'title', '网页创建议题'); p.set(form, 'body', '初始 **正文**'); p.set(form, 'labels', '功能, ux'); p.set(form, 'milestone', 'v2'); p.set(form, 'assignees', '我, 同事');
    p.submit(form); await waitFor(() => p!.destinations.length === 1);
    snapshot = await f.store.snapshot(); const issue = snapshot.issues[0];
    assert.equal(issue.body, '初始 **正文**'); assert.deepEqual(issue.labels, ['功能', 'ux']); assert.equal(issue.author, '我'); p.close();
    p = await page(f, '/网页项目/issues/1');
    form = p.edit('[data-edit="issue-body"]'); p.set(form, 'body', '修改 **正文**');
    const preview = form.querySelector<HTMLElement>('[data-tab=preview]')!; preview.click();
    await waitFor(() => !form.querySelector<HTMLElement>('[data-preview]')!.hidden);
    assert.equal(form.querySelector('[data-preview] strong')?.textContent, '正文');
    form.querySelector<HTMLElement>('[data-tab=write]')!.click();
    assert.equal(form.querySelector<HTMLTextAreaElement>('textarea')!.hidden, false);
    p.submit(form); p.submit(form); await waitFor(() => p!.destinations.length === 1);
    assert.equal((await f.store.getIssue(issue.id)).body, '修改 **正文**'); assert.equal(p.writes, 2); // preview + one save
    p.close(); p = await page(f, '/网页项目/issues/1');
    form = p.doc.querySelector<HTMLFormElement>(`form[data-api="/api/issues/${issue.id}/comments"]`)!;
    p.set(form, 'body', '网页评论'); p.submit(form); p.submit(form); await waitFor(() => p!.destinations.length === 1);
    const comments = (await f.store.snapshot()).timeline.filter(t => t.kind === 'comment'); assert.equal(comments.length, 1); p.close();
    p = await page(f, '/网页项目/issues/1');
    form = p.edit(`[data-edit="edit-${comments[0].id}"]`); p.set(form, 'body', '修改后的评论'); p.submit(form); await waitFor(() => p!.destinations.length === 1);
    assert.equal((await f.store.snapshot()).timeline.find(t => t.id === comments[0].id)?.body, '修改后的评论'); p.close();
    p = await page(f, '/网页项目/issues/1'); p.accept = false; p.click('[data-delete]'); assert.equal(p.writes, 0);
    p.accept = true; p.click('[data-delete]'); p.click('[data-delete]'); await waitFor(() => p!.destinations.length === 1);
    assert.equal((await f.store.snapshot()).timeline.filter(t => t.kind === 'comment').length, 0);
    assert.equal(p.writes, 1); assert.match(p.confirmations.at(-1)!, /确定删除/);
    assert.match(await f.adapter.read(issue.path), /修改 \*\*正文\*\*/);
  } finally { p?.close(); await f.close(); }
});

test('web drafts confirm switching and navigation, failures preserve drafts, conflicts never overwrite newer content', async () => {
  const f = await fixture(); let p: Awaited<ReturnType<typeof page>> | undefined;
  try {
    const project = await f.store.createProject({ title: 'Demo' });
    const issue = await f.store.createIssue(project.id, { title: 'One', body: 'Original' });
    const comment = await f.store.addComment(issue.id, 'Comment');
    p = await page(f, '/demo/issues/1');
    let form = p.edit('[data-edit="issue-body"]'); p.set(form, 'body', 'Draft');
    const unload = new p.w.Event('beforeunload', { cancelable: true }); p.w.dispatchEvent(unload); assert.equal(unload.defaultPrevented, true);
    p.accept = false; p.click(`[data-edit="edit-${comment.id}"]`); assert.equal(p.doc.querySelector('.editing form'), form);
    const anchor = p.doc.querySelector('nav a')!; const event = new p.w.MouseEvent('click', { bubbles: true, cancelable: true });
    anchor.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
    p.accept = true; p.click(`[data-edit="edit-${comment.id}"]`);
    form = p.doc.querySelector<HTMLFormElement>('.editing form')!; assert.equal(form.querySelector('textarea')?.value, 'Comment');
    p.set(form, 'body', 'Comment draft'); p.fail(); p.submit(form);
    await waitFor(() => !!form.querySelector('[role=alert]')); assert.match(form.querySelector('[role=alert]')!.textContent!, /网络中断/);
    assert.equal(form.querySelector('textarea')?.value, 'Comment draft'); assert.equal(form.querySelector('button[type=submit]')?.hasAttribute('disabled'), false);
    await f.store.editComment(comment.id, 'Changed elsewhere'); p.submit(form);
    await waitFor(() => /冲突|已被|已修改/.test(form.querySelector('[role=alert]')?.textContent || ''));
    assert.equal((await f.store.snapshot()).timeline.find(t => t.id === comment.id)?.body, 'Changed elsewhere');
    assert.equal(form.querySelector('textarea')?.value, 'Comment draft'); assert.equal(p.destinations.length, 0);
    p.click('[data-cancel]'); assert.equal(p.doc.querySelector('.editing'), null);
    form = p.edit('[data-edit="issue-body"]'); p.set(form, 'body', 'Save once');
    let resume!: () => void; const gate = new Promise<void>(resolve => resume = resolve); p.pause(gate);
    p.submit(form); assert.equal(form.querySelector('textarea')?.disabled, true); p.submit(form); resume();
    await waitFor(() => p!.destinations.length === 1); assert.equal((await f.store.getIssue(issue.id)).body, 'Save once');
  } finally { p?.close(); await f.close(); }
});

test('side properties, relations, cycle errors, close reasons and reopen work from browser controls', async () => {
  const f = await fixture(); let p: Awaited<ReturnType<typeof page>> | undefined;
  try {
    const project = await f.store.createProject({ title: 'Demo' });
    const issue = await f.store.createIssue(project.id, { title: 'One', labels: ['old'] });
    const parent = await f.store.createIssue(project.id, { title: 'Parent' });
    const child = await f.store.createIssue(project.id, { title: 'Child', parent: issue.id });
    for (const [field, value] of [['title', 'New title'], ['labels', 'ux, bug'], ['milestone', 'v3'], ['assignees', 'Alice, Bob'], ['dueDate', '2026-11-30'], ['parent', parent.id]]) {
      p?.close(); p = await page(f, '/demo/issues/1');
      const button = [...p.doc.querySelectorAll<HTMLButtonElement>(field === 'title' ? '[data-edit]' : 'aside [data-edit]')].find(button => (p!.doc.getElementById(button.dataset.edit!) as HTMLTemplateElement).content.querySelector(`[name="${field}"]`));
      assert.ok(button); let form = p.edit(`[data-edit="${button.dataset.edit}"]`); p.set(form, field, value); p.submit(form); await waitFor(() => p!.destinations.length === 1);
    }
    let updated = await f.store.getIssue(issue.id); assert.equal(updated.title, 'New title'); assert.deepEqual(updated.labels, ['ux', 'bug']); assert.equal(updated.parent, parent.id); assert.deepEqual(updated.assignees, ['Alice', 'Bob']);
    p!.close(); p = await page(f, '/demo/issues/1');
    let button = [...p.doc.querySelectorAll<HTMLButtonElement>('aside [data-edit]')].find(button => (p!.doc.getElementById(button.dataset.edit!) as HTMLTemplateElement).content.querySelector('[data-relations]'))!;
    let form = p.edit(`[data-edit="${button.dataset.edit}"]`);
    let select = form.querySelector<HTMLSelectElement>('[data-relations] select')!; select.value = parent.id; form.querySelector<HTMLElement>('[data-add-relation]')!.click(); p.submit(form); await waitFor(() => p!.destinations.length === 1);
    assert.deepEqual((await f.store.getIssue(issue.id)).dependencies, [parent.id]);
    p.close(); p = await page(f, '/demo/issues/1');
    button = [...p.doc.querySelectorAll<HTMLButtonElement>('aside [data-edit]')].find(button => (p!.doc.getElementById(button.dataset.edit!) as HTMLTemplateElement).content.querySelector('[name=parent]'))!;
    form = p.edit(`[data-edit="${button.dataset.edit}"]`); p.set(form, 'parent', child.id); p.submit(form); await waitFor(() => !!form.querySelector('[role=alert]'));
    assert.equal((await f.store.getIssue(issue.id)).parent, parent.id); assert.match(form.querySelector('[role=alert]')!.textContent!, /循环|自身/);
    p.close();
    for (const reason of ['completed', 'on-hold', 'not-planned', 'open']) {
      p = await page(f, '/demo/issues/1'); const select = p.doc.querySelector<HTMLSelectElement>('aside [data-status]')!;
      select.value = reason; select.dispatchEvent(new p.w.Event('change', { bubbles: true })); await waitFor(() => p!.destinations.length === 1);
      updated = await f.store.getIssue(issue.id); assert.equal(updated.status, reason === 'open' ? 'open' : 'closed'); assert.equal(updated.closeReason, reason === 'open' ? undefined : reason); p.close();
    }
  } finally { p?.close(); await f.close(); }
});

test('uploads from paste/drop preview before saving; project drafts and persisted descriptions share attachments', async () => {
  const f = await fixture(); let p: Awaited<ReturnType<typeof page>> | undefined;
  try {
    const project = await f.store.createProject({ title: 'Demo' });
    const issue = await f.store.createIssue(project.id, { title: 'One' });
    p = await page(f, '/demo/issues/1'); const form = p.edit('[data-edit="issue-body"]');
    const textarea = form.querySelector('textarea')!;
    const file = new p.w.File([new Uint8Array([137, 80, 78, 71, 10])], '截图.png', { type: 'image/png' });
    const paste = new p.w.Event('paste', { bubbles: true, cancelable: true }); Object.defineProperty(paste, 'clipboardData', { value: { files: [file] } }); textarea.dispatchEvent(paste);
    await waitFor(() => textarea.value.includes('resource/local-issues/'));
    form.querySelector<HTMLElement>('[data-tab=preview]')!.click(); await waitFor(() => !!form.querySelector('[data-preview] img'));
    const src = form.querySelector('img')!.getAttribute('src')!; assert.equal((await fetch(new URL(src, f.url))).status, 200);
    const stolen = new URL(src, f.url); stolen.searchParams.set('ref', project.id); assert.equal((await fetch(stolen)).status, 404);
    p.submit(form); await waitFor(() => p!.destinations.length === 1); assert.match((await f.store.getIssue(issue.id)).body, /!\[\[resource/); p.close();
    p = await page(f, '/demo'); const button = [...p.doc.querySelectorAll<HTMLButtonElement>('[data-edit]')].find(b => b.textContent === '编辑项目')!;
    const edit = p.edit(`[data-edit="${button.dataset.edit}"]`); const description = edit.querySelector('textarea')!;
    const drop = new p.w.Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { files: [new p.w.File(['a,b\n1,2'], '数据.csv')] } }); description.dispatchEvent(drop);
    await waitFor(() => description.value.includes('resource/local-issues/')); p.submit(edit); await waitFor(() => p!.destinations.length === 1);
    assert.match((await f.store.getProject(project.id)).description, /数据.csv/);
  } finally { p?.close(); await f.close(); }
});

test('bulk selection respects current results, partial failures stay selected, filters omit empty values and board drop changes state', async () => {
  const f = await fixture(); let p: Awaited<ReturnType<typeof page>> | undefined;
  try {
    const project = await f.store.createProject({ title: 'Demo' });
    const one = await f.store.createIssue(project.id, { title: 'One', labels: ['ux'] });
    const two = await f.store.createIssue(project.id, { title: 'Two', labels: ['ux'] });
    const hidden = await f.store.createIssue(project.id, { title: 'Hidden' });
    p = await page(f, '/demo/issues?label=ux');
    const all = p.doc.querySelector<HTMLInputElement>('[data-select-all]')!; all.checked = true; all.dispatchEvent(new p.w.Event('change', { bubbles: true }));
    const milestone = p.doc.querySelector<HTMLInputElement>('[data-batch-value=milestone]')!; milestone.value = 'Release';
    await f.store.updateIssue(two.id, { title: 'External' }); p.click('[data-batch-action=milestone]');
    await waitFor(() => !!p!.doc.querySelector('[data-batch] [role=alert]'));
    assert.equal((await f.store.getIssue(one.id)).milestone, 'Release'); assert.equal((await f.store.getIssue(two.id)).milestone, ''); assert.equal((await f.store.getIssue(hidden.id)).milestone, '');
    assert.deepEqual([...p.doc.querySelectorAll<HTMLInputElement>('[data-select-issue]:checked')].map(c => c.dataset.selectIssue), [two.id]); assert.equal(p.destinations.length, 0);
    p.click('[data-refresh-selected]'); await waitFor(() => /已读取/.test(p!.doc.querySelector('[data-batch] [role=status]')?.textContent || ''));
    p.click('[data-batch-action=milestone]'); await waitFor(() => p!.destinations.length === 1); assert.equal((await f.store.getIssue(two.id)).milestone, 'Release');
    p.close(); p = await page(f, '/demo/issues?state=all&view=board');
    const row = p.doc.querySelector(`[data-drag-issue="${one.id}"]`)!; const column = p.doc.querySelector('[data-drop-status=on-hold]')!;
    const drop = new p.w.Event('drop', { bubbles: true, cancelable: true }); Object.defineProperty(drop, 'dataTransfer', { value: { files: [], getData: () => row.getAttribute('data-drag-issue') } }); column.dispatchEvent(drop);
    await waitFor(() => p!.destinations.length === 1); assert.equal((await f.store.getIssue(one.id)).closeReason, 'on-hold'); p.close();
    p = await page(f, '/demo/issues'); const search = p.doc.querySelector<HTMLFormElement>('form[method=get]')!;
    p.set(search, 'q', 'One'); p.submit(search); assert.equal(p.destinations[0], '/demo/issues?q=One&state=open&view=list&sort=updated');
  } finally { p?.close(); await f.close(); }
});

test('same-origin JSON writes require browser intent; CLI download and llms discovery are self-contained', async () => {
  const f = await fixture();
  try {
    const valid = { Origin: f.url, 'Sec-Fetch-Site': 'same-origin', 'X-Local-Issues': 'web' };
    const created = await f.request('/api/projects', 'POST', { title: 'Web' }, valid); assert.equal(created.status, 201);
    for (const headers of [{ ...valid, Origin: 'http://evil.test' }, { ...valid, 'Sec-Fetch-Site': 'cross-site' }, { Origin: f.url, 'Sec-Fetch-Site': 'same-origin' }]) {
      assert.equal((await f.request('/api/projects', 'POST', { title: 'Attack' }, headers)).status, 403);
    }
    const preview = await f.request('/api/preview', 'POST', { body: '<img onerror=x> **safe**', ref: created.data.id }, valid);
    assert.match(preview.data.html, /<strong>safe<\/strong>/); assert.equal(new JSDOM(preview.data.html).window.document.querySelector('[onerror]'), null);
    const llms = await fetch(`${f.url}/llms.txt`); assert.equal(llms.status, 200); assert.match(await llms.text(), /\/api\/cli.mjs/);
    const cli = await fetch(`${f.url}/api/cli.mjs`, { headers: { 'Sec-Fetch-Site': 'same-origin' } }); assert.equal(cli.status, 200); assert.match(cli.headers.get('content-disposition')!, /attachment/);
    const path = join(f.vault, 'downloaded-cli.mjs'); await writeFile(path, await cli.text());
    const { stdout } = await promisify(execFile)(process.execPath, [path, '--url', f.url, 'view', f.url, '--json']); assert.equal(JSON.parse(stdout).projects[0].id, created.data.id);
    assert.equal(await readFile(path, 'utf8'), await readFile('cli.mjs', 'utf8'));
  } finally { await f.close(); }
});
