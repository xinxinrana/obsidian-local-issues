import type { App } from 'obsidian';

export interface DraftSnapshot { fields: string[]; editors: string[]; extra?: unknown; revision?: string; }
export interface DraftEditor { readonly value: string; setValue(value: string): void; }

/** Vault-scoped, synchronous storage: no debounce window when a view or app closes. */
export class Drafts {
  private failed = false;
  constructor(private app: Pick<App, 'loadLocalStorage' | 'saveLocalStorage'>, private warn: (message: string) => void) {}
  read(key: string): DraftSnapshot | undefined {
    let value: unknown;
    try { value = this.app.loadLocalStorage?.(`local-issues:draft:${key}`); } catch (error) { this.report(error); return; }
    if (!value || typeof value !== 'object') return;
    const draft = value as DraftSnapshot;
    if (Array.isArray(draft.fields) && draft.fields.every(v => typeof v === 'string') && Array.isArray(draft.editors) && draft.editors.every(v => typeof v === 'string')) return draft;
  }
  private report(error: unknown) {
    if (!this.failed) this.warn(`草稿暂存失败，请先保存内容，不要关闭页面：${error instanceof Error ? error.message : String(error)}`);
    this.failed = true;
  }
  private write(key: string, value: DraftSnapshot | null): boolean {
    try { this.app.saveLocalStorage?.(`local-issues:draft:${key}`, value); this.failed = false; return true; }
    catch (error) { this.report(error); return false; }
  }
  bind(root: HTMLElement, key: string, editors: DraftEditor[], options: { revision?: string; extra?: { read(): unknown; restore?(value: unknown): void } } = {}) {
    const fields = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type="file"]), select, textarea')];
    const cached = this.read(key);
    const revision = cached?.revision || options.revision;
    if (cached) {
      fields.forEach((field, index) => {
        if (cached.fields[index] === undefined) return;
        field.value = cached.fields[index];
        field.dispatchEvent(new root.ownerDocument.defaultView!.Event('input', { bubbles: true }));
        field.dispatchEvent(new root.ownerDocument.defaultView!.Event('change', { bubbles: true }));
      });
      editors.forEach((editor, index) => { if (cached.editors[index] !== undefined) editor.setValue(cached.editors[index]); });
      options.extra?.restore?.(cached.extra);
      const status = root.createEl('p', { cls: 'li-draft-status li-muted', text: '已恢复本机草稿' }); status.setAttribute('role', 'status');
    }
    let active = true;
    const snapshot = (): DraftSnapshot => ({ fields: fields.map(field => field.value), editors: editors.map(editor => editor.value), ...(options.extra ? { extra: options.extra.read() } : {}), ...(revision ? { revision } : {}) });
    let previous = JSON.stringify(snapshot());
    const save = () => {
      if (!active) return;
      const value = snapshot(), serialized = JSON.stringify(value);
      if (serialized !== previous && this.write(key, value)) previous = serialized;
    };
    for (const event of ['input', 'change', 'click', 'li-editor-change']) root.addEventListener(event, save);
    return { revision, snapshot, save,
      complete: (submitted: DraftSnapshot) => {
        // A delayed save must not delete input made after that save started.
        if (JSON.stringify(this.read(key)) === JSON.stringify(submitted)) this.write(key, null);
        active = false;
      },
    };
  }
}
