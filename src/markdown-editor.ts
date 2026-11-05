import { Compartment, EditorSelection, EditorState, Prec, Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, keymap, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';

export interface MarkdownHost {
  image?: (target: string) => string | undefined;
  onSubmit?: () => void;
  onAttach?: () => void;
}

class InlineWidget extends WidgetType {
  constructor(readonly label: string, readonly from: number, readonly to: number, readonly image?: string, readonly checked?: boolean) { super(); }
  eq(other: InlineWidget) { return this.label === other.label && this.from === other.from && this.to === other.to && this.image === other.image && this.checked === other.checked; }
  toDOM(view: EditorView) {
    const element = document.createElement(this.checked === undefined ? this.image ? 'img' : 'span' : 'input');
    if (element instanceof HTMLImageElement) { element.src = this.image!; element.alt = this.label; element.className = 'li-live-image'; }
    else if (element instanceof HTMLInputElement) {
      element.type = 'checkbox'; element.checked = this.checked!; element.setAttribute('aria-label', this.checked ? '标为未完成' : '标为完成');
      element.addEventListener('mousedown', e => e.preventDefault());
      element.addEventListener('click', () => { if (view.state.readOnly || view.compositionStarted) { element.checked = this.checked!; return; } view.dispatch({ changes: { from: this.from, to: this.to, insert: this.checked ? '[ ]' : '[x]' } }); view.focus(); });
      return element;
    } else { element.className = 'li-live-link'; element.textContent = this.label; }
    element.setAttribute('aria-label', `编辑链接：${this.label}`);
    element.addEventListener('mousedown', event => { event.preventDefault(); view.dispatch({ selection: { anchor: this.from, head: this.to } }); view.focus(); });
    return element;
  }
  ignoreEvent() { return false; }
}

function decorations(view: EditorView, host: MarkdownHost): DecorationSet {
  if (view.compositionStarted) return Decoration.none;
  const ranges: Range<Decoration>[] = [], tree = syntaxTree(view.state);
  const selected = (from: number, to: number) => view.state.selection.ranges.some(s => s.from <= to && s.to >= from);
  const hide = (from: number, to: number) => { if (to > from && !view.state.sliceDoc(from, to).includes('\n')) ranges.push(Decoration.replace({}).range(from, to)); };
  const replaced: { from: number; to: number }[] = [];
  tree.iterate({ from: view.viewport.from, to: view.viewport.to, enter: node => {
    const name = node.name;
    if (/^(FencedCode|CodeBlock|HTMLBlock)$/.test(name)) {
      for (let pos = node.from; pos <= node.to;) { const line = view.state.doc.lineAt(pos); ranges.push(Decoration.line({ class: 'li-live-code-block' }).range(line.from)); if (line.to >= node.to) break; pos = line.to + 1; }
      return false;
    }
    // Images stay as Markdown while writing, including during IME composition.
    // Rendering them only in Preview keeps the caret and editor height stable.
    if (name === 'Image') return false;
    if (name === 'Link' && !selected(node.from, node.to) && !view.state.sliceDoc(node.from, node.to).includes('\n')) {
      const text = view.state.sliceDoc(node.from, node.to), match = text.match(/^!?\[([^\]]*)\]\(([^\s)]+)(?:\s+"[^"]*")?\)$/);
      if (match) {
        ranges.push(Decoration.replace({ widget: new InlineWidget(match[1] || match[2], node.from, node.to) }).range(node.from, node.to));
        replaced.push({ from: node.from, to: node.to }); return false;
      }
    }
    if (name === 'TaskMarker' && !selected(node.from, node.to)) {
      ranges.push(Decoration.replace({ widget: new InlineWidget('', node.from, node.to, undefined, /x/i.test(view.state.sliceDoc(node.from, node.to))) }).range(node.from, node.to)); return false;
    }
    if (/^ATXHeading[1-6]$/.test(name)) {
      const line = view.state.doc.lineAt(node.from); ranges.push(Decoration.line({ class: `li-live-heading li-live-h${name.at(-1)}` }).range(line.from));
      const mark = node.node.firstChild; if (mark && !selected(node.from, node.to)) hide(mark.from, Math.min(mark.to + 1, node.to));
    }
    if (name === 'QuoteMark') { ranges.push(Decoration.line({ class: 'li-live-quote' }).range(view.state.doc.lineAt(node.from).from)); if (!selected(view.state.doc.lineAt(node.from).from, view.state.doc.lineAt(node.from).to)) hide(node.from, node.to); }
    if (name === 'ListMark') ranges.push(Decoration.mark({ class: 'li-live-list-mark' }).range(node.from, node.to));
    if (name === 'Table') {
      for (let pos = node.from; pos <= node.to;) { const line = view.state.doc.lineAt(pos); ranges.push(Decoration.line({ class: 'li-live-table' }).range(line.from)); if (line.to >= node.to) break; pos = line.to + 1; }
    }
    const classes: Record<string, string> = { StrongEmphasis: 'li-live-strong', Emphasis: 'li-live-emphasis', Strikethrough: 'li-live-strike', InlineCode: 'li-live-code' };
    if (classes[name]) {
      const first = node.node.firstChild, last = node.node.lastChild;
      if (first && last && first.to < last.from) {
        ranges.push(Decoration.mark({ class: classes[name] }).range(first.to, last.from));
        if (!selected(node.from, node.to)) { hide(first.from, first.to); hide(last.from, last.to); }
      }
      if (name === 'InlineCode') return false;
    }
  } });
  for (const visible of view.visibleRanges) {
    for (const match of view.state.sliceDoc(visible.from, visible.to).matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
      const from = visible.from + match.index!, to = from + match[0].length;
      if (match[1] || selected(from, to) || replaced.some(r => from < r.to && to > r.from)) continue;
      let blocked = false;
      for (let node = tree.resolveInner(from, 1); node; node = node.parent!) if (/Code|HTML/.test(node.name)) blocked = true;
      if (blocked || (from > 0 && view.state.sliceDoc(from - 1, from) === '\\')) continue;
      const [target, ...alias] = match[2].split('|');
      ranges.push(Decoration.replace({ widget: new InlineWidget(alias.join('|') || target, from, to, match[1] ? host.image?.(target) : undefined) }).range(from, to));
    }
  }
  return Decoration.set(ranges, true);
}

export type MarkdownAction = 'bold' | 'italic' | 'link' | 'code' | 'strike' | 'heading' | 'quote' | 'list' | 'task' | 'source';
export type MarkdownShortcut = MarkdownAction | 'submit' | 'attach';
export const MARKDOWN_SHORTCUTS: [string[], string, MarkdownShortcut][] = [
  [['Mod'], 'b', 'bold'], [['Mod'], 'i', 'italic'], [['Mod'], 'k', 'link'], [['Mod'], '/', 'source'],
  [['Mod'], 'Enter', 'submit'], [['Mod', 'Shift'], 'u', 'attach'],
];

export function createMarkdownEditor(parent: HTMLElement, value: string, onChange: (value: string) => void, host: MarkdownHost = {}) {
  const mode = new Compartment(), editable = new Compartment();
  let source = false;
  const extension = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorations(view, host); }
    update(update: ViewUpdate) { if (update.docChanged || update.selectionSet || update.viewportChanged || update.transactions.length) this.decorations = decorations(update.view, host); }
  }, { decorations: v => v.decorations });
  const permitted = (view: EditorView) => !view.compositionStarted && !view.state.readOnly;
  const wrap = (delimiter: string) => (view: EditorView) => {
    if (!permitted(view)) return false;
    const transaction = view.state.changeByRange(range => {
      const text = view.state.sliceDoc(range.from, range.to), n = delimiter.length;
      const italicMarks = (left: string, right: string) => delimiter !== '*' || ((left.match(/\*+$/)?.[0].length || 0) % 2 === 1 && (right.match(/^\*+/)?.[0].length || 0) % 2 === 1);
      if (text.startsWith(delimiter) && text.endsWith(delimiter) && text.length >= n * 2 && italicMarks(text.match(/^\*+/)?.[0] || '', text.match(/\*+$/)?.[0] || '')) return { changes: { from: range.from, to: range.to, insert: text.slice(n, -n) }, range: EditorSelection.range(range.from, range.to - n * 2) };
      if (range.from >= n && view.state.sliceDoc(range.from - n, range.from) === delimiter && view.state.sliceDoc(range.to, range.to + n) === delimiter && italicMarks(view.state.sliceDoc(0, range.from), view.state.sliceDoc(range.to))) return { changes: [{ from: range.from - n, to: range.from }, { from: range.to, to: range.to + n }], range: EditorSelection.range(range.from - n, range.to - n) };
      return { changes: { from: range.from, to: range.to, insert: `${delimiter}${text}${delimiter}` }, range: EditorSelection.range(range.from + n, range.to + n) };
    });
    view.dispatch({ ...transaction, userEvent: 'input' }); return true;
  };
  const block = (prefix: string) => (view: EditorView) => {
    if (!permitted(view)) return false;
    const lines = new Set<number>();
    for (const r of view.state.selection.ranges) for (let n = view.state.doc.lineAt(r.from).number; n <= view.state.doc.lineAt(r.to > r.from ? r.to - 1 : r.to).number; n++) lines.add(n);
    const changes = [...lines].sort((a, b) => a - b).map(n => { const line = view.state.doc.line(n); const heading = prefix === '## ' ? line.text.match(/^#{1,6} /)?.[0] : undefined; return line.text.startsWith(prefix) ? { from: line.from, to: line.from + prefix.length, insert: '' } : { from: line.from, to: line.from + (heading?.length || 0), insert: prefix }; });
    view.dispatch({ changes, userEvent: 'input' }); return true;
  };
  const commands: Record<MarkdownAction, (view: EditorView) => boolean> = {
    bold: wrap('**'), italic: wrap('*'), code: wrap('`'), strike: wrap('~~'),
    heading: block('## '), quote: block('> '), list: block('- '), task: block('- [ ] '),
    link: view => {
      if (!permitted(view)) return false;
      const { from, to } = view.state.selection.main, text = view.state.sliceDoc(from, to);
      const insert = `[${text}](https://)`;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + text.length + 3, head: from + insert.length - 1 }, userEvent: 'input' }); return true;
    },
    source: view => {
      if (view.compositionStarted) return false;
      source = !source;
      const scroll = view.scrollDOM.scrollTop;
      view.dispatch({ effects: mode.reconfigure(source ? [] : extension) });
      view.scrollDOM.scrollTop = scroll;
      parent.dataset.mode = source ? 'source' : 'live';
      parent.dispatchEvent(new parent.ownerDocument.defaultView!.Event('markdown-mode'));
      return true;
    },
  };
  const inList = (view: EditorView) => { for (let node = syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1); node; node = node.parent!) if (node.name === 'ListItem') return true; return false; };
  const view = new EditorView({ parent, state: EditorState.create({ doc: value, extensions: [
    markdown({ base: markdownLanguage }), history(), EditorView.lineWrapping,
    EditorView.baseTheme({
      '&': { color: 'inherit', backgroundColor: 'transparent' }, '&.cm-focused': { outline: 'none' },
      '.cm-scroller': { fontFamily: 'inherit', lineHeight: '1.6', maxHeight: '55dvh', overflow: 'auto' },
      '.cm-content': { minHeight: '100px', padding: '12px' },
      '.cm-line': { overflowWrap: 'anywhere' },
      '.li-live-strong': { fontWeight: '700' }, '.li-live-emphasis': { fontStyle: 'italic' }, '.li-live-strike': { textDecoration: 'line-through' },
      '.li-live-code, .li-live-code-block, .li-live-table': { fontFamily: 'monospace', backgroundColor: 'var(--background-secondary, #8881)' },
      '.li-live-heading': { fontWeight: '700', paddingTop: '8px', paddingBottom: '4px' },
      '.li-live-h1': { fontSize: '1.8em' }, '.li-live-h2': { fontSize: '1.5em' }, '.li-live-h3': { fontSize: '1.25em' },
      '.li-live-quote': { borderLeft: '3px solid var(--background-modifier-border, #8886)', paddingLeft: '12px', color: 'var(--text-muted, #666)' },
      '.li-live-list-mark': { color: 'var(--text-accent, #8250df)' },
      '.li-live-link': { color: 'var(--text-accent, #8250df)', textDecoration: 'underline', cursor: 'text' },
      '.li-live-image': { maxWidth: '100%', maxHeight: '280px', objectFit: 'contain', verticalAlign: 'middle' },
    }),
    editable.of([]),
    Prec.highest(keymap.of([
      { key: 'Mod-b', run: commands.bold }, { key: 'Mod-i', run: commands.italic }, { key: 'Mod-k', run: commands.link }, { key: 'Mod-/', run: commands.source },
      { key: 'Mod-Enter', run: v => { if (!permitted(v) || !host.onSubmit) return false; host.onSubmit(); return true; } },
      { key: 'Mod-Shift-u', run: v => { if (!permitted(v) || !host.onAttach) return false; host.onAttach(); return true; } },
      { key: 'Tab', run: v => permitted(v) && inList(v) ? indentMore(v) : false }, { key: 'Shift-Tab', run: v => permitted(v) && inList(v) ? indentLess(v) : false },
    ])),
    keymap.of([...defaultKeymap, ...historyKeymap]), mode.of(extension),
    EditorView.contentAttributes.of({ 'aria-label': 'Markdown 内容' }),
    EditorView.domEventHandlers({ compositionend: () => { setTimeout(() => { if (view.dom.isConnected) view.dispatch({}); }, 0); } }),
    EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); }),
  ] }) });
  parent.dataset.mode = 'live';
  return Object.assign(view, {
    command(action: MarkdownAction) { const result = commands[action](view); view.focus(); return result; },
    shortcut(action: MarkdownShortcut) {
      if (!permitted(view)) return false;
      if (action === 'submit' || action === 'attach') {
        const run = action === 'submit' ? host.onSubmit : host.onAttach;
        if (!run) return false;
        run(); return true;
      }
      return commands[action](view);
    },
    setReadOnly(readOnly: boolean) { view.dispatch({ effects: editable.reconfigure([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]) }); },
  });
}

export const MARKDOWN_TOOLS: [MarkdownAction, string, string][] = [
  ['bold', '加粗', 'Cmd/Ctrl+B'], ['italic', '斜体', 'Cmd/Ctrl+I'], ['link', '链接', 'Cmd/Ctrl+K'], ['code', '代码', ''], ['strike', '删除线', ''],
  ['heading', '标题', ''], ['quote', '引用', ''], ['list', '列表', ''], ['task', '任务', ''], ['source', '源码', 'Cmd/Ctrl+/'],
];
