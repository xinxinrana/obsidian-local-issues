import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { resolve } from 'node:path';

test('mobile bundle works without Node globals/modules and exposes only manual vault workflows', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://mobile.invalid', pretendToBeVisual: true });
  const w = dom.window;
  let height = 874, listeners = 0;
  const viewport = new w.EventTarget();
  Object.defineProperty(viewport, 'height', { get: () => height });
  const add = viewport.addEventListener.bind(viewport), remove = viewport.removeEventListener.bind(viewport);
  viewport.addEventListener = (...args) => { listeners++; add(...args); };
  viewport.removeEventListener = (...args) => { listeners--; remove(...args); };
  Object.defineProperty(w, 'visualViewport', { value: viewport });
  const built = await build({ entryPoints: ['tests/mobile-fixture.ts'], bundle: true, write: false, minify: true, format: 'cjs', platform: 'browser', external: ['node:*'],
    alias: { obsidian: resolve('tests/obsidian-mock.cjs') }, logLevel: 'silent' });
  const module = { exports: {} as any }, requested: string[] = [];
  const context: any = { module, exports: module.exports, require: (id: string) => { requested.push(id); throw new Error('手机不能加载 ' + id); }, console,
    window: w, document: w.document, navigator: w.navigator, crypto: globalThis.crypto, TextEncoder,
    HTMLElement: w.HTMLElement, HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLInputElement: w.HTMLInputElement, HTMLSelectElement: w.HTMLSelectElement,
    HTMLLabelElement: w.HTMLLabelElement, HTMLImageElement: w.HTMLImageElement, Element: w.Element, Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent,
    Window: w.Window, MutationObserver: w.MutationObserver, getComputedStyle: w.getComputedStyle, Uint8Array, ArrayBuffer, URL, URLSearchParams,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask,
  };
  assert.equal('process' in context, false); assert.equal('Buffer' in context, false);
  vm.runInNewContext(built.outputFiles[0].text, context);
  const f = await module.exports.createMobileFixture();
  const wait = async (check: () => boolean | Promise<boolean>) => { for (let n = 0; n < 300; n++) { if (await check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail(f.mock.notices.join(' / ')); };
  const click = (label: string, parent: Element = f.view.contentEl) => { const button = [...parent.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label); assert.ok(button, label); button.click(); };
  try {
    assert.deepEqual(requested, []); assert.equal(f.app.savedData.apiEnabled, true, 'Mobile leaves synchronized desktop preferences intact');
    assert.ok(!f.plugin.commands.some((c: any) => /CLI|Agent|Skill/.test(c.name)));
    await f.plugin.restartApi(); assert.deepEqual(requested, []);
    const { project, issue } = await f.seed();
    assert.equal(f.view.contentEl.querySelectorAll('.li-project-card').length, 2);
    assert.equal(f.view.contentEl.textContent.includes('复制仓库链接'), false);
    assert.equal(project.revision, createHash('sha256').update(f.files.get(project.path)).digest('hex'));
    const search = f.view.contentEl.querySelector('input[aria-label="搜索项目"]'); search.focus(); search.value = '手机';
    await f.view.refresh(); assert.equal(f.view.contentEl.querySelector('input[aria-label="搜索项目"]'), search, 'Sync refresh must not replace an active phone search');
    assert.equal(search.value, '手机'); click('搜索'); await wait(() => f.view.contentEl.querySelectorAll('.li-project-card').length === 1);
    await f.plugin.activate(project.id, issue.id);
    const more = f.view.contentEl.querySelector('[aria-label="Issue 更多操作"]'); more.click();
    assert.deepEqual(Array.from(f.mock.menus.at(-1).items, (i: any) => i.title), ['打开笔记']);
    const properties = f.view.contentEl.querySelector('details.li-mobile-properties'); assert.equal(properties.open, false);
    properties.open = true; await wait(() => properties.open);
    properties.querySelector('[aria-label="修改标签"]').click(); await wait(() => !!properties.querySelector('.li-property-editor'));
    const field = f.view.contentEl.querySelector('.li-property-editor input'); field.value = '手机标签'; field.dispatchEvent(new w.Event('input', { bubbles: true }));
    await wait(() => !!f.view.contentEl.querySelector('.li-mobile-edit-page .li-property-editor'));
    const navigation = f.plugin.activate(project.id);
    await wait(() => f.mock.modals.some((m: any) => m.titleEl.textContent === '放弃未保存的修改？'));
    click('返回编辑', f.mock.modals.at(-1).modalEl); await navigation;
    click('取消', f.view.contentEl.querySelector('.li-mobile-edit-nav'));
    click('编辑', f.view.contentEl.querySelector('.li-description')); await wait(() => !!f.view.contentEl.querySelector('.li-mobile-edit-page .cm-editor'));
    f.setMarkdown(f.view.contentEl.querySelector('.li-mobile-edit-page'), '手机修改的正文 **保留格式**');
    click('保存', f.view.contentEl.querySelector('.li-mobile-edit-nav')); await wait(async () => (await f.plugin.store.getIssue(issue.id)).body.startsWith('手机修改'));
    await wait(() => !f.view.contentEl.querySelector('.li-mobile-edit-page'));
    click('编辑', f.view.contentEl.querySelector('.li-description'));
    await wait(() => !!f.view.contentEl.querySelector('.li-mobile-edit-page .cm-editor'));
    const draftPage = f.view.contentEl.querySelector('.li-mobile-edit-page'); f.setMarkdown(draftPage, '手机尚未保存的修改');
    await f.plugin.store.updateIssue(issue.id, { body: '另一台设备同步的正文' }); await f.view.refresh();
    click('保存', draftPage); await wait(() => f.mock.notices.some((message: string) => message.includes('冲突')));
    assert.equal(f.view.contentEl.querySelector('.li-mobile-edit-page'), draftPage, 'Conflict keeps the focused editor and draft');
    assert.match(draftPage.textContent, /手机尚未保存的修改/); assert.equal((await f.plugin.store.getIssue(issue.id)).body, '另一台设备同步的正文');
    click('取消', draftPage); await wait(() => !f.view.contentEl.querySelector('.li-mobile-edit-page'));
    await wait(() => f.view.contentEl.querySelector('.li-description').textContent.includes('另一台设备同步的正文'));
    assert.equal(f.view.contentEl.querySelector('.li-composer'), null, 'Reading does not instantiate a second editor');
    click('评论', f.view.contentEl.querySelector('.li-mobile-nav'));
    await wait(() => !!f.view.contentEl.querySelector('.li-mobile-edit-page .cm-editor'));
    const composer = f.view.contentEl.querySelector('.li-mobile-edit-page');
    assert.deepEqual([...composer.querySelectorAll('.li-editor-toolbar button')].slice(0, 3).map((b: any) => b.textContent), ['编写', '预览', '附件']);
    f.setMarkdown(composer, '在手机上发表评论。'); click('发表评论', composer);
    await wait(async () => (await f.plugin.store.snapshot()).timeline.some((t: any) => t.body === '在手机上发表评论。'));
    const c = (await f.plugin.store.snapshot()).timeline.find((t: any) => t.body === '在手机上发表评论。');
    await wait(() => !!f.view.contentEl.querySelector(`[data-comment-id="${c.id}"]`));
    click('删除', f.view.contentEl.querySelector(`[data-comment-id="${c.id}"]`)); await wait(() => !!f.mock.modals.at(-1));
    height = 420; viewport.dispatchEvent(new w.Event('resize'));
    assert.equal(f.view.contentEl.style.getPropertyValue('--li-viewport-height'), '420px');
    assert.equal(f.mock.modals.at(-1).modalEl.style.getPropertyValue('--li-viewport-height'), '420px');
    click('确认删除', f.mock.modals.at(-1).modalEl); await wait(async () => !(await f.plugin.store.snapshot()).timeline.some((t: any) => t.id === c.id));
    await wait(() => f.mock.modals.length === 0); assert.equal(listeners, 2);
    await wait(() => !!f.view.contentEl.querySelector('.li-sidebar select'));
    const state = f.view.contentEl.querySelector('.li-sidebar select'); state.value = 'completed'; state.dispatchEvent(new w.Event('change', { bubbles: true }));
    await wait(async () => (await f.plugin.store.getIssue(issue.id)).status === 'closed');
    f.plugin.openSettings(); assert.doesNotMatch(f.mock.modals.at(-1).contentEl.textContent, /Agent|CLI|API|端口|分享/); f.mock.modals.at(-1).close();
    assert.equal(listeners, 2); assert.deepEqual(requested, []);
    await f.close(); assert.equal(listeners, 0);
  } finally { await f.close(); w.close(); }
});
