import { App } from 'obsidian';
import { EditorState, Range } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, keymap, ViewPlugin, ViewUpdate, WidgetType } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';

class WikiLink extends WidgetType {
  constructor(private app: App, private sourcePath: string, private target: string, private label: string, private image: boolean, private from: number, private to: number) { super(); }
  eq(other: WikiLink) { return this.sourcePath === other.sourcePath && this.target === other.target && this.label === other.label && this.image === other.image && this.from === other.from && this.to === other.to; }
  toDOM(view: EditorView) {
    const file = this.app.metadataCache.getFirstLinkpathDest(this.target.split('#')[0], this.sourcePath);
    const showImage = this.image && file && /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.path);
    const element = document.createElement(showImage ? 'img' : 'span');
    if (element instanceof HTMLImageElement && file) { element.src = this.app.vault.getResourcePath(file); element.alt = this.label || file.name; element.className = 'li-live-image'; }
    else { element.className = 'li-live-link'; element.textContent = this.label || this.target; }
    element.setAttribute('title', '点击编辑链接');
    element.addEventListener('mousedown', event => { event.preventDefault(); view.dispatch({ selection: { anchor: this.from, head: this.to } }); view.focus(); });
    return element;
  }
  ignoreEvent() { return false; }
}

function decorations(view: EditorView, app: App, sourcePath: string): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const selections = view.state.selection.ranges;
  const selected = (from: number, to: number) => selections.some(s => s.from <= to && s.to >= from);
  const inCode = (from: number, to: number) => { let blocked = false; syntaxTree(view.state).iterate({ from, to, enter: node => { if (/Code|HTML/.test(node.name)) blocked = true; } }); return blocked; };
  syntaxTree(view.state).iterate({ from: view.viewport.from, to: view.viewport.to, enter: node => {
    if (node.name !== 'StrongEmphasis' && node.name !== 'Emphasis') return;
    const first = node.node.firstChild, last = node.node.lastChild;
    if (!first || !last || first.name !== 'EmphasisMark' || last.name !== 'EmphasisMark' || first.to >= last.from) return;
    ranges.push(Decoration.mark({ class: node.name === 'StrongEmphasis' ? 'li-live-strong' : 'li-live-emphasis' }).range(first.to, last.from));
    if (!selected(node.from, node.to)) { ranges.push(Decoration.replace({}).range(first.from, first.to)); ranges.push(Decoration.replace({}).range(last.from, last.to)); }
  } });
  for (const visible of view.visibleRanges) {
    const text = view.state.sliceDoc(visible.from, visible.to);
    const links = /(!?)\[\[([^\]\n]+)\]\]/g;
    for (const match of text.matchAll(links)) {
      const from = visible.from + match.index!, to = from + match[0].length;
      if (selected(from, to) || inCode(from, to)) continue;
      const [target, ...alias] = match[2].split('|');
      ranges.push(Decoration.replace({ widget: new WikiLink(app, sourcePath, target, alias.join('|'), !!match[1], from, to) }).range(from, to));
    }
  }
  return Decoration.set(ranges, true);
}

export function createLiveMarkdown(app: App, parent: HTMLElement, value: string, sourcePath: string, onChange: (value: string) => void) {
  const extension = ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = decorations(view, app, sourcePath); }
    update(update: ViewUpdate) { if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = decorations(update.view, app, sourcePath); }
  }, { decorations: v => v.decorations });
  return new EditorView({ parent, state: EditorState.create({ doc: value, extensions: [markdown(), history(), EditorView.lineWrapping, keymap.of([...defaultKeymap, ...historyKeymap]), extension, EditorView.contentAttributes.of({ 'aria-label': 'Markdown 内容' }), EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state.doc.toString()); })] }) });
}
