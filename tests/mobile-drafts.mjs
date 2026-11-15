import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { webkit } from 'playwright';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const output = await mkdtemp(join(tmpdir(), 'local-issues-cold-drafts-'));
const vaultFile = join(output, 'vault.json');
const bundle = await build({ entryPoints: ['tests/mobile-fixture.ts'], bundle: true, minify: true, write: false, platform: 'browser', target: 'es2022', format: 'iife', globalName: 'MobileFixture', external: ['node:*'], alias: { obsidian: resolve('tests/obsidian-mock.cjs') }, logLevel: 'silent' });
const css = await readFile('styles.css', 'utf8');
const boot = `const saved = await readTestVault();
const persisted = saved ? { files: new Map(saved.files), binary: new Map(saved.binary.map(([key,value])=>[key,new Uint8Array(value)])), folders: new Set(saved.folders), storage: new Map(saved.storage), settings: saved.settings } : undefined;
window.fixture = await MobileFixture.createMobileFixture(persisted, { persist: value => writeTestVault({files:[...value.files],binary:[...value.binary].map(([key,bytes])=>[key,[...bytes]]),folders:[...value.folders],storage:[...value.storage],settings:value.settings}) });`;
const theme = `html,body{height:100%;margin:0;font:16px system-ui}*{box-sizing:border-box}.workspace-leaf-content{height:100dvh;display:flex;flex-direction:column}.view-content{flex:1;min-height:0}button,input,select{font:inherit}button{border:0;border-radius:6px;padding:6px 10px;color:inherit}input,select{border:1px solid #aaa;border-radius:6px;padding:6px;max-width:100%}.mod-cta{background:#8154c6;color:white}.modal-container{position:fixed;inset:0;background:#0005;display:flex;justify-content:center;align-items:center}.modal{background:white;padding:12px}:root{--background-primary:white;--background-secondary:#f7f7f9;--background-modifier-border:#ddd;--background-modifier-hover:#efedf7;--text-normal:#25212c;--text-muted:#696370;--text-accent:#8154c6;--interactive-accent:#8154c6;--font-ui-medium:16px;--font-ui-small:13px;--font-ui-smaller:12px;--radius-m:8px;--radius-s:4px}`;
const html = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${theme}\n${css}</style><body><script src="/fixture.js"></script><script type="module">${boot}</script></body>`;
const browser = await webkit.launch({ headless: true });
let diskWrites = Promise.resolve(), page; const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, isMobile: true, hasTouch: true });
  await context.exposeFunction('readTestVault', async () => { await diskWrites; try { return JSON.parse(await readFile(vaultFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; return null; } });
  await context.exposeFunction('writeTestVault', value => { diskWrites = diskWrites.then(() => writeFile(vaultFile, JSON.stringify(value))); return diskWrites; });
  await context.route('https://draft-test.invalid/**', route => route.fulfill({ contentType: route.request().url().endsWith('/fixture.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8', body: route.request().url().endsWith('/fixture.js') ? bundle.outputFiles[0].text : html }));
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  const ready = () => page.waitForFunction(() => !!window.fixture);
  const source = () => page.evaluate(() => fixture.plugin.draftCache.list().find(draft => draft.key.startsWith('new-issue:'))?.value.editors[0]);
  const title = '切到其他笔记之前尚未创建的议题';
  const body = '真实键盘输入的中文 **不能丢失**\n\n切回来继续写。';
  const check = async () => {
    await page.locator('.li-mobile-edit-page').waitFor();
    assert.equal(await page.getByLabel('标题', { exact: true }).inputValue(), title);
    assert.equal(await source(), body);
    assert.equal(await page.getByLabel('标签', { exact: true }).inputValue(), 'P1，未输完，');
  };
  await page.goto('https://draft-test.invalid/'); await ready();
  await page.evaluate(async () => { await fixture.seed(); });
  await page.getByRole('button', { name: '手机上的项目协作与本地议题', exact: true }).tap();
  await page.getByRole('button', { name: '新建 Issue', exact: true }).tap();
  await page.getByLabel('标题', { exact: true }).fill(title);
  await page.locator('.li-mobile-edit-page .cm-content').tap(); await page.keyboard.insertText(body);
  await page.locator('details.li-properties summary').tap(); await page.getByLabel('标签', { exact: true }).fill('P1，未输完，');
  await check();
  await page.evaluate(() => fixture.plugin.activate()); await check();
  // Replace the actual view with another note, passing back no saved view state.
  await page.evaluate(async () => { await fixture.openOtherNote(); await fixture.plugin.activate(); }); await check();
  // Abrupt page teardown: no fixture.close(), no getState()/setState() round-trip.
  await page.reload(); await ready(); await check();
  await page.evaluate(async () => { await fixture.plugin.draftJournal.flush(); localStorage.clear(); });
  await page.reload(); await ready(); await check();
  assert.equal(await page.evaluate(() => fixture.legacyReads), 0, 'File recovery must not use Obsidian local-storage helpers');
  await page.locator('.li-mobile-edit-nav').getByRole('button', { name: '取消', exact: true }).tap();
  await page.getByRole('button', { name: '草稿', exact: true }).tap();
  await page.locator('.li-draft-item').filter({ hasText: title }).getByRole('button', { name: '继续编辑', exact: true }).tap(); await check();
  await page.locator('.li-mobile-edit-nav').getByRole('button', { name: '创建议题', exact: true }).tap();
  await page.waitForFunction(title => fixture.plugin.draftCache.list().length === 0 && [...fixture.files.values()].some(raw => raw.includes(title)), title);
  await page.evaluate(() => fixture.plugin.draftJournal.flush());
  await page.reload(); await ready(); assert.equal(await page.locator('.li-mobile-edit-page').count(), 0, 'A completed draft must not reopen');
  assert.deepEqual(errors, []);
  await page.evaluate(() => fixture.close()); await context.close();
  console.log('WebKit 草稿恢复通过：真实输入、入口返回、其他笔记切换、无状态整页重载、清空浏览器缓存后文件恢复、草稿入口及提交后清理。临时数据：' + output);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: join(output, 'failure.png'), scale: 'css' }); console.error(await page.evaluate(() => ({ text: document.body.textContent?.slice(-2000), notices: window.fixture?.mock.notices }))); }
  console.error('浏览器错误：', errors); console.error('临时数据：' + output); throw error;
} finally { await browser.close(); }
