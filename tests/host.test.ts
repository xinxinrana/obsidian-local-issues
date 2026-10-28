import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
const require = createRequire(import.meta.url);
const mock = require('./obsidian-mock.cjs');

test('bundled plugin registers native entry points; Vault adapter, protocol, API share and settings work together', async () => {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost', pretendToBeVisual: true });
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
    getAbstractFileByPath: (p: string) => files.has(p) || binary.has(p) ? Object.assign(new mock.TFile(p), { stat: { size: binary.get(p)?.byteLength || files.get(p)?.length || 0 } }) : null,
    adapter: { exists: async (p: string) => files.has(p) || folders.has(p) || binary.has(p), read: async (p: string) => { if (!files.has(p)) throw new Error('文件不存在'); return files.get(p)!; } },
    read: async (f: { path: string }) => files.get(f.path)!,
    readBinary: async (f: { path: string }) => Uint8Array.from(binary.get(f.path)!).buffer,
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
    vault, metadataCache: { getFirstLinkpathDest: () => null }, savedData: { port: 0, apiEnabled: true, token: 'legacy-token', shares: { old: { ref: 'legacy', key: 'legacy-secret' } } },
    workspace: {
      onLayoutReady() {}, getActiveFile: () => null,
      getLeavesOfType: () => leaves,
      getLeaf: () => {
        const leaf: any = { app, async setViewState(state: { type: string; state?: any }) { if (!leaf.view) { leaf.view = plugin.views.get(state.type)(leaf); leaves.push(leaf); await leaf.view.onOpen(); } await leaf.view.setState(state.state || {}, { history: false }); } }; return leaf;
      },
      revealLeaf: async () => {}, openLinkText: async (p: string) => { openedNotes.push(p); },
    },
  };
  const built = await build({ entryPoints: ['src/main.ts'], bundle: true, write: false, minify: true, format: 'cjs', platform: 'node', external: ['obsidian'], target: 'es2022', logLevel: 'silent' });
  const module = { exports: {} as any };
  vm.runInNewContext(built.outputFiles[0].text, { module, exports: module.exports,
    require: (id: string) => id === 'obsidian' ? mock : require(id),
    console, document: dom.window.document, window: dom.window, navigator, HTMLElement: dom.window.HTMLElement, HTMLImageElement: dom.window.HTMLImageElement, MutationObserver: dom.window.MutationObserver, Window: dom.window.Window, getComputedStyle: dom.window.getComputedStyle,
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
    assert.equal(app.savedData.token, undefined); assert.equal(app.savedData.shares.old.key, undefined);
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
    assert.match(await plugin.resourceLink(i.id), /^http:\/\/localhost:\d+\/.+\/issues\/1$/);
    await plugin.copyCli();
    assert.equal(clipboard.length, 0, 'A community installation must not copy a command for a missing CLI file');
    assert.ok(mock.notices.some((message: string) => message.includes('点击「安装 CLI」')));
    files.set('.obsidian/plugins/local-issues/cli.mjs', '#!/usr/bin/env node');
    const origin = new URL(share).origin;
    assert.equal(await (await fetch(`${origin}/api/cli.mjs`)).text(), '#!/usr/bin/env node');
    const image = await plugin.store.attach(i.id, 'web.png', new Uint8Array([137, 80, 78, 71]));
    await plugin.store.addComment(i.id, image.markdown);
    const html = await (await fetch(share, { headers: { Accept: 'text/html' } })).text();
    const web = new JSDOM(html, { url: share, runScripts: 'outside-only' });
    try {
      const img = web.window.document.querySelector('img')!;
      assert.deepEqual(new Uint8Array(await (await fetch(new URL(img.getAttribute('src')!, origin))).arrayBuffer()), new Uint8Array([137, 80, 78, 71]));
      const destinations: string[] = [];
      Object.assign(web.window, { AbortController, __services: {
        navigate: (path: string) => destinations.push(path),
        request: (path: string, options: RequestInit) => fetch(new URL(path, origin), { ...options, headers: { ...options.headers, Origin: origin, 'Sec-Fetch-Site': 'same-origin' } }),
      } });
      const script = await (await fetch(`${origin}/api/web-client.js`)).text();
      web.window.eval(script.replace(/\)\(\);$/, ')(window.__services);'));
      const form = web.window.document.querySelector<HTMLFormElement>(`form[data-api="/api/issues/${i.id}/comments"]`)!;
      form.querySelector('textarea')!.value = '从实际插件构建的网页提交';
      form.dispatchEvent(new web.window.Event('submit', { bubbles: true, cancelable: true }));
      for (let attempt = 0; attempt < 200 && !destinations.length; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(destinations.length, 1, form.textContent!);
      assert.ok((await plugin.store.snapshot()).timeline.some((entry: any) => entry.body === '从实际插件构建的网页提交'));
    } finally { web.window.close(); }
    await plugin.copyGuide();
    assert.match(clipboard.at(-1)!, /^# Local Issues\n/);
    assert.ok(clipboard.at(-1)!.includes(`http://localhost:${new URL(share).port}/`), 'Use the running API port, including dynamically allocated ports');
    assert.match(clipboard.at(-1)!, /## 给 Agent：保存这份 skill/);
    assert.match(clipboard.at(-1)!, /local-issues skill/);
    assert.doesNotMatch(clipboard.at(-1)!, /\.claude|\.codex|\.pi\//, 'Never hard-code other agents skill directories');
    assert.match(clipboard.at(-1)!, /node '.*cli\.mjs'/);
    assert.match(clipboard.at(-1)!, /issue comment/);
    assert.match(clipboard.at(-1)!, /Obsidian/);
    await plugin.copySkill();
    assert.match(clipboard.at(-1)!, /^---\nname: local-issues\n/);
    assert.match(clipboard.at(-1)!, /local-issues view 'http:\/\/localhost:\d+\//);
    assert.match(await plugin.resourceLink(i.id), /\/issues\/1$/);
    assert.match(await plugin.resourceLink(p.id), /^http:\/\/localhost:\d+\/[^/]+$/);
    let attempts = 0, removals = 0, release!: () => void;
    const gate = new Promise<void>(resolve => release = resolve);
    plugin.cliInstaller = async () => ({
      command: '/temporary-test-command', installed: async () => false,
      install: async (notify: (progress: any) => void) => {
        attempts++; notify({ step: 'node', title: '检查 Node.js', state: 'running' }); await gate;
        if (attempts === 1) { notify({ step: 'node', title: '检查 Node.js', state: 'error', detail: '没有找到 Node.js', help: '安装 Node.js 后重试', link: 'https://nodejs.org/en/download' }); throw new Error('Node missing'); }
        notify({ step: 'node', title: '检查 Node.js', state: 'done' }); return { command: '/temporary-test-command', node: 'v24.0.0' };
      },
      remove: async () => { removals++; },
    });
    plugin.openSettings(); assert.match(mock.modals.at(-1).contentEl.textContent, /本地 Agent API/);
    const settingsEl = mock.modals.at(-1).contentEl;
    const install = [...settingsEl.querySelectorAll('button')].find((button: any) => button.textContent === '安装 CLI') as HTMLButtonElement;
    assert.ok(install); assert.equal(settingsEl.querySelector('.li-cli-progress input'), null, 'No advanced Node controls before a failure');
    install.click(); install.click(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(attempts, 1); assert.equal(install.disabled, true); assert.match(settingsEl.querySelector('.li-cli-progress').textContent, /正在进行/);
    release(); for (let attempt = 0; attempt < 200 && plugin.cliBusy; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.match(settingsEl.querySelector('[role=alert]').textContent, /检查 Node/);
    const nodePath = settingsEl.querySelector('.li-cli-progress input') as HTMLInputElement;
    assert.ok(nodePath); nodePath.value = '/custom/node'; nodePath.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    assert.equal(plugin.settings.cliNodePath, '/custom/node');
    install.click(); for (let attempt = 0; attempt < 200 && plugin.cliBusy; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(attempts, 2); assert.equal(plugin.cliInstalled, true); assert.match(settingsEl.querySelector('[role=status]').textContent, /安装完成/);
    const uninstall = [...settingsEl.querySelectorAll('button')].find((button: any) => button.textContent === '卸载 CLI') as HTMLButtonElement;
    assert.equal(uninstall.hidden, false); uninstall.click(); for (let attempt = 0; attempt < 200 && plugin.cliBusy; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(removals, 1); assert.equal(plugin.cliInstalled, false); assert.equal(uninstall.hidden, true);
    mock.modals.at(-1).close();
    assert.equal(plugin.cliListeners.size, 0, 'Closing the settings modal releases the progress listener');
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
