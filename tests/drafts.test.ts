import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';
import { Drafts } from '../src/drafts';
const mock = createRequire(import.meta.url)('./obsidian-mock.cjs');

test('draft input is synchronous and an older successful save cannot clear newer input', () => {
  const dom = new JSDOM('<body></body>'); mock.installDom(dom.window);
  const storage = new Map<string, string>(), warnings: string[] = [];
  const app = { loadLocalStorage: (key: string) => storage.has(key) ? JSON.parse(storage.get(key)!) : null,
    saveLocalStorage: (key: string, value: unknown) => { if (value === null) storage.delete(key); else storage.set(key, JSON.stringify(value)); } };
  const cache = new Drafts(app, message => warnings.push(message));
  const form = dom.window.document.body.createDiv(), field = form.createEl('input');
  const binding = cache.bind(form, 'body:1', [], { revision: 'original' });
  field.value = '正在输入的'; field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  assert.equal(cache.read('body:1')!.fields[0], '正在输入的');
  const submitted = binding.snapshot();
  field.value = '正在输入的第二句话，'; form.dispatchEvent(new dom.window.Event('input'));
  binding.complete(submitted);
  assert.equal(cache.read('body:1')!.fields[0], '正在输入的第二句话，');
  const next = dom.window.document.body.createDiv(), restored = next.createEl('input');
  const recovered = new Drafts(app, message => warnings.push(message)).bind(next, 'body:1', [], { revision: 'newer' });
  assert.equal(restored.value, '正在输入的第二句话，'); assert.equal(recovered.revision, 'original');
  recovered.complete(recovered.snapshot()); assert.equal(cache.read('body:1'), undefined);
  assert.deepEqual(warnings, []); dom.window.close();
});

test('storage failure is visible, keeps the current input and does not repeatedly flood notices', () => {
  const dom = new JSDOM('<body></body>'); mock.installDom(dom.window);
  const warnings: string[] = [];
  const cache = new Drafts({ loadLocalStorage: () => null, saveLocalStorage: () => { throw new Error('QuotaExceededError'); } }, message => warnings.push(message));
  const form = dom.window.document.body.createDiv(), field = form.createEl('input'); cache.bind(form, 'new', []);
  field.value = '仍保留在编辑器里的正文';
  form.dispatchEvent(new dom.window.Event('input')); form.dispatchEvent(new dom.window.Event('input'));
  assert.equal(field.value, '仍保留在编辑器里的正文'); assert.equal(warnings.length, 1); assert.match(warnings[0], /草稿暂存失败.*QuotaExceededError/);
  dom.window.close();
});
