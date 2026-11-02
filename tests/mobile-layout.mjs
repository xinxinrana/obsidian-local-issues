import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { webkit } from 'playwright';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

const output = await mkdtemp(join(tmpdir(), 'local-issues-mobile-layout-'));
const bundle = await build({ entryPoints: ['tests/mobile-fixture.ts'], write: false, bundle: true, minify: true,
  platform: 'browser', format: 'iife', globalName: 'MobileFixture', external: ['node:*'],
  alias: { obsidian: resolve('tests/obsidian-mock.cjs') }, logLevel: 'silent' });
const css = await readFile('styles.css', 'utf8');
const theme = `:root{--background-primary:#fff;--background-secondary:#f7f7f9;--background-modifier-border:#dedee5;--background-modifier-hover:#f2eff8;--text-normal:#27232f;--text-muted:#696370;--text-error:#bf3030;--text-accent:#8154c6;--interactive-accent:#8154c6;--color-green:#258256;--color-purple:#8154c6;--color-orange:#a66a14;--font-interface:system-ui;--font-ui-medium:15px;--font-ui-small:13px;--font-ui-smaller:12px;--radius-m:8px;--radius-s:4px}*{box-sizing:border-box}html,body{margin:0;height:100%;width:100%;font-family:system-ui}body{padding-top:96px}.test-host-top{position:fixed;inset:0 0 auto;height:96px;padding:32px 16px 12px;background:#f7f7f9;border-bottom:1px solid #dedee5;font-weight:600}.test-host-bottom{position:fixed;bottom:16px;left:32px;right:32px;height:54px;display:grid;place-items:center;border:1px solid #dedee5;border-radius:28px;background:#ffffffec;pointer-events:none;color:#696370;font-size:13px}button,input,select,textarea{font:inherit;max-width:100%}button{border:0;border-radius:6px;background:#eeedf1;padding:6px 10px;color:inherit}button.mod-cta{background:#8154c6;color:#fff}input,select{border:1px solid #dedee5;background:white;border-radius:6px;padding:5px 8px}.workspace-leaf-content{height:calc(100dvh - 96px);width:100%;min-width:0;display:flex;flex-direction:column}.view-content{flex:1;min-width:0;min-height:0}.modal-container{position:fixed;inset:0;background:#0005;display:flex;align-items:center;justify-content:center;z-index:20}.modal{padding:16px;background:white;border-radius:12px}.modal-content{margin:0}.modal-title{font-size:20px;font-weight:600}.setting-item{display:flex;justify-content:space-between;padding-block:12px;border-bottom:1px solid #dedee5}.setting-item>div{min-width:0}.setting-item-description{font-size:13px;color:#696370}svg{width:16px;height:16px}`;
const browser = await webkit.launch({ headless: true });
let activePage;
try {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage(), errors = [];
  activePage = page; page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${theme}\n${css}</style><body><div class="test-host-top">Local Issues · Obsidian</div><div class="test-host-bottom">Obsidian 导航栏</div></body>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(async () => { window.fixture = await MobileFixture.createMobileFixture(); window.sample = await fixture.seed(); for (let n = 0; n < 12; n++) await fixture.plugin.store.createProject({ title: `示例项目 ${n + 1}`, description: '日常计划、想法和进度。' }); await fixture.view.refresh(); });
  const fits = async name => {
    const size = await page.evaluate(() => { const pane = document.querySelector('.view-content'); const shell = document.querySelector('.li-mobile-page'); return { page: document.documentElement.scrollWidth, viewport: innerWidth, pane: pane.clientWidth, content: pane.scrollWidth, pageHeight: document.documentElement.scrollHeight, height: innerHeight, outerHeight: pane.scrollHeight, outerAvailable: pane.clientHeight, bottom: shell.getBoundingClientRect().bottom, visibleBottom: visualViewport.height + visualViewport.offsetTop }; });
    assert.ok(size.page <= size.viewport + 1 && size.content <= size.pane + 1 && size.pageHeight <= size.height + 1 && size.outerHeight <= size.outerAvailable + 1 && size.bottom <= size.visibleBottom + 1, `${name}: ${JSON.stringify(size)}`);
  };
  const editPage = page.locator('.li-mobile-edit-page');
  const chrome = page.locator('.li-mobile-nav');
  const navButtonVisible = async label => {
    const button = page.locator('.li-mobile-edit-nav').getByRole('button', { name: label, exact: true });
    const bounds = await button.boundingBox();
    const bottom = await page.evaluate(() => visualViewport.height + visualViewport.offsetTop);
    assert.ok(bounds && bounds.y >= 96 && bounds.y + bounds.height <= bottom, `${label} 必须始终可见，无需先滚动`);
    return button;
  };
  const setMode = async value => {
    await page.locator('.li-mobile-search').getByRole('button', { name: /^筛选/ }).tap();
    await page.getByLabel('视图', { exact: true }).selectOption(value);
    await page.getByRole('button', { name: '应用', exact: true }).tap();
  };
  await fits('402×874 项目卡片');
  assert.equal(await page.locator('.li-mobile-controls select').count(), 0, '筛选不常驻占用三行');
  const before = await chrome.boundingBox();
  await page.locator('.li-mobile-content').evaluate(el => { el.scrollTop = el.scrollHeight; });
  assert.deepEqual(await chrome.boundingBox(), before, '列表滚动不应移动导航和主要操作');
  assert.equal(await page.evaluate(() => scrollY), 0);
  await page.locator('.li-mobile-content').evaluate(el => { el.scrollTop = 0; });
  await page.screenshot({ scale: 'css', path: join(output, 'projects-iphone17.png') });
  await page.locator('.li-project-card').filter({ has: page.getByRole('button', { name: '手机上的项目协作与本地议题', exact: true }) }).locator('.li-project-card-meta').tap();
  await page.locator('.li-state-tabs').waitFor(); await fits('议题列表');
  await page.locator('.li-issue-row .li-touch-checkbox').first().tap();
  assert.equal(await page.locator('.li-description').count(), 0, '勾选不应进入详情');
  await page.locator('.li-issue-row .li-issue-meta').first().tap(); await page.locator('.li-description').waitFor();
  await chrome.getByRole('button', { name: '返回', exact: true }).tap(); await page.locator('.li-state-tabs').waitFor();
  await setMode('board'); await page.locator('.li-board').waitFor(); await fits('单列看板');
  assert.equal(await page.locator('.li-board').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
  await setMode('table'); await page.locator('.li-issues-table').waitFor(); await fits('表格局部滚动');
  await page.evaluate(() => fixture.view.navigate(sample.project.id, sample.issue.id)); await page.locator('.li-description').waitFor(); await fits('议题正文');
  assert.equal(await page.locator('.li-mobile-properties').evaluate(el => el.open), false);
  assert.equal(await page.locator('.li-composer .cm-editor').count(), 0, '阅读时不应预先展开评论编辑器');
  await page.screenshot({ scale: 'css', path: join(output, 'issue-iphone17.png') });
  await page.locator('.li-description').getByRole('button', { name: '编辑', exact: true }).tap(); await editPage.locator('.cm-editor').waitFor();
  await page.evaluate(() => fixture.setMarkdown(document.querySelector('.li-mobile-edit-page'), '中文输入与换行。\n\n' + '这是手机上的长段落。'.repeat(80)));
  await editPage.locator('input[type="file"]').setInputFiles({ name: '手机图片.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  await page.waitForFunction(() => fixture.binary.size === 1 && !document.querySelector('.li-mobile-edit-page [data-uploading]'));
  await editPage.locator('img.li-live-image').waitFor();
  const image = await editPage.locator('img.li-live-image').boundingBox(); assert.ok(image.width <= 378, '附件图片不得撑宽编辑区');
  assert.deepEqual(await editPage.locator('.li-editor-toolbar button').allTextContents(), ['编写', '预览', '附件']);
  for (const name of ['编写', '预览', '附件']) {
    const bounds = await editPage.getByRole('button', { name, exact: true }).boundingBox(); assert.ok(bounds.height >= 44 && bounds.width >= 44, `${name} 触控区域不足`);
  }
  await fits('正文编辑、长段落与图片附件');
  await navButtonVisible('保存');
  await page.screenshot({ scale: 'css', path: join(output, 'editor-iphone17.png') });
  await (await navButtonVisible('取消')).tap();
  await page.locator('.li-description').getByRole('button', { name: '编辑', exact: true }).tap();
  await editPage.locator('.cm-editor').waitFor();
  await editPage.getByText('已恢复本机草稿', { exact: true }).waitFor();
  assert.equal(await editPage.locator('img.li-live-image').count(), 1, '恢复草稿时保留图片附件引用');
  await fits('恢复长文与图片草稿');
  // WKWebView can shrink only the visual viewport, retaining the layout height.
  await page.evaluate(() => { window.testViewportHeight = 430; Object.defineProperty(visualViewport, 'height', { get: () => testViewportHeight, configurable: true }); visualViewport.dispatchEvent(new Event('resize')); });
  await fits('键盘展开仅缩小可视区域');
  await navButtonVisible('保存');
  const editorScroll = editPage.locator('.cm-scroller');
  await editorScroll.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await navButtonVisible('保存');
  await editPage.getByRole('button', { name: '预览', exact: true }).tap(); await fits('键盘高度下预览');
  await editPage.getByRole('button', { name: '编写', exact: true }).tap();
  await (await navButtonVisible('保存')).tap(); await page.waitForFunction(() => fixture.files.get(sample.issue.path).includes('中文输入与换行'));
  await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
  await page.setViewportSize({ width: 874, height: 402 }); await fits('横屏');
  await page.setViewportSize({ width: 375, height: 812 }); await fits('较窄手机');
  await page.evaluate(() => fixture.view.navigate(sample.project.id));
  await page.getByRole('button', { name: '新建 Issue', exact: true }).tap(); await editPage.locator('input[placeholder="简洁描述这件事"]').waitFor();
  await navButtonVisible('创建议题');
  await editPage.locator('input[placeholder="简洁描述这件事"]').fill('手机单页创建的议题');
  await page.evaluate(() => fixture.setMarkdown(document.querySelector('.li-mobile-edit-page'), '手机创建的正文。\n\n' + '长段落与图片输入。'.repeat(80)));
  await editPage.locator('details.li-properties summary').tap();
  await editPage.getByLabel('标签', { exact: true }).fill('手机,体验');
  await page.evaluate(() => { Object.defineProperty(visualViewport, 'height', { value: 420, configurable: true }); visualViewport.dispatchEvent(new Event('resize')); });
  await fits('手机新建议题与属性，页面不滚动');
  await page.waitForFunction(() => { const field = document.activeElement.getBoundingClientRect(); return field.top >= 148 && field.bottom <= 420; });
  await navButtonVisible('创建议题');
  await page.screenshot({ scale: 'css', path: join(output, 'create-iphone-keyboard.png') });
  await (await navButtonVisible('创建议题')).tap();
  await page.waitForFunction(async () => (await fixture.plugin.store.snapshot()).issues.some(i => i.title === '手机单页创建的议题' && i.labels.includes('手机')));
  await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
  await chrome.getByRole('button', { name: '评论', exact: true }).tap(); await editPage.locator('.cm-editor').waitFor();
  await editPage.locator('.cm-content').tap(); await page.keyboard.insertText('手机里继续讨论。');
  await (await navButtonVisible('发表评论')).tap();
  await page.waitForFunction(async () => (await fixture.plugin.store.snapshot()).timeline.some(t => t.body === '手机里继续讨论。'));
  await page.evaluate(() => fixture.view.navigate()); await page.locator('.li-project-card').first().waitFor();
  await page.getByRole('button', { name: '新建项目', exact: true }).tap(); await editPage.getByLabel('项目名称', { exact: true }).fill('手机上新建的项目');
  await page.evaluate(() => { Object.defineProperty(visualViewport, 'height', { value: 420, configurable: true }); visualViewport.dispatchEvent(new Event('resize')); });
  await fits('键盘下新建项目');
  await (await navButtonVisible('保存')).tap();
  await page.waitForFunction(async () => (await fixture.plugin.store.snapshot()).projects.some(p => p.title === '手机上新建的项目'));
  await fits('新项目创建');
  assert.deepEqual(errors, []);
  await page.evaluate(() => fixture.close());
  console.log('WebKit 手机布局通过：402×874、874×402、375×812，固定导航、内容滚动、专注编辑、键盘高度与触控区域。预览：' + output);
  await context.close();
} catch (error) {
  if (activePage) { await activePage.screenshot({ path: join(output, 'failure.png') }); console.error(await activePage.evaluate(() => ({ state: fixture.view.getState(), notices: fixture.mock.notices, text: document.body.textContent?.slice(-1400) }))); }
  console.error('预览：' + output); throw error;
} finally { await browser.close(); }
