#!/usr/bin/env node
import { parseResource } from './routes';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

type Flags = Record<string, string | boolean | string[]>;
const HELP = `Local Issues · Obsidian 本地项目与 Issues

用法: local-issues <命令> [参数] [选项]

  view <语义化URL>
  repo view <仓库URL> | link
  project list | view <项目> | create | edit <项目> | share <项目>
  issue list | view <编号/双链/ID/分享URL> | create | edit <引用>
  issue comment <引用> | close <引用> | reopen <引用>
  issue attach <引用> <文件> | share <引用>
  comment edit <评论ID> --body "内容"
  share view <分享URL> | edit <分享URL> | comment <分享URL>
  share comment-edit <分享URL> <评论ID> --body "内容"
  resolve '[[笔记或Issue]]'
  api <接口路径> [-X METHOD] [-f key=value]

常用选项:
  -c, --comments            显示评论与状态时间线
  -P, --project <名称/ID>    指定项目（Issue 编号在项目内唯一）
  -t, --title <标题>        项目或 Issue 标题
  -b, --body <Markdown>     描述或评论内容
  -F, --body-file <文件>    从文件读正文；用 - 从标准输入读取
  -s, --state <状态>        open / closed / all
  -l, --label <标签>        可多次使用，或用逗号分隔
  -a, --assignee <名字>     可多次使用
      --reason <原因>       completed / on-hold / not-planned（关闭原因）
      --milestone <名称>   里程碑
      --parent <Issue>     父议题；空字符串可清除
      --depends-on <Issue> 依赖；可多次使用
      --due-date YYYY-MM-DD
      --author <名字>      评论或创建者，默认 Agent
  -S, --search <关键词>    搜索标题、正文、标签
  -L, --limit <数量>       列表上限，默认 30
      --json [字段,字段]   输出 JSON，省略字段输出完整对象
      --web                在 Obsidian 中打开
      --vault <笔记库路径> 使用该笔记库的本地 API 设置
      --if-match <时间>    仅当 updatedAt 匹配时修改，防止覆盖

示例:
  local-issues project create -t "我的项目"
  local-issues issue create -P "我的项目" -t "支持图片" -b "说明 [[设计稿]]"
  local-issues issue comment 1 -P "我的项目" -F comment.md
  local-issues issue list -P "我的项目" --state all --json number,title,status
  local-issues issue attach 1 -P "我的项目" screenshot.png
  local-issues issue share '[[Local Issues/项目/issues/0001]]'

需要在 Obsidian 中启用 Local Issues 和本地 API。API 只监听本机。
语义化链接仅定位资源，无需登录或密钥；旧分享链接继续兼容。`;

