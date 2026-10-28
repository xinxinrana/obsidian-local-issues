import { mkdtemp, mkdir, readFile, writeFile, readdir, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Store } from '../src/store';
import { startApi, type Share } from '../src/api';
import type { VaultAdapter } from '../src/types';

export async function fixture() {
  const vault = await mkdtemp(join(tmpdir(), 'local-issues-api-'));
  const adapter: VaultAdapter = {
    async list() {
      const result: string[] = [];
      async function visit(dir: string, prefix: string) {
        for (const file of await readdir(dir, { withFileTypes: true })) {
          const path = `${prefix}${file.name}`;
          if (file.isDirectory()) await visit(join(dir, file.name), `${path}/`); else result.push(path);
        }
      }
      await visit(vault, ''); return result;
    },
    read: path => readFile(join(vault, path), 'utf8'),
    async write(path, text) { await mkdir(dirname(join(vault, path)), { recursive: true }); await writeFile(join(vault, path), text); },
    async writeBinary(path, data) { await mkdir(dirname(join(vault, path)), { recursive: true }); await writeFile(join(vault, path), data); },
    async exists(path) { try { await access(join(vault, path)); return true; } catch { return false; } },
  };
  const store = new Store(adapter);
  const shares: Record<string, Share> = {};
  const server = await startApi({ store, port: 0, vaultName: 'Tests', shares, saveShares: async () => {},
    readAttachment: path => readFile(join(vault, path)) });
  const url = `http://127.0.0.1:${server.port}`;
  async function request(path: string, method = 'GET', body?: unknown, custom: Record<string, string> = {}) {
    const response = await fetch(new URL(path, url), { method, headers: { 'Content-Type': 'application/json', ...custom }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, ...(await response.json() as { ok: boolean; data?: any; error?: { code: string; message: string } }) };
  }
  return { vault, adapter, store, shares, server, url, request, async close() { await server.close(); await rm(vault, { recursive: true, force: true }); } };
}
