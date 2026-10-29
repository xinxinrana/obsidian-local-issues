import { Marked } from 'marked';
import type { ResourceRoutes } from './routes';
import { CLOSE_REASON_NAMES, STATUS_NAMES, type Issue, type Project, type Snapshot } from './types';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function safeHref(value: string): string | undefined {
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return undefined;
  return /^(?:https?:\/\/|mailto:|obsidian:\/\/|#|\/(?!\/))/i.test(value) ? value : undefined;
}
export function attachmentPath(value: string): string | undefined {
  return /^resource\/local-issues\/[^/\\\x00-\x1f]+$/.test(value) && !/[#|]/.test(value) ? value : undefined;
}
function markdownAttachmentPath(value: string): string | undefined {
  try { return attachmentPath(decodeURIComponent(value)); } catch { return undefined; }
}
export function attachmentReferences(body: string): Set<string> {
  const result = new Set<string>();
  for (const match of body.matchAll(/!?\[\[([^\]\n]+)\]\]|!?\[[^\]\n]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)) {
    const path = match[1] ? attachmentPath(match[1].split(/[|#]/)[0].trim()) : markdownAttachmentPath(match[2]);
    if (path) result.add(path);
  }
  return result;
}

const css = `
:root{color-scheme:light dark;--bg:#fff;--muted:#59636e;--line:#d1d9e0;--soft:#f6f8fa;--text:#1f2328;--link:#0969da;--open:#1a7f37;--closed:#8250df}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--link);text-decoration:none;overflow-wrap:anywhere}a:hover{text-decoration:underline}button,input,select{font:inherit;color:inherit}button,.button{border:1px solid var(--line);border-radius:6px;background:var(--soft);padding:5px 12px;white-space:nowrap}button{cursor:pointer}input,select{border:1px solid var(--line);border-radius:6px;background:var(--bg);padding:6px 10px;min-width:0}a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--link);outline-offset:3px}
header{position:sticky;top:0;z-index:2;border-bottom:1px solid var(--line);background:var(--bg)}nav{max-width:1200px;margin:auto;padding:12px 24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}nav .edit{margin-left:auto}main{max-width:1200px;margin:28px auto;padding:0 24px}h1{font-size:28px;line-height:1.35;margin:0 0 12px;overflow-wrap:anywhere}h2{font-size:20px}p{margin:12px 0}.muted,time{color:var(--muted)}.status{display:inline-block;font-weight:600;color:var(--open)}.status.closed{color:var(--closed)}.label{display:inline-block;padding:0 7px;border:1px solid var(--line);border-radius:12px;font-size:12px;margin:2px 4px 2px 0;max-width:100%;overflow-wrap:anywhere}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:20px 0}.toolbar input[name=q]{flex:1 1 220px}.tabs{display:flex;gap:20px;align-items:center;border-bottom:1px solid var(--line);padding:10px 0;margin:16px 0}.tabs a{color:var(--muted);padding:4px 0}.tabs [aria-current=page]{color:var(--text);font-weight:600;border-bottom:2px solid var(--closed)}.views{margin-left:auto;display:flex;gap:12px}.rows,.card{border:1px solid var(--line);border-radius:8px;overflow:hidden}.row{padding:14px 18px;border-bottom:1px solid var(--line);min-width:0;overflow-wrap:anywhere}.row:last-child{border:0}.row .title{font-size:16px;font-weight:600;color:var(--text)}.row .meta{font-size:13px;color:var(--muted);margin-top:5px}.card{margin-bottom:20px}.card-head{padding:10px 16px;background:var(--soft);border-bottom:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap}.markdown{padding:16px 20px;overflow-wrap:anywhere;min-width:0}.markdown>:first-child{margin-top:0}.markdown>:last-child{margin-bottom:0}.markdown img{display:block;max-width:100%;max-height:480px;width:auto;height:auto;object-fit:contain;margin:12px 0}.markdown pre{overflow:auto;background:var(--soft);padding:14px;border-radius:6px}.markdown code{font-size:.9em;background:var(--soft);padding:2px 4px}.markdown pre code{padding:0}.markdown blockquote{margin-left:0;border-left:4px solid var(--line);padding-left:16px;color:var(--muted)}.markdown table{display:block;max-width:100%;overflow:auto;border-collapse:collapse}.markdown th,.markdown td{border:1px solid var(--line);padding:6px 12px}.markdown li>input{margin-right:6px}.detail{display:grid;grid-template-columns:minmax(0,1fr) 240px;gap:28px;margin-top:24px}.detail>*,.board>*{min-width:0}aside{border-left:1px solid var(--line);padding-left:24px}aside h2{font-size:14px;color:var(--muted);margin:0 0 6px}aside section{margin-bottom:22px;overflow-wrap:anywhere}.event{padding:8px 16px;border-left:2px solid var(--line);margin:20px 0}.empty{padding:32px;text-align:center;color:var(--muted)}.board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.column{background:var(--soft);border-radius:8px;padding:12px}.column h2{font-size:15px}.column .row{background:var(--bg);border:1px solid var(--line);border-radius:6px;margin:10px 0;padding:12px}.table-wrap{overflow:auto}.issue-table{border-collapse:collapse;width:100%}.issue-table th,.issue-table td{text-align:left;border-bottom:1px solid var(--line);padding:10px;overflow-wrap:anywhere}.issue-table th{background:var(--soft)}footer{margin:28px 0;color:var(--muted);font-size:13px}.description{margin:18px 0}.description .markdown{padding:0}
@media(max-width:760px){nav{padding:10px 16px}main{padding:0 16px;margin-top:20px}.detail{grid-template-columns:minmax(0,1fr)}aside{border-left:0;border-top:1px solid var(--line);padding:20px 0}.board{grid-template-columns:minmax(0,1fr)}h1{font-size:24px}.views{width:100%;margin-left:0}.tabs{flex-wrap:wrap}}
@media(prefers-color-scheme:dark){:root{--bg:#0d1117;--text:#e6edf3;--soft:#161b22;--line:#30363d;--muted:#9198a1;--link:#58a6ff;--open:#3fb950;--closed:#a371f7}}
`;
const editingCss = `
[hidden]{display:none!important}.heading-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:16px 0}.heading-actions h1{flex:1;margin:0}.card-head .actions{margin-left:auto;display:flex;gap:8px}.quiet{border:0;background:transparent;color:var(--muted);padding:2px 6px}.editing{border-color:var(--closed)}form[data-api]{padding:16px;min-width:0}form[data-api] input:not([type=checkbox]):not([type=hidden]):not([type=file]),form[data-api] select{max-width:100%;width:100%}form[data-api] label{display:block;margin:10px 0;font-weight:600}form[data-api] label input,form[data-api] label select{display:block;margin-top:6px;font-weight:400}textarea{font:inherit;color:inherit;background:var(--bg);display:block;width:100%;min-height:140px;max-height:55dvh;border:0;outline-offset:2px;resize:vertical;overflow-x:hidden;overflow-y:auto;white-space:pre-wrap;overflow-wrap:anywhere;padding:12px 0}textarea[name=description]{min-height:100px}.editor-tabs{display:flex;gap:16px;border-bottom:1px solid var(--line);padding-bottom:8px}.editor-tabs [aria-selected=true]{font-weight:600;color:var(--text)}.editor-tabs button{border:0;background:none;padding:0;color:var(--muted)}.editor-preview .markdown{padding:12px 0;min-height:140px}.form-footer{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:12px;flex-wrap:wrap}.form-footer .muted{font-size:12px;margin-right:auto;font-weight:400}.primary{background:var(--open);color:white;border-color:var(--open)}button:disabled,select:disabled{opacity:.6;cursor:wait}.feedback{font-size:13px;margin:10px 0;overflow-wrap:anywhere}.feedback[role=alert]{color:#cf222e}.row:has(input[data-select-issue]){position:relative;padding-left:46px}.row>input[data-select-issue]{position:absolute;left:16px;top:20px}.row .row-status{display:block;margin-top:8px;font-size:12px;width:auto;max-width:100%}.batch-bar{border:1px solid var(--line);border-radius:6px;padding:10px;margin:12px 0;display:flex;gap:8px;flex-wrap:wrap;align-items:center}.batch-bar input{max-width:170px}.selection{display:flex;align-items:center;gap:8px;margin:12px 0}.selection input{margin:0}.property-edit{display:flex;align-items:center;justify-content:space-between;gap:8px}aside form[data-api]{padding:6px 0}aside textarea{min-height:80px}details{margin:14px 0}summary{cursor:pointer;color:var(--muted)}[data-relations] select{width:100%;margin:6px 0}.archived-projects{margin-top:24px}.archived-projects .archived-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.archived-projects .archived-row .actions{margin-left:auto;display:flex;gap:6px}[data-chips] .label button{border:0;background:none;padding:0;color:inherit;white-space:normal;text-align:left}[data-chips] .label button:hover{text-decoration:line-through}.file-picker{display:none}.board [draggable=true]{cursor:grab}.issue-table .row-status{max-width:150px}.filter-details input{margin:5px;max-width:190px}.filter-details .toolbar{margin:8px 0}.list-summary{color:var(--muted);font-size:13px}
`;

export function htmlDocument(title: string, content: string): string {
  // Agents that fetch a page get a pointer to the CLI/skill docs; humans never see it.
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><!-- Agent: GET /llms.txt for the CLI and skill setup. --><link rel="llms" type="text/markdown" href="/llms.txt" title="Agent usage"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Local Issues</title><style>${css}${editingCss}</style><script src="/api/web-client.js" defer></script></head><body>${content}</body></html>`;
}

export interface WebPage {
  snapshot: Snapshot; routes: ResourceRoutes; vaultName: string; url: URL;
  project?: Project; issue?: Issue; issues?: Issue[]; author?: string;
  attachmentUrl?: (ref: string, path: string) => string;
}
export function renderMarkdown(body: string, page: Pick<WebPage, 'snapshot' | 'routes' | 'vaultName' | 'issue' | 'project' | 'attachmentUrl'>): string {
  const { snapshot, routes, vaultName, issue: sourceIssue, project } = page;
  const e = escapeHtml;
  const projectPath = (id: string) => routes.projects[id] ? `/${encodeURIComponent(routes.projects[id])}` : undefined;
  const issuePath = (i: Issue) => projectPath(i.projectId) ? `${projectPath(i.projectId)}/issues/${i.number}` : undefined;
  const note = (path: string) => `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path)}`;
  const link = (href: string, text: string, download = false) => `<a href="${e(href)}"${download ? ' download' : ''}>${e(text)}</a>`;
  const attachment = (path: string) => { const ref = sourceIssue?.id || project?.id; return ref ? page.attachmentUrl?.(ref, path) || `/api/attachments?ref=${encodeURIComponent(ref)}&path=${encodeURIComponent(path)}` : undefined; };
  const wikiLink = (ref: string): string => {
    const [target, alias] = ref.replace(/\\\|/g, '|').split('|');
    const path = target.split('#')[0].replace(/\.md$/, '');
    const found = [...snapshot.issues, ...snapshot.projects].find(x => x.path.replace(/\.md$/, '') === path || x.id === path);
    const href = found && !target.includes('#') ? ('number' in found ? issuePath(found) : projectPath(found.id)) : undefined;
    const file = attachmentPath(target);
    return link(file && attachment(file) || href || note(target), alias || target.split('/').at(-1) || target, !!file && !!attachment(file));
  };
  const parser = new Marked({ gfm: true, breaks: true, renderer: {
    html({ text }) { return e(text); },
    link({ href, tokens }) {
      const file = markdownAttachmentPath(href);
      const safe = file && attachment(file) || safeHref(href);
      return safe ? `<a href="${e(safe)}" rel="noreferrer"${file ? ' download' : ''}>${this.parser.parseInline(tokens)}</a>` : this.parser.parseInline(tokens);
    },
    image({ href, text }) {
      const file = markdownAttachmentPath(href), src = file && attachment(file);
      return src ? `<img src="${e(src)}" alt="${e(text)}" loading="lazy">` : e(text || href);
    },
  }, extensions: [{
    name: 'wiki', level: 'inline', start(src: string) { return src.search(/!?\[\[/); },
    tokenizer(src: string) {
      const match = /^(!?)\[\[([^\]\n]+)\]\]/.exec(src);
      return match ? { type: 'wiki', raw: match[0], ref: match[2], embed: !!match[1] } : undefined;
    },
    renderer(token) {
      const ref = token.ref as string, file = attachmentPath(ref.split(/[|#]/)[0]);
      const src = file && attachment(file);
      if (token.embed && src && /\.(?:png|jpe?g|gif|webp|bmp|avif)$/i.test(file!)) return `<img src="${e(src)}" alt="${e(ref.split('|')[1] || file!.split('/').at(-1)!)}" loading="lazy">`;
      return wikiLink(ref);
    },
  }] });
  return `<div class="markdown">${parser.parse(body, { async: false })}</div>`;
}
export function renderPage(page: WebPage): string {
  const { snapshot, routes, vaultName, url, project, issue } = page;
  const e = escapeHtml;
  const projectPath = (id: string) => routes.projects[id] ? `/${encodeURIComponent(routes.projects[id])}` : undefined;
  const issuePath = (i: Issue) => projectPath(i.projectId) ? `${projectPath(i.projectId)}/issues/${i.number}` : undefined;
  const open = (ref?: { id: string }, kind = 'project') => `obsidian://local-issues?vault=${encodeURIComponent(vaultName)}${ref ? `&${kind}=${encodeURIComponent(ref.id)}` : ''}`;
  const link = (href: string, text: string, attrs = '') => `<a href="${e(href)}"${attrs}>${e(text)}</a>`;
  const labels = (i: Issue) => i.labels.map(l => `<span class="label">${e(l)}</span>`).join('');
  const state = (i: Issue) => `<span class="status${i.status === 'closed' ? ' closed' : ''}">${i.status === 'closed' ? `已关闭 · ${CLOSE_REASON_NAMES[i.closeReason ?? 'completed']}` : '开启'}</span>`;
  const date = (value: string) => `<time datetime="${e(value)}">${e(new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</time>`;
  const markdown = (body: string, sourceIssue?: Issue) => renderMarkdown(body, { ...page, issue: sourceIssue });

  let sequence = 0;
  const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${e(value)}">`;
  const input = (name: string, label: string, value = '', type = 'text', required = false) => `<label>${label}<input name="${name}" type="${type}" value="${e(value)}"${required ? ' required' : ''}></label>`;
  const option = (value: string, label: string, current: string) => `<option value="${e(value)}"${value === current ? ' selected' : ''}>${e(label)}</option>`;
  const stateOptions = (current: string) => [['open', '开启'], ['completed', '关闭 · 完成'], ['on-hold', '关闭 · 搁置'], ['not-planned', '关闭 · 不做']].map(([value, label]) => option(value, label, current)).join('');
  const currentState = (i: Issue) => i.status === 'closed' ? i.closeReason || 'completed' : 'open';
  const statusSelect = (i: Issue, hidden = false) => `<select${hidden ? ' hidden' : ''} class="row-status" data-status data-current="${currentState(i)}" data-issue="${e(i.id)}" data-revision="${e(i.revision || '')}" aria-label="修改 #${i.number} 状态">${stateOptions(currentState(i))}</select>`;
  const choices = snapshot.issues.filter(i => i.id !== issue?.id);
  function relationsInput(selected: string[] = []): string {
    return `<div data-relations><div data-chips>${selected.map(id => { const i = choices.find(i => i.id === id); return `<span class="label" data-relation-chip>${hidden('dependencies', id)}<button type="button" data-remove-relation="true" aria-label="移除依赖 ${e(i?.title || id)}">${e(i ? `#${i.number} ${i.title}` : id)}</button></span>`; }).join('')}</div><input type="search" data-relation-search placeholder="搜索议题，支持 @ 或 /" aria-label="搜索依赖议题"><select aria-label="选择依赖"><option value="">选择议题</option>${choices.map(i => option(i.id, `#${i.number} ${i.title}`, '')).join('')}</select><button type="button" data-add-relation>添加依赖</button></div>`;
  }
  function parentSelect(current = ''): string {
    return `<label>父议题<select name="parent">${option('', '无父议题', current)}${current && !choices.some(i => i.id === current) ? option(current, snapshot.issues.find(i => i.id === current)?.title || current, current) : ''}${choices.map(i => option(i.id, `#${i.number} ${i.title}`, current)).join('')}</select></label>`;
  }
  function milestoneInput(value = ''): string {
    const id = `suggestions-${++sequence}`;
    return `<label>里程碑<input name="milestone" list="${id}" value="${e(value)}"><datalist id="${id}">${[...new Set(snapshot.issues.filter(i => i.projectId === project?.id).map(i => i.milestone))].filter(Boolean).map(value => `<option value="${e(value)}"></option>`).join('')}</datalist></label>`;
  }
  function properties(i?: Partial<Issue>): string {
    return `${input('labels', '标签（逗号分隔）', i?.labels?.join(', ') || '')}${milestoneInput(i?.milestone)}${input('assignees', '负责人（逗号分隔）', i?.assignees?.join(', ') || '')}${input('dueDate', '截止日期', i?.dueDate || '', 'date')}${parentSelect(i?.parent || '')}<label>依赖议题</label>${relationsInput(i?.dependencies)}`;
  }
  function editor(body: string, name = 'body'): string {
    return `<div class="editor-tabs" role="tablist" aria-label="Markdown 编辑"><button type="button" role="tab" aria-selected="true" data-tab="write">编写</button><button type="button" role="tab" aria-selected="false" data-tab="preview">预览</button></div><textarea data-markdown name="${name}" aria-label="${name === 'description' ? '项目描述' : 'Markdown 正文'}">${e(body)}</textarea><div class="editor-preview" data-preview hidden></div><input class="file-picker" type="file" multiple aria-label="选择附件">`;
  }
  function form(api: string, fields: string, options: { revision?: string; ref?: string; create?: boolean; author?: boolean; comment?: boolean; anchor?: string; cancel?: boolean; markdown?: boolean } = {}): string {
    const upload = options.ref ? `/api/${options.ref.startsWith('p-') ? 'projects' : 'issues'}/${options.ref}/attachments` : '';
    return `<form method="post" action="${e(api)}" data-api="${e(api)}" data-method="${options.create ? 'POST' : 'PATCH'}" data-revision="${e(options.revision || '')}" data-ref="${e(options.ref || '')}" data-upload="${e(upload)}"${options.create && !options.comment ? ' data-redirect="created"' : options.comment ? ' data-redirect="comment"' : ''}${options.author ? ' data-author="true"' : ''}${options.anchor ? ` data-anchor="${e(options.anchor)}"` : ''}>${fields}<div class="form-footer">${options.markdown ? '<span class="muted">Markdown · 粘贴或拖入附件 · ⌘/Ctrl+Shift+U 选择文件</span>' : ''}${options.cancel === false ? '' : '<button type="button" data-cancel>取消</button>'}<button type="submit" class="primary">${options.comment ? '发表评论' : options.create ? '创建' : '保存'}</button></div></form>`;
  }
  function editable(display: string, fields: string, api: string, options: Parameters<typeof form>[2], label = '编辑', wrap = 'section'): string {
    const id = `editor-${++sequence}`;
    return `<${wrap} data-editable><div class="property-edit"><button type="button" class="quiet" data-edit="${id}">${label}</button></div><div data-display>${display}</div><template id="${id}">${form(api, fields, options)}</template></${wrap}>`;
  }
  function newIssue(parent = ''): string {
    return editable('', `${hidden('project', project!.id)}${input('title', '标题', '', 'text', true)}${editor('')}<details><summary>属性与关联</summary>${properties({ parent })}</details>`, '/api/issues', { create: true, author: true, ref: project!.id, markdown: true }, parent ? '添加子议题' : '新建 Issue');
  }
  function row(i: Issue): string {
    const comments = snapshot.timeline.filter(t => t.issueId === i.id && t.kind === 'comment').length;
    return `<article class="row" draggable="true" data-drag-issue="${e(i.id)}">${!issue ? `<input type="checkbox" data-select-issue="${e(i.id)}" data-number="${i.number}" data-revision="${e(i.revision || '')}" data-labels="${e(JSON.stringify(i.labels))}" aria-label="选择 #${i.number}">` : ''}${state(i)} &nbsp;${link(issuePath(i) || open(i, 'issue'), i.title, ' class="title"')} ${labels(i)}<div class="meta">#${i.number} · ${e(i.author)} · ${date(i.updatedAt)}${comments ? ` · ${comments} 条评论` : ''}</div>${!issue ? statusSelect(i, true) : ''}</article>`;
  }
  const crumbs = `${link('/', '项目')}${project ? ` / ${link(projectPath(project.id) || open(project), project.title)}` : ''}${issue ? ` / #${issue.number}` : ''}`;
  let content = `<div id="li-app" data-author="${e(page.author || '我')}"><header><nav aria-label="导航">${crumbs}<button type="button" class="quiet edit" data-copy="${e(url.pathname.startsWith('/api/shares/') ? (issue ? issuePath(issue)! : project ? projectPath(project.id)! : '/') : url.pathname + url.search)}">复制链接</button>${link(issue ? open(issue, 'issue') : open(project), '在 Obsidian 中打开', ' class="button"')}</nav></header><main><noscript>请启用 JavaScript 以新建、编辑和保存内容。</noscript>`;
  let title = project?.title || vaultName;
  if (issue) {
    title = `#${issue.number} ${issue.title}`;
    const api = `/api/issues/${issue.id}`, settings = { revision: issue.revision, ref: issue.id };
    content += editable(`<h1>${e(issue.title)} <span class="muted">#${issue.number}</span></h1>`, input('title', '标题', issue.title, 'text', true), api, settings, '修改标题');
    content += `${state(issue)} <span class="muted">${e(issue.author)} · ${date(issue.createdAt)}</span><div class="detail"><div><article class="card" data-editable><div class="card-head"><strong>${e(issue.author)}</strong>描述<div class="actions"><button type="button" class="quiet" data-edit="issue-body">编辑</button></div></div><div data-display>${markdown(issue.body || '暂无描述', issue)}</div><template id="issue-body">${form(api, editor(issue.body), { ...settings, markdown: true })}</template></article>`;
    const relations = snapshot.issues.filter(i => i.parent === issue.id);
    if (relations.length) content += `<h2>子议题</h2><div class="rows">${relations.map(row).join('')}</div>`;
    content += newIssue(issue.id);
    for (const entry of snapshot.timeline.filter(t => t.issueId === issue.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      content += entry.kind === 'event' ? `<p class="event">${e(entry.author)} ${e(entry.body)} · ${date(entry.createdAt)}</p>` : `<article class="card" id="${e(entry.id)}" data-editable><div class="card-head"><strong>${e(entry.author)}</strong>${date(entry.createdAt)}<div class="actions"><button class="quiet" type="button" data-edit="edit-${e(entry.id)}">编辑</button><button class="quiet" type="button" data-delete="${e(entry.id)}" data-revision="${e(entry.revision || '')}">删除</button></div></div><div data-display>${markdown(entry.body, issue)}</div><template id="edit-${e(entry.id)}">${form(`/api/comments/${entry.id}`, editor(entry.body), { revision: entry.revision, ref: issue.id, anchor: entry.id, markdown: true })}</template></article>`;
    }
    const relation = (id: string) => { const i = snapshot.issues.find(i => i.id === id); return i ? link(issuePath(i) || open(i, 'issue'), `#${i.number} ${i.title}`) : e(id); };
    const property = (name: string, value: string, fields: string) => editable(`<h2>${name}</h2>${value || '<span class="muted">未设置</span>'}`, fields, api, settings, `修改${name}`);
    content += `<h2>发表评论</h2><article class="card">${form(`${api}/comments`, editor(''), { create: true, author: true, ref: issue.id, comment: true, cancel: false, markdown: true })}</article></div><aside aria-label="属性"><section><h2>状态</h2>${statusSelect(issue)}</section>${property('标签', labels(issue), input('labels', '标签（逗号分隔）', issue.labels.join(', ')))}${property('里程碑', e(issue.milestone), milestoneInput(issue.milestone))}${property('负责人', e(issue.assignees.join('、')), input('assignees', '负责人（逗号分隔）', issue.assignees.join(', ')))}${property('截止日期', e(issue.dueDate), input('dueDate', '截止日期', issue.dueDate, 'date'))}${property('父议题', issue.parent ? relation(issue.parent) : '', parentSelect(issue.parent))}${property('依赖', issue.dependencies.map(relation).join('<br>'), relationsInput(issue.dependencies))}</aside></div>`;
  } else if (project) {
    content += editable(`<h1>${e(project.title)}</h1><span class="muted">${STATUS_NAMES[project.status]}</span>${project.description ? `<div class="description">${markdown(project.description)}</div>` : ''}`, `${input('title', '项目名称', project.title, 'text', true)}${editor(project.description, 'description')}<label>状态<select name="status">${[['active', '进行中'], ['paused', '已暂停'], ['completed', '已完成'], ['archived', '已归档']].map(([value, name]) => option(value, name, project.status)).join('')}</select></label>${input('dueDate', '截止日期', project.dueDate, 'date')}`, `/api/projects/${project.id}`, { revision: project.revision, ref: project.id, markdown: true }, '编辑项目');
    content += newIssue();
    const all = page.issues ?? snapshot.issues.filter(i => i.projectId === project.id);
    const selectedState = url.searchParams.get('state') || url.searchParams.get('status') || (url.searchParams.get('view') === 'board' ? 'all' : 'open');
    const base = projectPath(project.id)! + '/issues';
    const destination = (changes: Record<string, string>) => { const query = new URLSearchParams(url.search); query.delete('limit'); for (const [key, value] of Object.entries(changes)) query.set(key, value); return `${base}?${query}`; };
    const mode = url.searchParams.get('view') || 'list';
    const tab = (value: string, text: string) => link(destination({ state: value, status: value }), text, selectedState === value ? ' aria-current="page"' : '');
    content += `<form class="toolbar" action="${e(base)}" method="get"><input type="search" name="q" aria-label="搜索标题、描述、评论" placeholder="搜索标题、描述、评论" value="${e(url.searchParams.get('q') ?? url.searchParams.get('search') ?? '')}"><input type="hidden" name="state" value="${e(selectedState)}"><input type="hidden" name="view" value="${e(mode)}">`;
    content += `<select name="sort" aria-label="排序">${[['updated', '最近更新'], ['created', '最早创建'], ['title', '标题'], ['due', '截止日期']].map(([value, text]) => option(value, text, url.searchParams.get('sort') || 'updated')).join('')}</select><select name="group" aria-label="分组">${[['', '不分组'], ['status', '按状态'], ['milestone', '按里程碑'], ['label', '按标签']].map(([value, text]) => option(value, text, url.searchParams.get('group') || '')).join('')}</select><button type="submit">搜索</button><details class="filter-details"><summary>更多筛选</summary>${['label', 'milestone', 'assignee'].map((name, n) => `<label>${['标签', '里程碑', '负责人'][n]}<input name="${name}" aria-label="筛选${['标签', '里程碑', '负责人'][n]}" value="${e(url.searchParams.getAll(name).join(', '))}"></label>`).join('')}</details></form><div class="tabs" aria-label="议题状态">${tab('open', `${all.filter(i => i.status !== 'closed').length} 个开启`)}${tab('closed', `${all.filter(i => i.status === 'closed').length} 个已关闭`)}${tab('all', '全部')}<div class="views">${[['list', 'Issues'], ['board', '看板'], ['table', '表格']].map(([value, name]) => link(destination({ view: value }), name, mode === value ? ' aria-current="page"' : '')).join('')}</div></div>`;
    // The API applies all search and attribute filters; state tabs count the same results.
    const visible = all.filter(i => selectedState === 'all' || (selectedState === 'open' ? i.status !== 'closed' : i.status === selectedState));
    if (visible.length) content += `<label class="selection"><input type="checkbox" data-select-all aria-label="全选当前结果">全选当前结果 <span data-selected-count></span></label><section class="batch-bar" data-batch hidden aria-label="批量操作"><select data-batch-value="status" aria-label="批量状态">${stateOptions('open')}</select><button type="button" data-batch-action="status">修改状态</button><input data-batch-value="milestone" placeholder="里程碑，留空清除" aria-label="批量里程碑"><button type="button" data-batch-action="milestone">设置里程碑</button><input data-batch-value="add-label" placeholder="添加标签" aria-label="批量添加标签"><button type="button" data-batch-action="add-label">添加标签</button><input data-batch-value="remove-label" placeholder="移除标签" aria-label="批量移除标签"><button type="button" data-batch-action="remove-label">移除标签</button><button type="button" data-refresh-selected>刷新所选数据</button></section>`;
    if (!visible.length) content += '<div class="rows empty">没有符合条件的议题</div>';
    else if (mode === 'board') content += `<div class="board">${[['open', '开启'], ['completed', '完成'], ['on-hold', '搁置'], ['not-planned', '不做']].map(([value, name]) => `<section class="column" data-drop-status="${value}"><h2>${name}</h2>${visible.filter(i => value === 'open' ? i.status !== 'closed' : i.status === 'closed' && (i.closeReason ?? 'completed') === value).map(row).join('')}</section>`).join('')}</div>`;
    else if (mode === 'table') content += `<div class="rows table-wrap"><table class="issue-table"><thead><tr><th>选择</th><th>议题</th><th>状态</th><th>标签</th><th>里程碑</th><th>负责人</th><th>截止日期</th></tr></thead><tbody>${visible.map(i => `<tr><td><input type="checkbox" data-select-issue="${e(i.id)}" data-number="${i.number}" data-revision="${e(i.revision || '')}" data-labels="${e(JSON.stringify(i.labels))}" aria-label="选择 #${i.number}"></td><td>${link(issuePath(i)!, `#${i.number} ${i.title}`)}</td><td>${statusSelect(i)}</td><td>${labels(i)}</td><td>${e(i.milestone)}</td><td>${e(i.assignees.join('、'))}</td><td>${e(i.dueDate)}</td></tr>`).join('')}</tbody></table></div>`;
    else {
      const group = url.searchParams.get('group');
      const groups = new Map<string, Issue[]>();
      for (const i of visible) { const key = group === 'status' ? STATUS_NAMES[i.status] : group === 'milestone' ? i.milestone || '无里程碑' : group === 'label' ? i.labels[0] || '无标签' : ''; groups.set(key, [...(groups.get(key) || []), i]); }
      content += [...groups].map(([key, issues]) => `${key ? `<h2>${e(key)}</h2>` : ''}<div class="rows">${issues.map(row).join('')}</div>`).join('');
    }
  } else {
    content += editable('', `${input('title', '项目名称', '', 'text', true)}${editor('', 'description')}`, '/api/projects', { create: true }, '新建项目');
    const card = (p: Project) => { const issues = snapshot.issues.filter(i => i.projectId === p.id); const open = issues.filter(i => i.status !== 'closed').length, closed = issues.length - open; return `<article class="row">${link(projectPath(p.id)!, p.title, ' class="title"')} <span class="muted">${STATUS_NAMES[p.status]}</span>${p.description ? renderMarkdown(p.description, { ...page, project: p }) : ''}<div class="meta">${open} 个开启 · ${closed} 个已关闭</div></article>`; };
    const live = snapshot.projects.filter(p => p.status !== 'archived'), archived = snapshot.projects.filter(p => p.status === 'archived');
    content += `<h1>${e(vaultName)}</h1><div class="rows">${live.map(card).join('') || `<p class="empty">${archived.length ? '没有进行中的项目，已归档的在下方。' : '暂无项目'}</p>`}</div>`;
    if (archived.length) content += `<details class="archived-projects"><summary>已归档 · ${archived.length} 个项目</summary>${archived.map(p => { const issues = snapshot.issues.filter(i => i.projectId === p.id), open = issues.filter(i => i.status !== 'closed').length; return `<div class="row archived-row">${link(projectPath(p.id)!, p.title, ' class="title"')}<span class="muted">${open} 个开启 · ${issues.length} 个议题</span><span class="actions"><button class="quiet" type="button" data-project-status="${e(p.id)}">启用</button><button class="quiet" type="button" data-delete-project="${e(p.id)}">删除</button></span></div>`; }).join('')}</details>`;
  }
  return htmlDocument(title, content + '<footer>Local Issues · 内容保存在本机 Obsidian 笔记库 · <a href="/llms.txt">Agent 使用说明</a> · <a href="/api/cli.mjs" download>下载 CLI</a></footer></main></div>');
}
