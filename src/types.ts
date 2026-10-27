export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export type IssueStatus = 'open' | 'in-progress' | 'closed';
export type CloseReason = 'completed' | 'on-hold' | 'not-planned';
export interface Project {
  id: string; title: string; description: string; status: ProjectStatus; dueDate: string;
  createdAt: string; updatedAt: string; path: string; revision?: string;
}
export interface Issue {
  id: string; projectId: string; number: number; title: string; body: string; status: IssueStatus; closeReason?: CloseReason;
  labels: string[]; milestone: string; assignees: string[]; parent: string; dependencies: string[];
  dueDate: string; author: string; createdAt: string; updatedAt: string; path: string; revision?: string;
}
export interface TimelineEntry {
  id: string; issueId: string; kind: 'comment' | 'event'; body: string; author: string;
  createdAt: string; updatedAt: string; path: string; revision?: string; from?: IssueStatus; to?: IssueStatus;
}
export interface Snapshot { projects: Project[]; issues: Issue[]; timeline: TimelineEntry[]; warnings: string[]; }
export interface VaultAdapter {
  list(): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string, expectedRaw?: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  exists(path: string): Promise<boolean>;
}
export type ProjectInput = Pick<Project, 'title'> & Partial<Pick<Project, 'description' | 'status' | 'dueDate'>>;
export type ProjectPatch = Partial<ProjectInput>;
export type IssueInput = Pick<Issue, 'title'> & Partial<Pick<Issue, 'body' | 'status' | 'closeReason' | 'labels' | 'milestone' | 'assignees' | 'parent' | 'dependencies' | 'dueDate' | 'author'>>;
export type IssuePatch = Partial<IssueInput> & { actor?: string };
export type Resolved = { kind: 'issue'; value: Issue } | { kind: 'project'; value: Project } | { kind: 'note'; path: string; body: string };
export interface IssueStore {
  snapshot(): Promise<Snapshot>;
  getProject(ref: string): Promise<Project>;
  getIssue(ref: string, project?: string): Promise<Issue>;
  createProject(input: ProjectInput): Promise<Project>;
  updateProject(ref: string, patch: ProjectPatch, expectedUpdatedAt?: string): Promise<Project>;
  createIssue(project: string, input: IssueInput): Promise<Issue>;
  updateIssue(ref: string, patch: IssuePatch, expectedUpdatedAt?: string): Promise<Issue>;
  addComment(ref: string, body: string, author?: string): Promise<TimelineEntry>;
  editComment(id: string, body: string, expectedUpdatedAt?: string): Promise<TimelineEntry>;
  attach(ref: string, name: string, data: Uint8Array): Promise<{ path: string; markdown: string }>;
  resolve(ref: string): Promise<Resolved>;
}
export const ISSUE_STATUSES: IssueStatus[] = ['open', 'closed'];
export const CLOSE_REASON_NAMES: Record<CloseReason, string> = { completed: '完成', 'on-hold': '搁置', 'not-planned': '不做' };
export const STATUS_NAMES: Record<IssueStatus | ProjectStatus, string> = {
  open: '开启', 'in-progress': '进行中', closed: '已关闭', active: '进行中', paused: '已暂停', completed: '已完成', archived: '已归档',
};
export function issueLink(issue: Issue): string { return `[[${issue.path.replace(/\.md$/, '')}|#${issue.number} ${issue.title}]]`; }
