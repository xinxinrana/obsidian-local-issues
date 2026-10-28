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

export function htmlDocument(title: string, content: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Local Issues</title><style>${css}</style></head><body>${content}</body></html>`;
}

export interface WebPage {
  snapshot: Snapshot; routes: ResourceRoutes; vaultName: string; url: URL;
  project?: Project; issue?: Issue; issues?: Issue[];
}
export function renderPage(page: WebPage): string {
  const { snapshot, routes, vaultName, url, project, issue } = page;
  const e = escapeHtml;
  const projectPath = (id: string) => routes.projects[id] ? `/${encodeURIComponent(routes.projects[id])}` : undefined;
  const issuePath = (i: Issue) => projectPath(i.projectId) ? `${projectPath(i.projectId)}/issues/${i.number}` : undefined;
  const open = (ref?: { id: string }, kind = 'project') => `obsidian://local-issues?vault=${encodeURIComponent(vaultName)}${ref ? `&${kind}=${encodeURIComponent(ref.id)}` : ''}`;
  const note = (path: string) => `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(path)}`;
  const link = (href: string, text: string, attrs = '') => `<a href="${e(href)}"${attrs}>${e(text)}</a>`;
  const labels = (i: Issue) => i.labels.map(l => `<span class="label">${e(l)}</span>`).join('');
  const state = (i: Issue) => `<span class="status${i.status === 'closed' ? ' closed' : ''}">${i.status === 'closed' ? `已关闭 · ${CLOSE_REASON_NAMES[i.closeReason ?? 'completed']}` : '开启'}</span>`;
  const date = (value: string) => `<time datetime="${e(value)}">${e(new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }))}</time>`;
  function markdown(body: string, sourceIssue?: Issue): string {
    const attachment = (path: string) => sourceIssue ? `/api/attachments?issue=${encodeURIComponent(sourceIssue.id)}&path=${encodeURIComponent(path)}` : undefined;
    const wikiLink = (ref: string): string => {
      const [target, alias] = ref.replace(/\\\|/g, '|').split('|');
      const path = target.split('#')[0].replace(/\.md$/, '');
      const found = [...snapshot.issues, ...snapshot.projects].find(x => x.path.replace(/\.md$/, '') === path || x.id === path);
      const href = found && !target.includes('#') ? ('number' in found ? issuePath(found) : projectPath(found.id)) : undefined;
      const file = attachmentPath(target);
      return link(file && attachment(file) || href || note(target), alias || target.split('/').at(-1) || target);
    };
    const parser = new Marked({ gfm: true, breaks: true, renderer: {
      html({ text }) { return e(text); },
      link({ href, tokens }) {
        const file = markdownAttachmentPath(href);
        const safe = file && attachment(file) || safeHref(href);
        return safe ? `<a href="${e(safe)}" rel="noreferrer">${this.parser.parseInline(tokens)}</a>` : this.parser.parseInline(tokens);
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
  function row(i: Issue): string {
    const comments = snapshot.timeline.filter(t => t.issueId === i.id && t.kind === 'comment').length;
    return `<article class="row">${state(i)} &nbsp;${link(issuePath(i) || open(i, 'issue'), i.title, ' class="title"')} ${labels(i)}<div class="meta">#${i.number} · ${e(i.author)} · ${date(i.updatedAt)}${comments ? ` · ${comments} 条评论` : ''}</div></article>`;
  }
  const crumbs = `${link('/', '项目')}${project ? ` / ${link(projectPath(project.id) || open(project), project.title)}` : ''}${issue ? ` / #${issue.number}` : ''}`;
  let content = `<header><nav aria-label="导航">${crumbs}${link(issue ? open(issue, 'issue') : open(project), '在 Obsidian 中编辑', ' class="edit button"')}</nav></header><main>`;
  let title = project?.title || vaultName;
  if (issue) {
    title = `#${issue.number} ${issue.title}`;
    content += `<h1>${e(issue.title)} <span class="muted">#${issue.number}</span></h1>${state(issue)} <span class="muted">${e(issue.author)} · ${date(issue.createdAt)}</span><div class="detail"><div><article class="card"><div class="card-head"><strong>${e(issue.author)}</strong>描述</div>${markdown(issue.body || '暂无描述', issue)}</article>`;
    const relations = snapshot.issues.filter(i => i.parent === issue.id);
    if (relations.length) content += `<h2>子议题</h2><div class="rows">${relations.map(row).join('')}</div>`;
    for (const entry of snapshot.timeline.filter(t => t.issueId === issue.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      content += entry.kind === 'event' ? `<p class="event">${e(entry.author)} ${e(entry.body)} · ${date(entry.createdAt)}</p>` : `<article class="card" id="${e(entry.id)}"><div class="card-head"><strong>${e(entry.author)}</strong>${date(entry.createdAt)}</div>${markdown(entry.body, issue)}</article>`;
    }
    const relation = (id: string) => { const i = snapshot.issues.find(i => i.id === id); return i ? link(issuePath(i) || open(i, 'issue'), `#${i.number} ${i.title}`) : e(id); };
    const property = (name: string, value: string) => `<section><h2>${name}</h2>${value || '<span class="muted">未设置</span>'}</section>`;
    content += `</div><aside aria-label="属性">${property('状态', state(issue))}${property('标签', labels(issue))}${property('里程碑', e(issue.milestone))}${property('负责人', e(issue.assignees.join('、')))}${property('截止日期', e(issue.dueDate))}${property('父议题', issue.parent ? relation(issue.parent) : '')}${property('依赖', issue.dependencies.map(relation).join('<br>'))}</aside></div>`;
  } else if (project) {
    content += `<h1>${e(project.title)}</h1><span class="muted">${STATUS_NAMES[project.status]}</span>${project.description ? `<div class="description">${markdown(project.description)}</div>` : ''}`;
    const all = page.issues ?? snapshot.issues.filter(i => i.projectId === project.id);
    const selectedState = url.searchParams.get('state') || url.searchParams.get('status') || 'open';
    const base = projectPath(project.id)! + '/issues';
    const destination = (changes: Record<string, string>) => { const query = new URLSearchParams(url.search); query.delete('limit'); for (const [key, value] of Object.entries(changes)) query.set(key, value); return `${base}?${query}`; };
    const mode = url.searchParams.get('view') || 'list';
    const tab = (value: string, text: string) => link(destination({ state: value, status: value }), text, selectedState === value ? ' aria-current="page"' : '');
    content += `<form class="toolbar" action="${e(base)}" method="get"><input type="search" name="q" aria-label="搜索标题、描述、评论" placeholder="搜索标题、描述、评论" value="${e(url.searchParams.get('q') ?? url.searchParams.get('search') ?? '')}"><input type="hidden" name="state" value="${e(selectedState)}"><input type="hidden" name="view" value="${e(mode)}">`;
    for (const name of ['label', 'milestone', 'assignee']) for (const value of url.searchParams.getAll(name)) content += `<input type="hidden" name="${name}" value="${e(value)}">`;
    content += `<button type="submit">搜索</button></form><div class="tabs" aria-label="议题状态">${tab('open', `${all.filter(i => i.status !== 'closed').length} 个开启`)}${tab('closed', `${all.filter(i => i.status === 'closed').length} 个已关闭`)}${tab('all', '全部')}<div class="views">${[['list', 'Issues'], ['board', '看板'], ['table', '表格']].map(([value, name]) => link(destination({ view: value }), name, mode === value ? ' aria-current="page"' : '')).join('')}</div></div>`;
    // The API applies all search and attribute filters; state tabs count the same results.
    const visible = all.filter(i => selectedState === 'all' || (selectedState === 'open' ? i.status !== 'closed' : i.status === selectedState));
    if (!visible.length) content += '<div class="rows empty">没有符合条件的议题</div>';
    else if (mode === 'board') content += `<div class="board">${[['open', '开启'], ['completed', '完成'], ['on-hold', '搁置'], ['not-planned', '不做']].map(([value, name]) => `<section class="column"><h2>${name}</h2>${visible.filter(i => value === 'open' ? i.status !== 'closed' : i.status === 'closed' && (i.closeReason ?? 'completed') === value).map(row).join('')}</section>`).join('')}</div>`;
    else if (mode === 'table') content += `<div class="rows table-wrap"><table class="issue-table"><thead><tr><th>议题</th><th>状态</th><th>标签</th><th>里程碑</th><th>负责人</th><th>截止日期</th></tr></thead><tbody>${visible.map(i => `<tr><td>${link(issuePath(i)!, `#${i.number} ${i.title}`)}</td><td>${state(i)}</td><td>${labels(i)}</td><td>${e(i.milestone)}</td><td>${e(i.assignees.join('、'))}</td><td>${e(i.dueDate)}</td></tr>`).join('')}</tbody></table></div>`;
    else content += `<div class="rows">${visible.map(row).join('')}</div>`;
  } else {
    content += `<h1>${e(vaultName)}</h1><div class="rows">${snapshot.projects.map(p => { const issues = snapshot.issues.filter(i => i.projectId === p.id); return `<article class="row">${link(projectPath(p.id)!, p.title, ' class="title"')} <span class="muted">${STATUS_NAMES[p.status]}</span>${p.description ? markdown(p.description) : ''}<div class="meta">${issues.filter(i => i.status !== 'closed').length} 个开启 · ${issues.filter(i => i.status === 'closed').length} 个已关闭</div></article>`; }).join('') || '<p class="empty">暂无项目</p>'}</div>`;
  }
  return htmlDocument(title, content + '<footer>Local Issues · 内容保存在本机 Obsidian 笔记库</footer></main>');
}
