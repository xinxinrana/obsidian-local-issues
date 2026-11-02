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
const theme = `:root{--background-primary:#fff;--background-secondary:#f7f7f9;--background-modifier-border:#dedee5;--background-modifier-hover:#f2eff8;--text-normal:#27232f;--text-muted:#696370;--text-error:#bf3030;--text-accent:#8154c6;--interactive-accent:#8154c6;--color-green:#258256;--color-purple:#8154c6;--color-orange:#a66a14;--font-interface:system-ui;--font-ui-medium:15px;--font-ui-small:13px;--font-ui-smaller:12px;--radius-m:8px;--radius-s:4px}*{box-sizing:border-box}html,body{margin:0;height:100%;width:100%;font-family:system-ui}button,input,select,textarea{font:inherit;max-width:100%}button{border:0;border-radius:6px;background:#eeedf1;padding:6px 10px;color:inherit}button.mod-cta{background:#8154c6;color:#fff}input,select{border:1px solid #dedee5;background:white;border-radius:6px;padding:5px 8px}.workspace-leaf-content{height:100dvh;width:100%;min-width:0;display:flex;flex-direction:column}.view-content{flex:1;min-width:0;min-height:0}.modal-container{position:fixed;inset:0;background:#0005;display:flex;align-items:center;justify-content:center;z-index:20}.modal{padding:16px;background:white;border-radius:12px}.modal-content{margin:0}.modal-title{font-size:20px;font-weight:600}.setting-item{display:flex;justify-content:space-between;padding-block:12px;border-bottom:1px solid #dedee5}.setting-item>div{min-width:0}.setting-item-description{font-size:13px;color:#696370}svg{width:16px;height:16px}`;
const browser = await webkit.launch({ headless: true });
let activePage;
try {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const page = await context.newPage(), errors = [];
  activePage = page; page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${theme}\n${css}</style><body></body>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(async () => { window.fixture = await MobileFixture.createMobileFixture(); window.sample = await fixture.seed(); });
  const fits = async name => {
    const dimensions = await page.evaluate(() => { const pane = document.querySelector('.view-content'); return { page: document.documentElement.scrollWidth, viewport: innerWidth, pane: pane.clientWidth, content: pane.scrollWidth }; });
    assert.ok(dimensions.page <= dimensions.viewport + 1 && dimensions.content <= dimensions.pane + 1, `${name}: ${JSON.stringify(dimensions)}`);
  };
  await fits('402×874 项目卡片');
  await page.screenshot({ scale: 'css', path: join(output, 'projects-iphone17.png') });
  await page.getByRole('button', { name: '手机上的项目协作与本地议题', exact: true }).tap();
  await page.locator('.li-tabs').waitFor(); await fits('议题列表');
  await page.getByRole('button', { name: '看板', exact: true }).tap(); await page.locator('.li-board').waitFor(); await fits('单列看板');
  assert.equal(await page.locator('.li-board').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), 1);
  await page.getByRole('button', { name: '表格', exact: true }).tap(); await page.locator('.li-issues-table').waitFor(); await fits('表格局部滚动');
  await page.evaluate(() => fixture.view.navigate(sample.project.id, sample.issue.id)); await page.locator('.li-description').waitFor(); await fits('议题正文');
  assert.equal(await page.locator('.li-mobile-properties').evaluate(el => el.open), false);
  await page.screenshot({ scale: 'css', path: join(output, 'issue-iphone17.png') });
  await page.locator('.li-description').getByRole('button', { name: '编辑', exact: true }).tap(); await page.locator('.li-description .cm-editor').waitFor();
  await page.evaluate(() => fixture.setMarkdown(document.querySelector('.li-description'), '中文输入与换行。\n\n' + '这是手机上的长段落。'.repeat(80)));
  await page.locator('.li-description input[type="file"]').setInputFiles({ name: '手机图片.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
  await page.waitForFunction(() => fixture.binary.size === 1 && !document.querySelector('.li-description [data-uploading]'));
  await page.locator('.li-description .cm-scroller img.li-live-image').waitFor();
  const image = await page.locator('.li-description .cm-scroller img.li-live-image').boundingBox();
  assert.ok(image.width <= 378, '附件图片不得撑宽编辑区');
  await fits('正文编辑、长段落与图片附件');
  await page.locator('.li-description .li-editor-toolbar').evaluate(el => { el.scrollLeft = 0; });
  for (const name of ['编写', '预览', '附件']) {
    const bounds = await page.locator('.li-description .li-editor-toolbar').getByRole('button', { name, exact: true }).boundingBox();
    assert.ok(bounds.height >= 44 && bounds.width >= 44, `${name} 触控区域不足`);
  }
  await page.screenshot({ scale: 'css', path: join(output, 'editor-iphone17.png') });
  await page.setViewportSize({ width: 402, height: 430 });
  const save = page.locator('.li-description').getByRole('button', { name: '保存', exact: true });
  await save.scrollIntoViewIfNeeded(); await fits('软键盘高度下编辑');
  const position = await save.boundingBox(); assert.ok(position.y >= 0 && position.y + position.height <= 431, '保存按钮必须可滚动到可见区域');
  await save.tap(); await page.waitForFunction(() => fixture.files.get(sample.issue.path).includes('中文输入与换行'));
  await page.setViewportSize({ width: 874, height: 402 }); await fits('横屏');
  await page.setViewportSize({ width: 375, height: 812 }); await fits('较窄手机');
  await page.evaluate(() => fixture.plugin.activate()); await page.locator('.li-project-card').first().waitFor(); await fits('较窄手机项目卡片');
  await page.getByRole('button', { name: '新建项目', exact: true }).tap(); await page.locator('.modal.li-modal-container').waitFor();
  await page.locator('input[placeholder="项目名称"]').fill('手机上新建的项目');
  // iOS can shrink the visual viewport without changing the layout viewport.
  await page.evaluate(() => { Object.defineProperty(visualViewport, 'height', { value: 420, configurable: true }); visualViewport.dispatchEvent(new Event('resize')); });
  const modal = page.locator('.modal.li-modal-container'), footer = modal.locator('.li-modal-actions');
  const box = await footer.boundingBox(); assert.ok(box.y >= 0 && box.y + box.height <= 420, '键盘弹出时弹窗操作栏应留在屏幕内');
  await footer.getByRole('button', { name: '保存', exact: true }).tap();
  await page.waitForFunction(async () => (await fixture.plugin.store.snapshot()).projects.some(p => p.title === '手机上新建的项目'));
  await fits('新项目创建');
  assert.deepEqual(errors, []);
  await page.evaluate(() => fixture.close());
  console.log('WebKit 手机布局通过：402×874、874×402、375×812，键盘高度与触控区域。预览：' + output);
  await context.close();
} catch (error) {
  if (activePage) { await activePage.screenshot({ path: join(output, 'failure.png') }); console.error(await activePage.evaluate(() => ({ state: fixture.view.getState(), notices: fixture.mock.notices, text: document.body.textContent?.slice(-1400) }))); }
  console.error('预览：' + output); throw error;
} finally { await browser.close(); }
