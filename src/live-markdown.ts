import type { App } from 'obsidian';
import { createMarkdownEditor, type MarkdownHost } from './markdown-editor';
export { MARKDOWN_TOOLS } from './markdown-editor';

export function createLiveMarkdown(app: App, parent: HTMLElement, value: string, sourcePath: string, onChange: (value: string) => void, host: MarkdownHost = {}) {
  return createMarkdownEditor(parent, value, onChange, { ...host, image: target => {
    const file = app.metadataCache.getFirstLinkpathDest(target.split('#')[0], sourcePath);
    return file && /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(file.path) ? app.vault.getResourcePath(file) : undefined;
  } });
}