const aliases: Record<string, string> = { c: 'comments', P: 'project', t: 'title', b: 'body', F: 'body-file', l: 'label', a: 'assignee', s: 'state', S: 'search', L: 'limit', h: 'help', X: 'method', f: 'field', H: 'header' };
const booleans = new Set(['help', 'web', 'comment', 'comments']);
const multiples = new Set(['label', 'assignee', 'depends-on', 'add-label', 'remove-label', 'field', 'header']);
const allowed = new Set(['project','title','body','body-file','state','status','label','assignee','milestone','parent','depends-on','due-date','author','search','limit','json','web','vault','url','if-match','help','method','field','header','comment','add-label','remove-label','description','comments','reason']);
function parse(argv: string[]): { args: string[]; flags: Flags } {
  const args: string[] = [], flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { args.push(...argv.slice(i + 1)); break; }
    if (!arg.startsWith('-') || arg === '-') { args.push(arg); continue; }
    const match = /^--?([^=]+)(?:=(.*))?$/.exec(arg)!;
    const key = aliases[match[1]] ?? match[1];
    if (!allowed.has(key)) throw new Error(`未知选项 ${arg}；运行 local-issues --help 查看用法。`);
    let value: string | boolean = match[2] ?? true;
    if (key === 'json') {
      if (match[2] === undefined && argv[i + 1] && /^[A-Za-z][\w]*(?:,[A-Za-z][\w]*)*$/.test(argv[i + 1]) && i >= 2) value = argv[++i];
    } else if (!booleans.has(key) && match[2] === undefined) {
      if (argv[i + 1] === undefined || (argv[i + 1].startsWith('--') && argv[i + 1] !== '-')) throw new Error(`${arg} 缺少参数。`);
      value = argv[++i];
    }
    if (multiples.has(key)) {
      const old = Array.isArray(flags[key]) ? flags[key] as string[] : [];
      flags[key] = [...old, String(value)];
    } else flags[key] = value;
  }
  return { args, flags };
}
const val = (f: Flags, key: string): string | undefined => typeof f[key] === 'string' ? f[key] as string : undefined;
function list(f: Flags, key: string): string[] | undefined {
  if (f[key] === undefined) return undefined;
  return (Array.isArray(f[key]) ? f[key] as string[] : [String(f[key])]).flatMap(x => key === 'field' || key === 'header' ? [x] : x.split(',')).map(x => x.trim()).filter(Boolean);
}
function required(value: string | undefined, label: string): string { if (!value) throw new Error(`请提供${label}。`); return value; }
function body(f: Flags): string | undefined {
  const file = val(f, 'body-file');
  if (file !== undefined) return readFileSync(file === '-' ? 0 : resolve(file), 'utf8');
  return val(f, 'body') ?? val(f, 'description');
}
function findVault(explicit?: string): string | undefined {
  if (explicit) return resolve(explicit);
  const installed = dirname(realpathSync(resolve(process.argv[1])));
  if (basename(installed) === 'local-issues' && basename(dirname(installed)) === 'plugins' && basename(dirname(dirname(installed))) === '.obsidian') return dirname(dirname(dirname(installed)));
  let dir = process.cwd();
  while (true) { if (existsSync(resolve(dir, '.obsidian'))) return dir; const parent = dirname(dir); if (parent === dir) break; dir = parent; }
  return undefined;
}
function localUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('仅支持 localhost 或回环地址的本机接口与分享链接。');
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}
interface Client { request(path: string, method?: string, value?: unknown): Promise<any> }
function client(f: Flags, shared?: URL, resource?: URL): Client {
  let base = val(f, 'url') ?? (process.env.LOCAL_ISSUES_URL || undefined);
  const vault = findVault(val(f, 'vault') ?? process.env.LOCAL_ISSUES_VAULT);
  if (!shared && vault) {
    const file = resolve(vault, '.obsidian/plugins/local-issues/data.json');
    if (existsSync(file)) {
      const config = JSON.parse(readFileSync(file, 'utf8'));
      base ??= `http://127.0.0.1:${config.apiPort ?? config.port ?? 27183}`;
    }
  }
  base ??= resource?.origin;
  const baseUrl = shared ?? localUrl(base ?? 'http://127.0.0.1:27183');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const match = val(f, 'if-match'); if (match) headers['If-Match'] = match;
  for (const header of list(f, 'header') ?? []) { const colon = header.indexOf(':'); if (colon <= 0) throw new Error('-H 格式为 Name: value'); headers[header.slice(0, colon)] = header.slice(colon + 1).trim(); }
  return { async request(path, method = 'GET', value) {
    const url = localUrl(new URL(path, baseUrl).toString());
    if (url.origin !== baseUrl.origin) throw new Error('接口地址必须保持同一本机服务。');
    let response: Response;
    try { response = await fetch(url, { method, headers, body: value === undefined ? undefined : JSON.stringify(value), signal: AbortSignal.timeout(30000) }); }
    catch (error) { throw new Error(`无法连接 Local Issues。请确认 Obsidian 和本地 API 已启动。${error instanceof Error && error.name === 'TimeoutError' ? '请求超时。' : ''}`); }
    let payload: any;
    try { payload = await response.json(); } catch { throw new Error(`接口返回了非 JSON 内容（${response.status}）。`); }
    if (!response.ok || !payload.ok) throw new Error(`${payload.error?.code ?? response.status}: ${payload.error?.message ?? '操作失败'}`);
    return payload.data;
  } };
}
function print(data: any, flags: Flags, kind?: string): void {
  if (flags.json !== undefined) {
    const fields = typeof flags.json === 'string' ? flags.json.split(',') : null;
    const select = (item: any) => fields && item && typeof item === 'object' ? Object.fromEntries(fields.map(k => [k, item[k]])) : item;
    console.log(JSON.stringify(Array.isArray(data) ? data.map(select) : select(data), null, 2)); return;
  }
  if (typeof data === 'string') { console.log(data); return; }
  if (Array.isArray(data)) {
    if (!data.length) { console.log('没有匹配的条目。'); return; }
    for (const item of data) console.log(kind === 'project' ? `${item.title}\t${item.status}\t${item.closedCount ?? 0}/${item.issueCount ?? 0}\t${item.id}` : `#${item.number}\t${item.status}\t${item.title}\t${(item.labels ?? []).join(', ')}`);
    return;
  }
  if (data?.url) { console.log(data.url); return; }
  if (data?.markdown) { console.log(data.markdown); return; }
  if (data?.issue) {
    console.log(`#${data.issue.number} ${data.issue.title}\n${data.issue.status} · ${data.issue.id}\n\n${data.issue.body}`);
    for (const entry of flags.comments ? data.timeline ?? [] : []) console.log(`\n---\n${entry.author} · ${entry.createdAt} · ${entry.id}\n${entry.kind === 'event' ? `${entry.from} → ${entry.to}` : entry.body}`);
    return;
  }
  if (data?.project) { console.log(`${data.project.title}\n${data.project.description}\n`); print(data.issues ?? [], {}, 'issue'); return; }
  if (data?.title) { console.log(`${data.number ? `#${data.number} ` : ''}${data.title}\n${data.path ?? data.id}`); return; }
  if (data?.body !== undefined) { console.log(`${data.id ? `${data.id}\n` : ''}${data.body}`); return; }
  console.log(JSON.stringify(data, null, 2));
}
function issuePatch(f: Flags): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const scalar = { title: 'title', status: 'status', milestone: 'milestone', parent: 'parent', 'due-date': 'dueDate', reason: 'closeReason', author: 'author' };
  for (const [flag, field] of Object.entries(scalar)) if (val(f, flag) !== undefined) result[field] = val(f, flag);
  if (val(f, 'state') !== undefined) result.status = val(f, 'state');
  const content = body(f); if (content !== undefined) result.body = content;
  for (const [flag, field] of [['label', 'labels'], ['assignee', 'assignees'], ['depends-on', 'dependencies']]) if (list(f, flag) !== undefined) result[field] = list(f, flag);
  return result;
}
async function main(): Promise<void> {
  const { args, flags } = parse(process.argv.slice(2));
  if (flags.help || !args.length || args[0] === 'help') { console.log(HELP); return; }
  let [command, action, ref, extra] = args;
  if (command === 'view' || (command === 'resolve' && action?.startsWith('http://'))) { ref = action; action = 'view'; }
  const resourceUrl = ref?.startsWith('http://') ? localUrl(ref) : undefined;
  const resource = resourceUrl ? parseResource(resourceUrl) : undefined;
  if (resource) {
    if (resource.suffix.length) throw new Error('请使用仓库、项目、Issues 列表或议题链接。');
    if (command === 'view' || command === 'resolve' || command === 'share') {
      command = resource.kind === 'repo' ? 'repo' : resource.kind === 'project' ? 'project' : 'issue';
      if (resource.kind === 'issues' && action === 'view') action = 'list';
    }
    const expected = resource.kind === 'repo' ? 'repo' : resource.kind === 'project' ? 'project' : 'issue';
    if (command !== expected || (resource.kind === 'issues' ? action !== 'list' : action === 'list' || action === 'create')) throw new Error('命令与链接目标不匹配；使用 local-issues view <链接> 自动识别目标。');
  }
  let shared: URL | undefined;
  const maybe = ['share', 'issue', 'project'].includes(command) ? ref : undefined;
  if (!resource && maybe?.startsWith('http://')) { const parsed = localUrl(maybe); if (/^\/api\/shares\/[^/]+\/resolve$/.test(parsed.pathname)) shared = parsed; else throw new Error('请提供完整的分享链接。'); }
  const api = client(flags, shared, resource ? resourceUrl : undefined);
  const project = val(flags, 'project');
  const issuePath = (value: string) => resourceUrl && resource ? resourceUrl.toString() : `/api/issues/${encodeURIComponent(value)}${project ? `?project=${encodeURIComponent(project)}` : ''}`;
  const subPath = (value: string, suffix: string) => {
    if (resourceUrl && resource) { const url = new URL(resourceUrl); url.pathname += `/${suffix}`; return url.toString(); }
    return `/api/issues/${encodeURIComponent(value)}/${suffix}${project ? `?project=${encodeURIComponent(project)}` : ''}`;
  };
  let data: any;
  if (shared) {
    const url = new URL(shared);
    if (flags.web) throw new Error('分享引用通过 CLI 访问；--web 仅用于本地编号或 ID。');
    if (action === 'view' || action === 'get') data = await api.request(url.pathname + url.search);
    else if (action === 'edit') {
      const current = await api.request(url.pathname + url.search), patch = issuePatch(flags);
      if (current.kind === 'issue' && (flags['add-label'] || flags['remove-label'])) {
        patch.labels = [...new Set([...(patch.labels as string[] ?? current.issue.labels), ...(list(flags, 'add-label') ?? [])])].filter(x => !(list(flags, 'remove-label') ?? []).includes(x));
        if (!val(flags, 'if-match')) patch.expectedUpdatedAt = current.issue.revision ?? current.issue.updatedAt;
      }
      if (current.kind === 'project' && patch.body !== undefined) { patch.description = patch.body; delete patch.body; }
      if (current.kind === 'issue') { patch.actor = val(flags, 'author') ?? 'Agent'; delete patch.author; }
      data = await api.request(url.pathname + url.search, 'PATCH', patch);
    }
    else if (action === 'close' || action === 'reopen') data = await api.request(url.pathname + url.search, 'PATCH', { status: action === 'close' ? 'closed' : 'open', ...(action === 'close' && val(flags, 'reason') ? { closeReason: val(flags, 'reason') } : {}), actor: val(flags, 'author') ?? 'Agent' });
    else if (action === 'comment') { url.pathname = url.pathname.replace(/\/resolve$/, '/comments'); data = await api.request(url.pathname + url.search, 'POST', { body: required(body(flags), '评论正文（--body 或 --body-file）'), author: val(flags, 'author') ?? 'Agent' }); }
    else if (action === 'comment-edit') { url.pathname = url.pathname.replace(/\/resolve$/, `/comments/${encodeURIComponent(required(extra, '评论ID'))}`); data = await api.request(url.pathname + url.search, 'PATCH', { body: required(body(flags), '评论正文（--body 或 --body-file）') }); }
    else throw new Error('分享链接支持 view、edit、comment、comment-edit、close、reopen。');
  } else if (command === 'repo') {
    if (action === 'view' && resourceUrl && resource?.kind === 'repo') data = await api.request(resourceUrl.toString());
    else if (action === 'link') data = await api.request('/api/links');
    else throw new Error('用法：local-issues repo view <仓库URL> 或 local-issues repo link');
  } else if (command === 'project') {
    if (action === 'list') {
      const query = new URLSearchParams(); if (val(flags, 'state')) query.set('state', val(flags, 'state')!); if (val(flags, 'search')) query.set('search', val(flags, 'search')!);
      data = await api.request(`/api/projects?${query}`);
    } else if (action === 'view') data = await api.request(resourceUrl && resource ? resourceUrl.toString() : `/api/projects/${encodeURIComponent(required(ref, '项目'))}`);
    else if (action === 'create' || action === 'edit') {
      const value: Record<string, unknown> = {};
      if (val(flags, 'title') !== undefined) value.title = val(flags, 'title');
      const content = body(flags); if (content !== undefined) value.description = content;
      if (val(flags, 'state') ?? val(flags, 'status')) value.status = val(flags, 'state') ?? val(flags, 'status');
      if (val(flags, 'due-date') !== undefined) value.dueDate = val(flags, 'due-date');
      if (action === 'create') required(value.title as string, '标题（--title）');
      data = await api.request(action === 'create' ? '/api/projects' : resourceUrl && resource ? resourceUrl.toString() : `/api/projects/${encodeURIComponent(required(ref, '项目'))}`, action === 'create' ? 'POST' : 'PATCH', value);
    } else if (action === 'share') data = resourceUrl && resource ? { url: resourceUrl.toString() } : await api.request(`/api/links?ref=${encodeURIComponent(required(ref, '项目'))}`);
    else throw new Error('未知项目命令。运行 local-issues --help 查看用法。');
  } else if (command === 'issue') {
    if (action === 'list') {
      const query = new URLSearchParams(resourceUrl && resource ? resourceUrl.search : '');
      query.set('state', val(flags, 'state') ?? val(flags, 'status') ?? query.get('state') ?? (resource ? 'all' : 'open'));
      query.set('limit', val(flags, 'limit') ?? query.get('limit') ?? '30');
      if (project) query.set('project', project);
      for (const key of ['search', 'milestone']) if (val(flags, key) !== undefined) query.set(key, val(flags, key)!);
      for (const label of list(flags, 'label') ?? []) query.append('label', label);
      for (const name of list(flags, 'assignee') ?? []) query.append('assignee', name);
      data = await api.request(resourceUrl && resource ? `${resourceUrl.origin}${resourceUrl.pathname}?${query}` : `/api/issues?${query}`);
    } else if (action === 'view') data = await api.request(issuePath(required(ref, 'Issue 引用')));
    else if (action === 'create') data = await api.request('/api/issues', 'POST', { ...issuePatch(flags), title: required(val(flags, 'title'), '标题（--title）'), project: required(project, '项目（--project）'), author: val(flags, 'author') ?? 'Agent' });
    else if (action === 'edit') {
      const patch = issuePatch(flags); patch.actor = val(flags, 'author') ?? 'Agent'; delete patch.author;
      if (flags['add-label'] || flags['remove-label']) {
        const current = (await api.request(issuePath(required(ref, 'Issue 引用')))).issue;
        patch.labels = [...new Set([...(patch.labels as string[] ?? current.labels), ...(list(flags, 'add-label') ?? [])])].filter(x => !(list(flags, 'remove-label') ?? []).includes(x));
        if (!val(flags, 'if-match')) patch.expectedUpdatedAt = current.revision ?? current.updatedAt;
      }
      data = await api.request(issuePath(required(ref, 'Issue 引用')), 'PATCH', patch);
    } else if (action === 'comment') data = await api.request(subPath(required(ref, 'Issue 引用'), 'comments'), 'POST', { body: required(body(flags), '评论正文（--body 或 --body-file）'), author: val(flags, 'author') ?? 'Agent' });
    else if (action === 'close' || action === 'reopen') data = await api.request(subPath(required(ref, 'Issue 引用'), action), 'POST', { ...(action === 'close' && val(flags, 'reason') ? { closeReason: val(flags, 'reason') } : {}), actor: val(flags, 'author') ?? 'Agent' });
    else if (action === 'attach') {
      const file = resolve(required(extra, '附件文件'));
      const attachment = await api.request(subPath(required(ref, 'Issue 引用'), 'attachments'), 'POST', { name: basename(file), base64: readFileSync(file).toString('base64') });
      await api.request(subPath(ref!, 'comments'), 'POST', { body: [body(flags), attachment.markdown].filter(Boolean).join('\n\n'), author: val(flags, 'author') ?? 'Agent' });
      data = attachment;
    } else if (action === 'share') { const current = await api.request(issuePath(required(ref, 'Issue 引用'))); data = await api.request(`/api/links?ref=${encodeURIComponent(current.issue.id)}`); }
    else throw new Error('未知 Issue 命令。运行 local-issues --help 查看用法。');
  } else if (command === 'comment' && action === 'edit') data = await api.request(`/api/comments/${encodeURIComponent(required(ref, '评论 ID'))}`, 'PATCH', { body: required(body(flags), '评论正文（--body 或 --body-file）') });
  else if (command === 'resolve') data = await api.request(`/api/resolve?ref=${encodeURIComponent(required(action, '双链或引用'))}`);
  else if (command === 'api') {
    const fields: Record<string, unknown> = {};
    for (const field of list(flags, 'field') ?? []) { const equal = field.indexOf('='); if (equal <= 0) throw new Error('-f 格式为 key=value'); const value = field.slice(equal + 1); try { fields[field.slice(0, equal)] = JSON.parse(value); } catch { fields[field.slice(0, equal)] = value; } }
    let path = required(action, '接口路径'); if (!path.startsWith('/api/')) path = `/api/${path.replace(/^\//, '')}`;
    const method = (val(flags, 'method') ?? (Object.keys(fields).length ? 'POST' : 'GET')).toUpperCase();
    data = await api.request(path, method, method === 'GET' ? undefined : fields);
  } else throw new Error('未知命令。运行 local-issues --help 查看用法。');
  if (flags.web && !shared) {
    const target = data?.kind === 'repo' ? undefined : data?.issue?.id ?? data?.project?.id ?? data?.id ?? ref;
    if (target) await api.request('/api/open', 'POST', { ref: target });
  }
  if (flags.json !== undefined && data?.issue) data = { ...data.issue, project: data.project, comments: data.comments, timeline: data.timeline, subIssues: data.subIssues, dependencies: data.dependencies };
  else if (flags.json !== undefined && data?.project) data = { ...data.project, issues: data.issues };
  print(data, flags, command);
}

void main().catch(error => { console.error(`local-issues: ${error instanceof Error ? error.message : '操作失败'}`); process.exitCode = 1; });
