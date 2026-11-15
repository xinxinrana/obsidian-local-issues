export interface DraftSnapshot { names?: string[]; fields: string[]; editors: string[]; extra?: unknown; revision?: string; }
export interface DraftEditor { readonly value: string; setValue(value: string): void; }

export function isDraftSnapshot(value: unknown): value is DraftSnapshot {
  if (!value || typeof value !== 'object') return false;
  const draft = value as DraftSnapshot;
  return Array.isArray(draft.fields) && draft.fields.every(v => typeof v === 'string') && Array.isArray(draft.editors) && draft.editors.every(v => typeof v === 'string');
}
export interface DraftStorage {
  read(key: string): DraftSnapshot | undefined;
  write(key: string, value: DraftSnapshot | null): void;
  list?(): { key: string; value: DraftSnapshot }[];
  active?(): string | undefined;
  suspend?(): void;
  activate?(key: string): void;
}

export class Drafts {
  private failed = false;
  constructor(private storage: DraftStorage, private warn: (message: string) => void) {}
  read(key: string): DraftSnapshot | undefined { try { return this.storage.read(key); } catch (error) { this.report(error); } }
  list() { return this.storage.list?.() || []; }
  active() { return this.storage.active?.(); }
  suspend() { this.storage.suspend?.(); }
  activate(key: string) { this.storage.activate?.(key); }
  private report(error: unknown) {
    if (!this.failed) this.warn(`草稿暂存失败，请先保存内容，不要关闭页面：${error instanceof Error ? error.message : String(error)}`);
    this.failed = true;
  }
  private write(key: string, value: DraftSnapshot | null): boolean {
    try { this.storage.write(key, value); this.failed = false; return true; }
    catch (error) { this.report(error); return false; }
  }
  bind(root: HTMLElement, key: string, editors: DraftEditor[], options: { revision?: string; extra?: { read(): unknown; restore?(value: unknown): void } } = {}) {
    const fields = [...root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input:not([type="file"]), select, textarea')];
    const names = fields.map((field, index) => field.getAttribute('aria-label') || `field:${index}`);
    const cached = this.read(key);
    const revision = cached?.revision || options.revision;
    if (cached) {
      fields.forEach((field, index) => {
        const position = cached.names ? cached.names.indexOf(names[index]) : index;
        if (position < 0 || cached.fields[position] === undefined) return;
        field.value = cached.fields[position];
        field.dispatchEvent(new root.ownerDocument.defaultView!.Event('input', { bubbles: true }));
        field.dispatchEvent(new root.ownerDocument.defaultView!.Event('change', { bubbles: true }));
      });
      editors.forEach((editor, index) => { if (cached.editors[index] !== undefined) editor.setValue(cached.editors[index]); });
      options.extra?.restore?.(cached.extra);
      const status = root.createEl('p', { cls: 'li-draft-status li-muted', text: '已恢复本机草稿' }); status.setAttribute('role', 'status');
    }
    let active = true;
    const snapshot = (): DraftSnapshot => ({ names, fields: fields.map(field => field.value), editors: editors.map(editor => editor.value), ...(options.extra ? { extra: options.extra.read() } : {}), ...(revision ? { revision } : {}) });
    let previous = JSON.stringify(snapshot());
    if (cached && JSON.stringify(cached) !== previous) this.write(key, snapshot());
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
