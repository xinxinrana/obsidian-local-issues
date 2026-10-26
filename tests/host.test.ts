import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const mock = require('./obsidian-mock.cjs');

test('bundled plugin registers native entry points; Vault adapter, protocol, API share and settings work together', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost' });
  for (const name of ['document', 'window', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'HTMLLabelElement', 'HTMLSelectElement', 'Element', 'Node', 'Event', 'MouseEvent']) (globalThis as any)[name] = (dom.window as any)[name];
  mock.installDom(dom.window);
  const clipboard: string[] = [];
  const navigator = { clipboard: { writeText: async (s: string) => { clipboard.push(s); } } };
  const files = new Map<string, string>(), binary = new Map<string, Uint8Array>(), folders = new Set<string>();
  const events: (() => void)[] = [];
  const changed = () => events.forEach(fn => fn());
  let injectExternalEdit = false;
  const vault = {
    configDir: '.obsidian', getName: () => 'Tests', getMarkdownFiles: () => [...files.keys()].map(p => new mock.TFile(p)),
    getAbstractFileByPath: (p: string) => files.has(p) ? new mock.TFile(p) : null,
    adapter: { exists: async (p: string) => files.has(p) || folders.has(p) || binary.has(p) },
    read: async (f: { path: string }) => files.get(f.path)!,
    createFolder: async (p: string) => { folders.add(p); },
    create: async (p: string, s: string) => { assert.ok(!files.has(p)); files.set(p, s); changed(); return new mock.TFile(p); },
    createBinary: async (p: string, data: ArrayBuffer) => { binary.set(p, new Uint8Array(data)); changed(); return new mock.TFile(p); },
    process: async (f: { path: string }, fn: (s: string) => string) => {
      if (injectExternalEdit) { files.set(f.path, files.get(f.path)! + '\n外部刚保存的文本\n'); injectExternalEdit = false; }
      const next = fn(files.get(f.path)!); files.set(f.path, next); changed(); return next;
    },
    on: (_event: string, fn: () => void) => { events.push(fn); return fn; },
  };
  const leaves: any[] = [], openedNotes: string[] = [];
  let plugin: any;
  const app: any = {
    vault, metadataCache: { getFirstLinkpathDest: () => null }, savedData: { port: 0, apiEnabled: true },
    workspace: {
      onLayoutReady() {}, getActiveFile: () => null,
      getLeavesOfType: () => leaves,
      getLeaf: () => {
        const leaf: any = { app, async setViewState(state: { type: string }) { leaf.view = plugin.views.get(state.type)(leaf); leaves.push(leaf); await leaf.view.onOpen(); } }; return leaf;
      },
      revealLeaf: async () => {}, openLinkText: async (p: string) => { openedNotes.push(p); },
    },
  };
  const built = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', external: ['obsidian'], target: 'es2022', logLevel: 'silent' });
  const module = { exports: {} as any };
  vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports,
    require: (id: string) => id === 'obsidian' ? mock : require(id),
    console, document: dom.window.document, window: dom.window, navigator, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, HTMLLabelElement: dom.window.HTMLLabelElement, HTMLSelectElement: dom.window.HTMLSelectElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, Node: dom.window.Node, Element: dom.window.Element,
    setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask, URL, URLSearchParams, Buffer, Uint8Array, ArrayBuffer,
  }, { filename: 'main.js' });
  plugin = new module.exports.default(app, { id: 'local-issues', dir: '.obsidian/plugins/local-issues' });
  try {
    await plugin.onload();
    assert.ok(plugin.views.has('local-issues-view'));
    assert.ok(plugin.protocols.has('local-issues'));
    assert.ok(plugin.commands.some((c: any) => c.id === 'open-projects'));
    assert.ok(app.savedData.token.length >= 32);
    const p = await plugin.store.createProject({ title: '主窗口项目', description: '项目说明' });
    const i = await plugin.store.createIssue(p.id, { title: '原生窗口中的 Issue', body: '[[普通笔记]]' });
    assert.ok(files.has(i.path));
    await plugin.activate(p.id, i.id);
    assert.match(dom.window.document.body.textContent!, /原生窗口中的 Issue/);
    await plugin.openNote(i.path); assert.equal(openedNotes[0], i.path);
    injectExternalEdit = true;
    await assert.rejects(plugin.store.updateIssue(i.id, { body: '不应覆盖' }, i.revision), /冲突/);
    assert.match(files.get(i.path)!, /外部刚保存的文本/);
    await plugin.restartApi();
    const share = await plugin.share(i.id);
    const response = await fetch(share); const result: any = await response.json();
    assert.equal(result.data.issue.id, i.id);
    assert.match(result.data.issue.body, /外部刚保存/);
    await assert.rejects(plugin.agentCommand(i.id), /下载独立的 cli.mjs/);
    await plugin.copyCli();
    assert.equal(clipboard.length, 0, 'A community installation must not copy a command for a missing CLI file');
    assert.ok(mock.notices.some((message: string) => message.includes('下载独立的 cli.mjs')));
    files.set('.obsidian/plugins/local-issues/cli.mjs', '#!/usr/bin/env node');
    await plugin.copyCli();
    assert.match(clipboard[0], /node .*cli\.mjs.* --help/);
    assert.match(await plugin.agentCommand(i.id), /^node .*cli\.mjs.* issue view 'http:.*' --json$/);
    assert.match(await plugin.agentCommand(p.id), / project view /);
    plugin.openSettings(); assert.match(mock.modals.at(-1).contentEl.textContent, /本地 Agent API/);
    mock.modals.at(-1).close();
    plugin.settings.apiEnabled = false;
    await plugin.restartApi();
    await assert.rejects(plugin.share(i.id), /启用本地 Agent API/);
  } finally {
    plugin?.onunload();
    for (const leaf of leaves) await leaf.view.onClose?.();
    for (const modal of [...mock.modals]) modal.close();
    dom.window.close();
  }
});
