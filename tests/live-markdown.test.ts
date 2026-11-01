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
    navigator: window.navigator, HTMLElement: window.HTMLElement, HTMLImageElement: window.HTMLImageElement, HTMLInputElement: window.HTMLInputElement,
    MutationObserver: window.MutationObserver, Window: window.Window, Node: window.Node, Element: window.Element,
    getComputedStyle: window.getComputedStyle, setTimeout, clearTimeout, console });
  const app = { metadataCache: { getFirstLinkpathDest: (path: string) => path.endsWith('.png') ? { path, name: 'image.png' } : null }, vault: { getResourcePath: (file: { path: string }) => `app://local/${file.path}` } };
  const initial = '开头\n**加粗 [[notes/long/path|显示名称]]**\n![[image.png]]\n`[[code]]`\n```\n[[literal]]\n```';
  const parent = window.document.createElement('div'); window.document.body.append(parent);
  const changes: string[] = [];
  try {
    const editor = module.exports.createLiveMarkdown(app, parent, initial, 'issue.md', (value: string) => changes.push(value));
    assert.equal(editor.state.doc.toString(), initial);
    assert.ok(editor.contentDOM.classList.contains('cm-lineWrapping'), '已有正文和新输入均自动换行');
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
    const beforeMode = editor.state.doc.toString(), selection = editor.state.selection.main.head, changeCount = changes.length;
    editor.command('source'); assert.equal(parent.dataset.mode, 'source'); assert.equal(parent.querySelector('.li-live-image'), null);
    editor.command('source'); assert.equal(editor.state.doc.toString(), beforeMode); assert.equal(editor.state.selection.main.head, selection); assert.equal(changes.length, changeCount);
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '中文内容' }, selection: { anchor: 0, head: 4 } });
    editor.command('bold'); assert.equal(editor.state.doc.toString(), '**中文内容**'); assert.equal(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to), '中文内容');
    editor.command('italic'); assert.equal(editor.state.doc.toString(), '***中文内容***'); editor.command('italic'); assert.equal(editor.state.doc.toString(), '**中文内容**');
    editor.command('bold'); assert.equal(editor.state.doc.toString(), '中文内容');
    editor.command('italic'); assert.equal(editor.state.doc.toString(), '*中文内容*'); editor.command('italic');
    editor.command('link'); assert.equal(editor.state.doc.toString(), '[中文内容](https://)'); assert.equal(editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to), 'https://');
    editor.setReadOnly(true); assert.equal(editor.command('bold'), false); assert.equal(editor.state.doc.toString(), '[中文内容](https://)'); editor.setReadOnly(false);
    const rich = '# 标题\n> 引用\n- [ ] 待办\n~~删除~~ 和 [链接](https://example.com)\n| A | B |\n| --- | --- |\n| 1 | 2 |\n```\n**保留原文** [[code]]\n```\n末尾';
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: rich }, selection: { anchor: rich.length } });
    assert.ok(parent.querySelector('.li-live-h1')); assert.ok(parent.querySelector('.li-live-quote')); assert.ok(parent.querySelector('.li-live-table')); assert.ok(parent.querySelector('.li-live-strike'));
    const checkbox = parent.querySelector('input[type=checkbox]') as HTMLInputElement; assert.ok(checkbox); checkbox.click(); assert.match(editor.state.doc.toString(), /- \[x\] 待办/);
    editor.setReadOnly(true); const locked = editor.state.doc.toString(); parent.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); assert.equal(editor.state.doc.toString(), locked); editor.setReadOnly(false);
    assert.match(parent.querySelector('.cm-content')!.textContent!, /\*\*保留原文\*\* \[\[code\]\]/);
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '正文' }, selection: { anchor: 2 } });
    editor.command('source');
    editor.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(editor.state.doc.toString(), '正文****'); assert.equal(editor.state.selection.main.head, 4);
    editor.command('source');
    editor.contentDOM.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    assert.equal(editor.state.doc.toString(), '正文', '切换模式保留撤销历史');
    editor.contentDOM.dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }));
    assert.equal(editor.command('bold'), false, '输入法组合输入期间不执行格式命令');
    assert.equal(editor.state.doc.toString(), '正文');
    editor.contentDOM.dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }));
    editor.destroy(); assert.equal(parent.querySelector('.cm-editor'), null);
    for (let i = 0; i < 50; i++) { const next = module.exports.createLiveMarkdown(app, parent, initial, 'issue.md', () => {}); next.destroy(); }
    assert.equal(parent.querySelectorAll('.cm-editor').length, 0);
  } finally { window.close(); }
});
