import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { ResourceRoutes, parseResource, slug } from './routes';
import { attachmentPath, attachmentReferences, escapeHtml, htmlDocument, renderMarkdown, renderPage } from './web';
import { startWebClient } from './web-client';
import { agentSkill } from './agent-skill';
import type { Issue, IssuePatch, IssueStore, ProjectPatch, Resolved, Snapshot } from './types';

export interface Share { ref: string }
export interface ApiOptions {
  store: IssueStore; port: number; vaultName: string;
  shares: Record<string, Share>; saveShares: () => Promise<void>;
  routes?: ResourceRoutes;
  open?: (ref: string) => Promise<void>;
  readAttachment?: (path: string) => Promise<Uint8Array>;
  readCli?: () => Promise<string>;
  author?: string;
}
const MAX_BODY = 24 * 1024 * 1024;
class HttpError extends Error { constructor(public status: number, message: string, public code = 'INVALID_REQUEST') { super(message); } }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请求正文必须是 JSON 对象。');
  return value as Record<string, unknown>;
}
function str(value: unknown, name: string, required = true): string {
  if (typeof value !== 'string' || (required && !value.trim())) throw new HttpError(400, `${name} 必须是${required ? '非空' : ''}字符串。`);
  return value;
}
function pick<T>(data: Record<string, unknown>, names: string[]): T {
  const result: Record<string, unknown> = {};
  for (const name of names) if (Object.hasOwn(data, name)) result[name] = data[name];
  return result as T;
}
const PROJECT_FIELDS = ['title', 'description', 'status', 'dueDate'];
const ISSUE_FIELDS = ['title', 'body', 'status', 'closeReason', 'labels', 'milestone', 'assignees', 'parent', 'dependencies', 'dueDate', 'author'];
function issueUpdate(body: Record<string, unknown>): IssuePatch {
  return { ...pick<IssuePatch>(body, ISSUE_FIELDS.filter(k => k !== 'author')), actor: typeof body.actor === 'string' ? body.actor : typeof body.author === 'string' ? body.author : 'Agent' };
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new HttpError(413, '请求过大，单次附件最大 16 MB。', 'TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  if (!bytes) return {};
  try { return object(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'JSON 格式不正确。'); }
}
function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Accept' });
  res.end(JSON.stringify(value));
}
function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', Vary: 'Accept',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
  res.end(html);
}
function acceptsHtml(accept = ''): boolean {
  const types = accept.split(',').map(part => { const [type, ...params] = part.trim().toLowerCase().split(';');
    const quality = params.find(p => p.trim().startsWith('q=')); return { type, q: quality ? Number(quality.trim().slice(2)) : 1 }; });
  const html = types.find(t => t.type === 'text/html')?.q ?? 0;
  return html > 0 && html > (types.find(t => t.type === 'application/json')?.q ?? 0);
}
function expected(req: IncomingMessage, body: Record<string, unknown>): string | undefined {
  const value = req.headers['if-match'] ?? body.expectedUpdatedAt;
  return typeof value === 'string' ? value.replace(/^"|"$/g, '') : undefined;
}
function issueDetail(issue: Issue, snapshot: Snapshot): Record<string, unknown> {
  const timeline = snapshot.timeline.filter(item => item.issueId === issue.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { issue, project: snapshot.projects.find(p => p.id === issue.projectId), timeline,
    comments: timeline.filter(t => t.kind === 'comment'), subIssues: snapshot.issues.filter(i => i.parent === issue.id),
    dependencies: snapshot.issues.filter(i => issue.dependencies.includes(i.id)) };
}
function filteredIssues(snapshot: Snapshot, query: URLSearchParams, projectId?: string): Issue[] {
  let result = snapshot.issues.filter(i => !projectId || i.projectId === projectId);
  const state = query.get('state') ?? query.get('status');
  if (state && state !== 'all') result = result.filter(i => i.status === state || (state === 'open' && i.status === 'in-progress'));
  const q = (query.get('search') ?? query.get('q') ?? '').toLocaleLowerCase();
  if (q) result = result.filter(i => {
    const text = `${i.title}\n${i.body}\n${i.labels.join(' ')}\n${i.number}\n${snapshot.timeline.filter(t => t.issueId === i.id && t.kind === 'comment').map(t => t.body).join('\n')}`.toLocaleLowerCase();
    return (q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).every(token => {
      const [key, ...parts] = token.split(':'), value = parts.join(':').replace(/^"|"$/g, '');
      if (key === 'state' || key === 'is') return value === 'open' ? i.status !== 'closed' : i.status === value;
      if (key === 'label') return i.labels.some(x => x.toLocaleLowerCase() === value);
      if (key === 'milestone') return i.milestone.toLocaleLowerCase() === value;
      if (key === 'assignee') return i.assignees.some(x => x.toLocaleLowerCase() === value);
      return text.includes(token.replace(/^"|"$/g, ''));
    });
  });
  for (const label of query.getAll('label')) result = result.filter(i => i.labels.includes(label));
  if (query.has('milestone')) result = result.filter(i => i.milestone === query.get('milestone'));
  for (const assignee of query.getAll('assignee')) result = result.filter(i => i.assignees.includes(assignee));
  const sort = query.get('sort');
  result.sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'created' ? a.createdAt.localeCompare(b.createdAt) : sort === 'due' ? (a.dueDate || '9999').localeCompare(b.dueDate || '9999') : b.updatedAt.localeCompare(a.updatedAt));
  const limit = query.get('limit');
  if (limit) result = result.slice(0, Math.max(0, Math.min(10000, Number(limit) || 30)));
  return result;
}

