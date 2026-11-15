import type { Issue, Project } from './types';

/** Search relevance wins within each project group; nearby numbers break ties. */
export function issueOptions(issues: Issue[], projects: Project[], projectId: string, number: number, query = '', excluded = new Set<string>()): Issue[] {
  const names = new Map(projects.map(project => [project.id, project.title.toLowerCase()]));
  const text = query.replace(/^[@/]/, '').normalize('NFKC').trim().toLowerCase();
  const terms = text.split(/\s+/).filter(Boolean);
  const score = (issue: Issue) => {
    const title = issue.title.normalize('NFKC').toLowerCase();
    if (text === String(issue.number) || text === `#${issue.number}`) return 5;
    if (title === text) return 4;
    if (title.startsWith(text)) return 3;
    if (title.includes(text)) return 2;
    return 1;
  };
  return issues.filter(issue => !excluded.has(issue.id) && terms.every(term => `${names.get(issue.projectId) || ''} #${issue.number} ${issue.title}`.normalize('NFKC').toLowerCase().includes(term)))
    .sort((a, b) => Number(b.projectId === projectId) - Number(a.projectId === projectId)
      || (text ? score(b) - score(a) : 0)
      || Math.abs(a.number - number) - Math.abs(b.number - number)
      || b.number - a.number || a.id.localeCompare(b.id));
}
