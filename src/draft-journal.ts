import { randomUUID } from './platform-crypto';
import { isDraftSnapshot, type DraftSnapshot, type DraftStorage } from './drafts';

interface DraftFile { version: 1; updatedAt: number; active?: string; entries: Record<string, { at: number; value: DraftSnapshot | null }>; }
interface DraftDisk { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; write(path: string, value: string): Promise<void>; mkdir(path: string): Promise<void>; list(path: string): Promise<{ files: string[] }>; }
interface Options { prefix: string; directory: string; disk: DraftDisk; journal?: Pick<Storage, 'getItem' | 'setItem'>; legacy?(key: string): unknown; warn(message: string): void; }
const empty = (): DraftFile => ({ version: 1, updatedAt: 0, entries: {} });
function decode(raw: string | null): DraftFile | undefined {
  if (!raw) return;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') return;
  const file = value as DraftFile;
  if (file.version !== 1 || typeof file.updatedAt !== 'number' || !file.entries || typeof file.entries !== 'object') return;
  if (!Object.values(file.entries).every(entry => entry && typeof entry.at === 'number' && (entry.value === null || isDraftSnapshot(entry.value)))) return;
  return file;
}

/** Own journal and disk replica; neither view layout nor Obsidian local-storage helpers own drafts. */
export class DraftJournal implements DraftStorage {
  private data = empty();
  private file = '';
  private pending?: Promise<void>;
  private version = 0;
  private saved = 0;
  private lastDisk = '';
  private failed = false;
  constructor(private options: Options) {}
  async initialize(): Promise<void> {
    const { journal, prefix, disk, directory } = this.options;
    let device: string | null = null;
    try { device = journal?.getItem(`${prefix}:device`) || null; } catch { /* The disk replica remains available. */ }
    if (device && !/^[a-f0-9-]{36}$/.test(device)) device = null;
    const knownDevice = !!device;
    device ||= randomUUID(); this.file = `${directory}/${device}.json`;
    const candidates: DraftFile[] = [];
    try { const value = decode(journal?.getItem(`${prefix}:journal`) || null); if (value) candidates.push(value); } catch { /* Recover from disk below. */ }
    const paths = knownDevice ? [this.file, `${this.file}.bak`] : await disk.exists(directory) ? (await disk.list(directory)).files.filter(path => /\.json(?:\.bak)?$/.test(path)) : [];
    for (const path of paths) {
      try { if (await disk.exists(path)) { const raw = await disk.read(path), value = decode(raw); if (value) { candidates.push(value); if (path === this.file) this.lastDisk = raw; } } }
      catch (error) { this.warn(error); }
    }
    candidates.sort((a, b) => b.updatedAt - a.updatedAt);
    if (candidates[0]) {
      this.data = { ...candidates[0], entries: {} };
      // Merge a partially newer replica without discarding other recoverable drafts.
      for (const candidate of candidates) for (const [key, entry] of Object.entries(candidate.entries)) if (!this.data.entries[key] || this.data.entries[key].at < entry.at) this.data.entries[key] = entry;
    }
    try { journal?.setItem(`${prefix}:device`, device); journal?.setItem(`${prefix}:journal`, JSON.stringify(this.data)); } catch { /* Each input still queues a disk write. */ }
    if (candidates.length && this.lastDisk !== JSON.stringify(this.data)) { this.version++; void this.flush().catch(error => this.warn(error)); }
  }
  private warn(error: unknown) {
    if (!this.failed) this.options.warn(`草稿备份失败，请先保存内容，不要关闭页面：${error instanceof Error ? error.message : String(error)}`);
    this.failed = true;
  }
  read(key: string): DraftSnapshot | undefined {
    if (Object.hasOwn(this.data.entries, key)) return this.data.entries[key].value || undefined;
    const legacy = this.options.legacy?.(`local-issues:draft:${key}`);
    if (isDraftSnapshot(legacy)) { this.write(key, legacy); return legacy; }
  }
  list(): { key: string; value: DraftSnapshot }[] { return Object.entries(this.data.entries).filter(([, entry]) => !!entry.value).sort((a, b) => b[1].at - a[1].at).map(([key, entry]) => ({ key, value: entry.value! })); }
  active(): string | undefined { return this.data.active && this.read(this.data.active) ? this.data.active : undefined; }
  suspend(): void { if (this.data.active) { delete this.data.active; this.changed(); } }
  activate(key: string): void { if (this.read(key)) { this.data.active = key; this.changed(); } }
  write(key: string, value: DraftSnapshot | null): void {
    this.data.entries[key] = { at: Math.max(Date.now(), this.data.updatedAt + 1), value };
    if (value) this.data.active = key; else if (this.data.active === key) delete this.data.active;
    this.changed();
  }
  private changed() {
    this.data.updatedAt = Math.max(Date.now(), this.data.updatedAt + 1); this.version++;
    try { this.options.journal?.setItem(`${this.options.prefix}:journal`, JSON.stringify(this.data)); }
    catch (error) { this.warn(error); }
    void this.flush().catch(error => this.warn(error));
  }
  async flush(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.saved === this.version) return;
    let completed = false;
    this.pending = (async () => {
      const { disk, directory } = this.options;
      const parts = directory.split('/');
      for (let index = 1; index <= parts.length; index++) { const path = parts.slice(0, index).join('/'); if (!await disk.exists(path)) { try { await disk.mkdir(path); } catch (error) { if (!await disk.exists(path)) throw error; } } }
      while (this.saved !== this.version) {
        const version = this.version, raw = JSON.stringify(this.data);
        if (this.lastDisk) await disk.write(`${this.file}.bak`, this.lastDisk);
        await disk.write(this.file, raw); this.lastDisk = raw; this.saved = version;
      }
      completed = true;
    })();
    try { await this.pending; } finally { this.pending = undefined; if (completed && this.saved !== this.version) void this.flush().catch(error => this.warn(error)); }
  }
}
