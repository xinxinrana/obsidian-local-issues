import test from 'node:test';
import assert from 'node:assert/strict';
import { DraftJournal } from '../src/draft-journal';
import type { DraftSnapshot } from '../src/drafts';

function fixture() {
  const files = new Map<string, string>(), folders = new Set<string>(), journal = new Map<string, string>(), warnings: string[] = [];
  const disk = { exists: async (path: string) => files.has(path) || folders.has(path), read: async (path: string) => files.get(path)!,
    write: async (path: string, value: string) => { files.set(path, value); }, mkdir: async (path: string) => { folders.add(path); }, list: async (path: string) => ({ files: [...files.keys()].filter(file => file.startsWith(path + '/')) }) };
  const options = { prefix: 'test-vault', directory: '.obsidian/plugins/local-issues/drafts', disk,
    journal: { getItem: (key: string) => journal.get(key) || null, setItem: (key: string, value: string) => { journal.set(key, value); } }, warn: (message: string) => warnings.push(message) };
  return { files, folders, journal, warnings, disk, options };
}
const snapshot = (text: string): DraftSnapshot => ({ fields: ['没创建完的标题，'], editors: [text] });

test('own journal survives abrupt reconstruction; disk restores without browser storage or host view state', async () => {
  const f = fixture(), first = new DraftJournal(f.options); await first.initialize();
  first.write('new-issue:p:', snapshot('第一字')); first.write('new-issue:p:', snapshot('第一字，后续输入和 ![[图片.png]]'));
  assert.ok(f.journal.get('test-vault:journal')!.includes('后续输入'), 'Journal commits in the same input call');
  const cold = new DraftJournal(f.options); await cold.initialize();
  assert.equal(cold.read('new-issue:p:')!.editors[0], '第一字，后续输入和 ![[图片.png]]');
  await first.flush(); await cold.flush(); f.journal.clear();
  const diskOnly = new DraftJournal(f.options); await diskOnly.initialize(); await diskOnly.flush();
  assert.equal(diskOnly.active(), 'new-issue:p:'); assert.deepEqual(diskOnly.read('new-issue:p:'), snapshot('第一字，后续输入和 ![[图片.png]]'));
  diskOnly.suspend(); await diskOnly.flush();
  const suspended = new DraftJournal(f.options); await suspended.initialize(); assert.equal(suspended.active(), undefined); assert.equal(suspended.list().length, 1);
  suspended.write('new-issue:p:', null); await suspended.flush(); f.journal.clear();
  const saved = new DraftJournal({ ...f.options, legacy: () => snapshot('旧版本缓存不得复活') }); await saved.initialize();
  assert.equal(saved.read('new-issue:p:'), undefined); assert.equal(saved.active(), undefined); assert.equal(saved.list().length, 0);
  await saved.flush(); assert.deepEqual(f.warnings, []);
});

test('write queue persists the newest input and retains a valid backup when a disk write fails', async () => {
  const f = fixture(), cache = new DraftJournal(f.options); await cache.initialize();
  cache.write('new-project', snapshot('原始输入')); await cache.flush();
  const write = f.disk.write;
  let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
  f.disk.write = async (path, value) => { await blocked; return write(path, value); };
  cache.write('new-project', snapshot('较早发起的保存')); cache.write('new-project', snapshot('写入期间继续打字')); release(); await cache.flush();
  assert.ok([...f.files.entries()].find(([path]) => path.endsWith('.json'))![1].includes('写入期间继续打字'));
  f.disk.write = async () => { throw new Error('disk unavailable'); };
  cache.write('new-project', snapshot('写磁盘失败也保留在即时记录中')); await assert.rejects(cache.flush(), /disk unavailable/);
  assert.ok(f.journal.get('test-vault:journal')!.includes('写磁盘失败也保留在即时记录中'));
  assert.equal(f.warnings.length, 1); assert.ok([...f.files.keys()].some(path => path.endsWith('.bak')));
  f.disk.write = write;
  const recovered = new DraftJournal(f.options); await recovered.initialize(); await recovered.flush();
  assert.equal(recovered.read('new-project')!.editors[0], '写磁盘失败也保留在即时记录中');
});
