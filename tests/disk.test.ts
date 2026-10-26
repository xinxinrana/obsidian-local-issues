import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from '../src/store';
import { fixture } from './api-fixture';

test('disk edits immediately reach API and installed CLI; a fresh Store reconstructs complete persisted data', { timeout: 30000 }, async () => {
  const f = await fixture();
  try {
    const project = await f.store.createProject({ title: '磁盘项目', description: '项目说明' });
    const issue = await f.store.createIssue(project.id, { title: 'Issue', body: 'before', author: 'Evan' });
    const first = await f.store.addComment(issue.id, 'First');
    await f.store.addComment(issue.id, 'Second', 'Agent');
    await f.store.editComment(first.id, 'First edited');
    const attached = await f.store.attach(issue.id, 'picture.png', new Uint8Array([137, 80, 78, 71]));
    await f.store.addComment(issue.id, attached.markdown);
    await f.store.updateIssue(issue.id, { status: 'closed', actor: 'Agent' });
    await f.store.updateIssue(issue.id, { status: 'open', actor: 'Agent' });
    const prior = await f.store.getIssue(issue.id);
    const fullPath = join(f.vault, issue.path), raw = await readFile(fullPath, 'utf8');
    await writeFile(fullPath, raw.replace('title: Issue', 'title: Human edit\n# 用户注释\ncustom: keep').replace('\nbefore\n', '\n人直接修改 [[设计稿]]\n'));
    const fromApi = await f.request(`/api/issues/${issue.id}`);
    assert.equal(fromApi.status, 200); assert.equal(fromApi.data.issue.body, '人直接修改 [[设计稿]]');
    assert.equal(fromApi.data.issue.updatedAt, prior.updatedAt); assert.notEqual(fromApi.data.issue.revision, prior.revision);
    const stale = await f.request(`/api/issues/${issue.id}`, 'PATCH', { body: 'stale' }, { 'If-Match': prior.revision! });
    assert.equal(stale.status, 409);
    const pluginDir = join(f.vault, '.obsidian/plugins/local-issues'), cli = join(pluginDir, 'cli.mjs');
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, 'data.json'), JSON.stringify({ port: f.server.port, token: f.token }));
    await build({ entryPoints: [resolve('src/cli.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
    const cliResult = await new Promise<{ code: number; stdout: string; stderr: string }>((resolveResult, reject) => {
      // Omit --vault to verify installation-directory discovery.
      const child = spawn(process.execPath, [cli, 'issue', 'view', issue.id, '--json'], { env: { ...process.env, LOCAL_ISSUES_TOKEN: '', LOCAL_ISSUES_URL: '', LOCAL_ISSUES_VAULT: '' } });
      let stdout = '', stderr = ''; child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
      child.on('error', reject); child.on('close', code => resolveResult({ code: code ?? 1, stdout, stderr }));
    });
    assert.equal(cliResult.code, 0, cliResult.stderr);
    const fromCli = JSON.parse(cliResult.stdout); assert.equal(fromCli.body, '人直接修改 [[设计稿]]'); assert.equal(fromCli.comments.length, 3); assert.equal(fromCli.timeline.length, 5);
    const freshPatch = await f.request(`/api/issues/${issue.id}`, 'PATCH', { labels: ['manual'] }, { 'If-Match': fromCli.revision });
    assert.equal(freshPatch.status, 200); assert.match(await readFile(fullPath, 'utf8'), /# 用户注释\ncustom: keep/);
    const before = await f.store.snapshot();
    // No database, cache or serialized Store state is passed to this new instance.
    const restarted = new Store(f.adapter); assert.deepEqual(await restarted.snapshot(), before);
    assert.deepEqual([...await readFile(join(f.vault, attached.path))], [137, 80, 78, 71]);
    assert.equal(before.warnings.length, 0);
  } finally { await f.close(); }
});
