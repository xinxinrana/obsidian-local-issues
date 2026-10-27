import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import vm from 'node:vm';

test('live Markdown preserves source while editing links, images and code, and releases editors', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
  const { window } = dom;
  const built = await build({ entryPoints: ['src/live-markdown.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], logLevel: 'silent' });
  const module = { exports: {} as any };
  vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, document: window.document, window,
    navigator: window.navigator, HTMLElement: window.HTMLElement, HTMLImageElement: window.HTMLImageElement,
    MutationObserver: window.MutationObserver, Window: window.Window, Node: window.Node, Element: window.Element,
    getComputedStyle: window.getComputedStyle, setTimeout, clearTimeout, console });
  const app = { metadataCache: { getFirstLinkpathDest: (path: string) => path.endsWith('.png') ? { path, name: 'image.png' } : null }, vault: { getResourcePath: (file: { path: string }) => `app://local/${file.path}` } };
  const initial = '开头\n**加粗 [[notes/long/path|显示名称]]**\n![[image.png]]\n`[[code]]`\n```\n[[literal]]\n```';
  const parent = window.document.createElement('div'); window.document.body.append(parent);
  const changes: string[] = [];
  try {
    const editor = module.exports.createLiveMarkdown(app, parent, initial, 'issue.md', (value: string) => changes.push(value));
    assert.equal(editor.state.doc.toString(), initial);
    assert.equal(parent.querySelector('.li-live-link')?.textContent, '显示名称');
    assert.ok(parent.querySelector('.li-live-strong'), '加粗内容直接呈现');
    assert.equal(parent.querySelector('.li-live-image')?.getAttribute('src'), 'app://local/image.png');
    assert.match(parent.querySelector('.cm-content')!.textContent!, /\[\[code\]\]/);
    assert.match(parent.querySelector('.cm-content')!.textContent!, /\[\[literal\]\]/);
    const from = initial.indexOf('[[notes');
    editor.dispatch({ selection: { anchor: from + 2 } });
    assert.equal(parent.querySelector('.li-live-link'), null, '点击链接后显示可编辑的原文');
    editor.dispatch({ changes: { from: initial.indexOf('开头'), to: 2, insert: '修改' } });
    assert.equal(changes.at(-1), initial.replace('开头', '修改'));
    editor.destroy(); assert.equal(parent.querySelector('.cm-editor'), null);
    for (let i = 0; i < 50; i++) { const next = module.exports.createLiveMarkdown(app, parent, initial, 'issue.md', () => {}); next.destroy(); }
    assert.equal(parent.querySelectorAll('.cm-editor').length, 0);
  } finally { window.close(); }
});
