import Plugin from '../src/main';
import { EditorView } from '@codemirror/view';
import * as mock from './obsidian-mock.cjs';

/** In-memory public host surfaces; no disk, network, Node APIs, or real vault. */
export async function createMobileFixture(persisted?: { files: Map<string, string>; binary: Map<string, Uint8Array>; folders: Set<string>; storage: Map<string, string> }) {
  Object.assign(mock.Platform, { isMobile: true, isDesktopApp: false, isIosApp: true });
  mock.installDom(window); document.body.classList.add('is-mobile');
  const files = persisted?.files || new Map<string, string>(), binary = persisted?.binary || new Map<string, Uint8Array>(), folders = persisted?.folders || new Set<string>(), storage = persisted?.storage || new Map<string, string>(), trashed: string[] = [];
  const changed: (() => void)[] = [], ready: (() => void)[] = [], leaves: any[] = [];
  const notify = () => changed.forEach(fn => fn());
  const file = (path: string) => files.has(path) || binary.has(path) ? Object.assign(new mock.TFile(path), { stat: { size: files.get(path)?.length || binary.get(path)?.length || 0 } }) : folders.has(path) ? { path } : null;
  let plugin: any;
  const app: any = {
    loadLocalStorage: (key: string) => storage.has(key) ? JSON.parse(storage.get(key)!) : null,
    saveLocalStorage: (key: string, value: unknown) => { if (value === null) storage.delete(key); else storage.set(key, JSON.stringify(value)); },
    savedData: { apiEnabled: true, port: 27183, root: 'Local Issues', author: '我', shares: {} },
    vault: {
      configDir: '.obsidian', getName: () => '手机笔记库', getMarkdownFiles: () => [...files.keys()].filter(p => p.endsWith('.md')).map(file), getAbstractFileByPath: file,
      adapter: { exists: async (p: string) => files.has(p) || binary.has(p) || folders.has(p) },
      read: async (f: { path: string }) => files.get(f.path)!,
      createFolder: async (p: string) => { folders.add(p); },
      create: async (p: string, value: string) => { if (files.has(p)) throw new Error('文件已存在'); files.set(p, value); notify(); return file(p); },
      createBinary: async (p: string, data: ArrayBuffer) => { binary.set(p, new Uint8Array(data)); notify(); return file(p); },
      process: async (f: { path: string }, change: (raw: string) => string) => { files.set(f.path, change(files.get(f.path)!)); notify(); },
      getResourcePath: () => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#d6c1f2"/></svg>'),
      trash: async (folder: { path: string }, system: boolean) => { if (system) throw new Error('手机不能调用系统桌面废纸篓'); trashed.push(folder.path); for (const path of files.keys()) if (path.startsWith(folder.path + '/')) files.delete(path); },
      on: (_event: string, fn: () => void) => { changed.push(fn); return fn; },
    },
    metadataCache: { getFirstLinkpathDest: (ref: string) => file(ref) || file(ref + '.md') },
    workspace: {
      onLayoutReady: (fn: () => void) => ready.push(fn), getActiveFile: () => null,
      getLeavesOfType: () => leaves,
      getLeaf: () => { const leaf: any = { app, async setViewState(state: { type: string; state?: any }) {
        if (!leaf.view) { leaf.view = plugin.views.get(state.type)(leaf); leaves.push(leaf); await leaf.view.onOpen(); }
        await leaf.view.setState(state.state || {}, { history: false });
      } }; return leaf; },
      revealLeaf: async () => {}, openLinkText: async () => {},
    },
  };
  plugin = new Plugin(app, { id: 'local-issues', version: '0.2.5', dir: '.obsidian/plugins/local-issues' });
  await plugin.onload(); ready.forEach(fn => fn()); await plugin.activate();
  const fixture = {
    app, plugin, files, binary, trashed, mock, persistence: { files, binary, folders, storage },
    get view() { return leaves[0].view; },
    setMarkdown(container: Element, value: string) {
      const element = container.querySelector<HTMLElement>('.cm-editor')!;
      const editor = EditorView.findFromDOM(element)!;
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } });
    },
    async seed() {
      const p = await plugin.store.createProject({ title: '手机上的项目协作与本地议题', description: '项目、议题和讨论，保存在自己的笔记库。' });
      await plugin.store.createProject({ title: '日常记录' });
      const i = await plugin.store.createIssue(p.id, { title: '手机端人工读写：较长的标题也应完整显示，不撑宽页面', body: '手机上的正文。\n\n' + '这是一段用于验证换行与编辑的长文字。'.repeat(12), labels: ['功能', 'P1'], milestone: '下一步', assignees: ['我'], dueDate: '2026-12-31' });
      await plugin.store.createIssue(p.id, { title: '已完成的议题', status: 'closed' });
      await plugin.store.addComment(i.id, '手机上的讨论与反馈。');
      await fixture.view.refresh(); return { project: p, issue: i };
    },
    async close() { plugin.onunload(); for (const leaf of leaves) await leaf.view.onClose(); for (const modal of [...mock.modals]) modal.close(); },
  };
  return fixture;
}