export async function startApi(options: ApiOptions): Promise<{ close: () => Promise<void>; port: number }> {
  const { store } = options;
  const routes = options.routes ?? new ResourceRoutes(slug(options.vaultName));
  let actualPort = options.port;
  const attachmentKey = randomBytes(32);
  const access = (ref: string, path: string) => createHmac('sha256', attachmentKey).update(`${ref}\0${path}`).digest('hex');
  const attachmentUrl = (ref: string, path: string) => `/api/attachments?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}&access=${access(ref, path)}`;
  async function attach(ref: string, body: Record<string, unknown>) {
    const name = str(body.name, 'name'), base64 = str(body.base64, 'base64');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) throw new HttpError(400, '附件必须是有效 base64。');
    const bytes = Buffer.from(base64, 'base64');
    if (bytes.length > 16 * 1024 * 1024) throw new HttpError(413, '单次附件最大 16 MB。', 'TOO_LARGE');
    return store.attach(ref, name, bytes);
  }
  async function detail(ref: string, project?: string): Promise<Record<string, unknown>> {
    return issueDetail(await store.getIssue(ref, project), await store.snapshot());
  }
  async function resolvedDetail(resolved: Resolved, scoped = false): Promise<unknown> {
    if (resolved.kind === 'issue') {
      const result = await detail(resolved.value.id);
      if (scoped) {
        const project = result.project as { id: string; title: string } | undefined;
        const compact = (items: unknown) => (items as Issue[]).map(i => ({ id: i.id, number: i.number, title: i.title, status: i.status }));
        return { kind: 'issue', issue: result.issue, project: project ? { id: project.id, title: project.title } : undefined,
          timeline: result.timeline, comments: result.comments, subIssues: compact(result.subIssues), dependencies: compact(result.dependencies) };
      }
      return { kind: 'issue', ...result };
    }
    if (resolved.kind === 'project') {
      const snap = await store.snapshot();
      return { kind: 'project', project: resolved.value, issues: snap.issues.filter(i => i.projectId === resolved.value.id) };
    }
    return resolved;
  }
  const server = createServer((req, res) => {
    let browserHtml = false;
    void (async () => {
      const host = req.headers.host ?? '';
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) throw new HttpError(403, '只接受本机地址。', 'FORBIDDEN');
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort}`);
      let parts = url.pathname.split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch { throw new HttpError(400, '地址编码不正确。'); } });
      const method = req.method ?? 'GET';
      const shared = parts[0] === 'api' && parts[1] === 'shares' && !!parts[2];
      const resource = url.pathname === '/llms.txt' ? undefined : parseResource(url);
      browserHtml = method === 'GET' && acceptsHtml(req.headers.accept) && ((!!resource && !resource.suffix.length) || (shared && parts.length <= 4 && (!parts[3] || parts[3] === 'resolve')));
      const origin = `http://${host}`;
      const webRequest = req.headers['x-local-issues'] === 'web' && req.headers['sec-fetch-site'] === 'same-origin' &&
        (method === 'GET' ? !req.headers.origin || req.headers.origin === origin : req.headers.origin === origin && /^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''));
      const browserRead = browserHtml || (method === 'GET' && ['/api/attachments', '/api/web-client.js', '/api/cli.mjs', '/llms.txt'].includes(url.pathname));
      if (!webRequest && ((req.headers.origin && (!browserRead || req.headers.origin !== origin)) ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none' && !(browserRead && req.headers['sec-fetch-site'] === 'same-origin')))) {
        throw new HttpError(403, '只允许本机 CLI 或同源页面读取。', 'FORBIDDEN');
      }
      if (method === 'GET' && ['/api/web-client.js', '/api/cli.mjs', '/llms.txt'].includes(url.pathname)) {
        const cli = url.pathname === '/api/cli.mjs';
        if (cli && !options.readCli) throw new HttpError(404, '请将 cli.mjs 放入插件目录。', 'NOT_FOUND');
        const text = cli ? await options.readCli!() : url.pathname === '/llms.txt'
          ? `# Local Issues\n\n本地网页可管理项目、议题、评论、状态和附件，与 Obsidian 共用 Markdown 数据。\n\nCLI 下载：http://localhost:${actualPort}/api/cli.mjs\n保存为 cli.mjs，需要 Node.js 22+。不需要登录或密钥。\n\n${agentSkill('./cli.mjs', actualPort)}`
          : `(${startWebClient.toString()})();`;
        res.writeHead(200, { 'Content-Type': url.pathname === '/llms.txt' ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', ...(cli ? { 'Content-Disposition': 'attachment; filename="cli.mjs"' } : {}) });
        res.end(text); return;
      }
      if (method === 'POST' && url.pathname === '/api/preview') {
        const body = await readBody(req), ref = typeof body.ref === 'string' ? body.ref : '';
        const resolved = ref ? await store.resolve(ref) : undefined;
        if (resolved?.kind === 'note') throw new HttpError(400, '预览仅支持项目和议题。');
        await routes.sync(store);
        const snapshot = await store.snapshot();
        send(res, 200, { ok: true, data: { html: renderMarkdown(str(body.body, 'body', false), { snapshot, routes, vaultName: options.vaultName,
          attachmentUrl, project: resolved?.kind === 'project' ? resolved.value : undefined, issue: resolved?.kind === 'issue' ? resolved.value : undefined }) } }); return;
      }
      if (method === 'GET' && url.pathname === '/api/health') { send(res, 200, { ok: true, data: { name: 'Local Issues', version: '0.1.6' } }); return; }
      if (method === 'GET' && url.pathname === '/api/attachments') {
        const path = attachmentPath(url.searchParams.get('path') ?? '');
        if (!path || !options.readAttachment) throw new HttpError(404, '附件不存在。', 'NOT_FOUND');
        const ref = str(url.searchParams.get('ref') ?? url.searchParams.get('issue'), 'ref');
        const resolved = await store.resolve(ref);
        if (resolved.kind === 'note') throw new HttpError(404, '附件不存在。', 'NOT_FOUND');
        const snapshot = await store.snapshot();
        const texts = resolved.kind === 'issue' ? [resolved.value.body, ...snapshot.timeline.filter(t => t.issueId === resolved.value.id && t.kind === 'comment').map(t => t.body)] : [resolved.value.description];
        if (url.searchParams.get('access') !== access(resolved.value.id, path) && !texts.some(text => attachmentReferences(text).has(path))) throw new HttpError(404, '议题中未引用此附件。', 'NOT_FOUND');
        const bytes = await options.readAttachment(path);
        if (bytes.byteLength > 16 * 1024 * 1024) throw new HttpError(413, '附件超过 16 MB，请在 Obsidian 中打开。', 'TOO_LARGE');
        const ext = path.split('.').at(-1)!.toLowerCase();
        const images: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' };
        res.writeHead(200, { 'Content-Type': images[ext] ?? 'application/octet-stream', 'Content-Length': bytes.byteLength,
          'Content-Disposition': `${images[ext] ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(path.split('/').at(-1)!)}`,
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
          'Content-Security-Policy': "default-src 'none'; sandbox" });
        res.end(Buffer.from(bytes)); return;
      }
      if (resource) {
        const path = await routes.translate(store, resource);
        if (browserHtml) {
          await routes.sync(store);
          const snapshot = await store.snapshot();
          const project = resource.project ? snapshot.projects.find(p => routes.projects[p.id] === resource.project) : undefined;
          const issue = resource.kind === 'issue' ? snapshot.issues.find(i => i.projectId === project?.id && i.number === resource.number) : undefined;
          // Keep both tab counts within the current search/attribute filters.
          const query = new URLSearchParams(url.search); query.delete('state'); query.delete('status'); query.delete('limit');
          sendHtml(res, 200, renderPage({ snapshot, routes, vaultName: options.vaultName, url, project, issue, attachmentUrl, author: options.author,
            issues: project ? filteredIssues(snapshot, query, project.id) : undefined })); return;
        }
        if (!path) {
          if (method !== 'GET') throw new HttpError(405, '仓库入口仅支持读取。', 'METHOD_NOT_ALLOWED');
          const projects = await routes.sync(store);
          send(res, 200, { ok: true, data: { kind: 'repo', name: options.vaultName, slug: routes.repo, projects } }); return;
        }
        const translated = new URL(path, url);
        for (const [key, value] of translated.searchParams) url.searchParams.set(key, value);
        parts = translated.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      }
      if (parts[0] !== 'api') throw new HttpError(404, '接口不存在。', 'NOT_FOUND');
      let data: unknown;
      let status = 200;
      if (shared) {
        const share = Object.hasOwn(options.shares, parts[2]) ? options.shares[parts[2]] : undefined;
        if (!share) throw new HttpError(404, '旧分享链接不存在。', 'NOT_FOUND');
        const resolved = await store.resolve(share.ref);
        if (resolved.kind === 'note') throw new HttpError(403, '分享仅支持项目和 Issue。', 'FORBIDDEN');
        if (browserHtml) {
          await routes.sync(store);
          const snapshot = await store.snapshot();
          const issue = resolved.kind === 'issue' ? resolved.value : undefined;
          const fullProject = snapshot.projects.find(p => p.id === (issue?.projectId ?? resolved.value.id));
          const project = issue && fullProject ? { ...fullProject, description: '' } : fullProject;
          const scoped = { ...snapshot, projects: project ? [project] : [],
            issues: snapshot.issues.filter(i => issue ? i.id === issue.id : i.projectId === project?.id),
            timeline: snapshot.timeline.filter(t => issue ? t.issueId === issue.id : snapshot.issues.some(i => i.projectId === project?.id && i.id === t.issueId)), warnings: [] };
          sendHtml(res, 200, renderPage({ snapshot: scoped, routes, vaultName: options.vaultName, url, project, issue, attachmentUrl, author: options.author })); return;
        }
        if (parts.length <= 4 && (!parts[3] || parts[3] === 'resolve')) {
          if (method === 'GET') data = await resolvedDetail(resolved, true);
          else if (method === 'PATCH') {
            const body = await readBody(req);
            data = resolved.kind === 'issue'
              ? await store.updateIssue(resolved.value.id, issueUpdate(body), expected(req, body))
              : await store.updateProject(resolved.value.id, pick<ProjectPatch>(body, PROJECT_FIELDS), expected(req, body));
          } else throw new HttpError(405, '此分享入口支持 GET 和 PATCH。', 'METHOD_NOT_ALLOWED');
        } else if (parts.length === 4 && parts[3] === 'comments' && method === 'POST' && resolved.kind === 'issue') {
          const body = await readBody(req); data = await store.addComment(resolved.value.id, str(body.body, 'body'), typeof body.author === 'string' ? body.author : 'Agent'); status = 201;
        } else if (parts.length === 5 && parts[3] === 'comments' && (method === 'PATCH' || method === 'DELETE') && resolved.kind === 'issue') {
          const entry = (await store.snapshot()).timeline.find(item => item.id === parts[4] && item.issueId === resolved.value.id && item.kind === 'comment');
          if (!entry) throw new HttpError(403, '此评论不属于分享的 Issue。', 'FORBIDDEN');
          const body = await readBody(req);
          if (method === 'DELETE') { await store.deleteComment(entry.id, expected(req, body)); data = { deleted: true }; }
          else data = await store.editComment(entry.id, str(body.body, 'body'), expected(req, body));
        } else throw new HttpError(404, '分享接口不存在。', 'NOT_FOUND');
      } else if (parts[1] === 'links' && parts.length === 2 && method === 'GET') {
        const path = await routes.path(store, url.searchParams.get('ref') ?? undefined, url.searchParams.get('scope') === 'issues' ? 'issues' : undefined);
        data = { url: `http://localhost:${actualPort}${decodeURI(path)}` };
      } else if (parts[1] === 'projects') {
        if (parts.length === 2 && method === 'GET') {
          const snap = await store.snapshot();
          data = snap.projects.filter(p => !url.searchParams.get('state') || url.searchParams.get('state') === 'all' || p.status === url.searchParams.get('state'))
            .filter(p => !url.searchParams.get('search') || `${p.title}\n${p.description}`.toLowerCase().includes(url.searchParams.get('search')!.toLowerCase()))
            .map(p => { const issues = snap.issues.filter(i => i.projectId === p.id); return { ...p, issueCount: issues.length, closedCount: issues.filter(i => i.status === 'closed').length }; });
        } else if (parts.length === 2 && method === 'POST') {
          const body = await readBody(req); data = await store.createProject({ ...pick<ProjectPatch>(body, PROJECT_FIELDS), title: str(body.title, 'title') }); status = 201;
        } else if (parts.length === 3 && method === 'GET') {
          const project = await store.getProject(parts[2]); data = { project, issues: (await store.snapshot()).issues.filter(i => i.projectId === project.id) };
        } else if (parts.length === 3 && method === 'PATCH') {
          const body = await readBody(req); data = await store.updateProject(parts[2], pick<ProjectPatch>(body, PROJECT_FIELDS), expected(req, body));
        } else if (parts.length === 4 && parts[3] === 'attachments' && method === 'POST') {
          const project = await store.getProject(parts[2]); data = await attach(project.id, await readBody(req)); status = 201;
        } else throw new HttpError(404, '项目接口不存在。', 'NOT_FOUND');
      } else if (parts[1] === 'issues') {
        const project = url.searchParams.get('project') ?? undefined;
        if (parts.length === 2 && method === 'GET') {
          const projectId = project ? (await store.getProject(project)).id : undefined;
          data = filteredIssues(await store.snapshot(), url.searchParams, projectId);
        } else if (parts.length === 2 && method === 'POST') {
          const body = await readBody(req);
          data = await store.createIssue(str(body.project ?? project, 'project'), { ...pick<IssuePatch>(body, ISSUE_FIELDS), title: str(body.title, 'title') }); status = 201;
        } else if (parts.length >= 3) {
          const issue = await store.getIssue(parts[2], project);
          if (parts.length === 3 && method === 'GET') data = await detail(issue.id);
          else if (parts.length === 3 && method === 'PATCH') { const body = await readBody(req); data = await store.updateIssue(issue.id, issueUpdate(body), expected(req, body)); }
          else if (parts.length === 4 && method === 'POST') {
            const body = await readBody(req);
            if (parts[3] === 'comments') { data = await store.addComment(issue.id, str(body.body, 'body'), typeof body.author === 'string' ? body.author : 'Agent'); status = 201; }
            else if (parts[3] === 'close' || parts[3] === 'reopen') data = await store.updateIssue(issue.id, { status: parts[3] === 'close' ? 'closed' : 'open', ...(typeof body.closeReason === 'string' && parts[3] === 'close' ? { closeReason: body.closeReason as IssuePatch['closeReason'] } : {}), actor: typeof body.actor === 'string' ? body.actor : typeof body.author === 'string' ? body.author : 'Agent' }, expected(req, body));
            else if (parts[3] === 'attachments') {
              data = await attach(issue.id, body); status = 201;
            } else if (parts[3] === 'open' && options.open) { await options.open(issue.id); data = { opened: true }; }
            else throw new HttpError(404, 'Issue 接口不存在。', 'NOT_FOUND');
          } else throw new HttpError(404, 'Issue 接口不存在。', 'NOT_FOUND');
        } else throw new HttpError(404, 'Issue 接口不存在。', 'NOT_FOUND');
      } else if (parts[1] === 'comments' && parts.length === 3 && method === 'PATCH') {
        const body = await readBody(req); data = await store.editComment(parts[2], str(body.body, 'body'), expected(req, body));
      } else if (parts[1] === 'comments' && parts.length === 3 && method === 'DELETE') {
        const body = await readBody(req); await store.deleteComment(parts[2], expected(req, body)); data = { deleted: true };
      } else if (parts[1] === 'open' && parts.length === 2 && method === 'POST' && options.open) {
        const body = await readBody(req); await options.open(str(body.ref, 'ref')); data = { opened: true };
      } else if (parts[1] === 'resolve' && parts.length === 2 && method === 'GET') {
        data = await resolvedDetail(await store.resolve(str(url.searchParams.get('ref'), 'ref')));
      } else if (parts[1] === 'shares' && parts.length === 2 && method === 'POST') {
        const body = await readBody(req), resolved = await store.resolve(str(body.ref, 'ref'));
        if (resolved.kind === 'note') throw new HttpError(400, '分享入口只支持项目或 Issue。');
        const id = `s-${randomBytes(12).toString('hex')}`;
        options.shares[id] = { ref: resolved.value.id };
        try { await options.saveShares(); } catch (e) { delete options.shares[id]; throw e; }
        data = { id, url: `http://127.0.0.1:${actualPort}/api/shares/${id}/resolve`, ref: resolved.value.id }; status = 201;
      } else throw new HttpError(404, '接口不存在。', 'NOT_FOUND');
      send(res, status, { ok: true, data });
    })().catch((error: unknown) => {
      if (res.headersSent) { res.end(); return; }
      const message = error instanceof Error ? error.message : '操作失败。';
      const explicit = error as { status?: number; code?: string };
      const status = explicit.status ?? (/conflict|changed|冲突|已被|已修改|更新后|过期/i.test(message) ? 409 : /not found|不存在|未找到|找不到/i.test(message) ? 404 : 400);
      if (browserHtml) sendHtml(res, status, htmlDocument('无法打开', `<main><h1>无法打开此页面</h1><p>${escapeHtml(message)}</p><a href="/">返回项目</a></main>`));
      else send(res, status, { ok: false, error: { code: explicit.code ?? (status === 409 ? 'CONFLICT' : status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST'), message } });
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  actualPort = (server.address() as { port: number }).port;
  return { port: actualPort, close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); }) };
}
