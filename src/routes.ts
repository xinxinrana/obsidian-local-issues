import type { IssueStore, Project } from './types';

export type ResourceKind = 'repo' | 'project' | 'issues' | 'issue';
export interface ResourceRoute { kind: ResourceKind; repo: string; project?: string; number?: number; suffix: string[] }
export function slug(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'untitled';
}
export function parseResource(url: URL): ResourceRoute | undefined {
  const p = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if (p[0] !== 'repos') return undefined;
  if (!p[1] || url.username || url.password || url.hash) throw new Error('仓库链接格式不正确。');
  if (p.length === 2) return { kind: 'repo', repo: p[1], suffix: [] };
  if (p[2] !== 'projects' || !p[3]) throw new Error('项目链接格式不正确。');
  if (p.length === 4) return { kind: 'project', repo: p[1], project: p[3], suffix: [] };
  if (p[4] !== 'issues') throw new Error('议题链接格式不正确。');
  if (p.length === 5) return { kind: 'issues', repo: p[1], project: p[3], suffix: [] };
  if (!/^[1-9]\d*$/.test(p[5]) || !Number.isSafeInteger(Number(p[5]))) throw new Error('议题编号必须是正整数。');
  return { kind: 'issue', repo: p[1], project: p[3], number: Number(p[5]), suffix: p.slice(6) };
}

// Project URLs keep their first assigned name across title edits and restarts.
export class ResourceRoutes {
  constructor(readonly repo: string, readonly projects: Record<string, string> = {}, private save: () => Promise<void> = async () => {}) {}
  async sync(store: IssueStore): Promise<Project[]> {
    const projects = (await store.snapshot()).projects;
    let changed = false;
    for (const project of [...projects].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.path.localeCompare(b.path))) {
      if (Object.hasOwn(this.projects, project.id)) continue;
      const base = slug(project.title); let name = base, n = 2;
      while (Object.values(this.projects).includes(name)) name = `${base}-${n++}`;
      this.projects[project.id] = name; changed = true;
    }
    if (changed) await this.save();
    return projects;
  }
  async path(store: IssueStore, ref?: string, scope?: 'issues'): Promise<string> {
    const base = `/repos/${encodeURIComponent(this.repo)}`;
    if (!ref) return base;
    await this.sync(store);
    const target = await store.resolve(ref);
    if (target.kind === 'note') throw new Error('只能链接仓库、项目或议题。');
    const id = target.kind === 'issue' ? target.value.projectId : target.value.id;
    const project = `${base}/projects/${encodeURIComponent(this.projects[id])}`;
    return target.kind === 'issue' ? `${project}/issues/${target.value.number}` : project + (scope === 'issues' ? '/issues' : '');
  }
  async translate(store: IssueStore, route: ResourceRoute): Promise<string | undefined> {
    if (route.repo !== this.repo) throw new Error('仓库不存在，请检查链接或 CLI 的 --vault 配置。');
    if (route.kind === 'repo') return undefined;
    const projects = await this.sync(store);
    const project = projects.find(p => this.projects[p.id] === route.project);
    if (!project) throw new Error('项目不存在。');
    if (route.kind === 'project') return `/api/projects/${encodeURIComponent(project.id)}`;
    if (route.kind === 'issues') return `/api/issues?project=${encodeURIComponent(project.id)}`;
    const issue = await store.getIssue(String(route.number), project.id);
    return `/api/issues/${encodeURIComponent(issue.id)}${route.suffix.length ? '/' + route.suffix.map(encodeURIComponent).join('/') : ''}`;
  }
}
