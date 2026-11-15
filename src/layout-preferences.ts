import type { Project } from './types';

export interface LayoutPreferences { sidebarWidth?: number; sidebarHidden?: boolean; projectOrder?: string[]; projectSort?: string; }

export function layoutPreferences(value: unknown): LayoutPreferences {
  if (!value || typeof value !== 'object') return {};
  const stored = value as Record<string, unknown>;
  return {
    ...(typeof stored.sidebarHidden === 'boolean' ? { sidebarHidden: stored.sidebarHidden } : {}),
    ...(typeof stored.sidebarWidth === 'number' && Number.isFinite(stored.sidebarWidth) ? { sidebarWidth: Math.max(180, Math.min(480, stored.sidebarWidth)) } : {}),
    ...(Array.isArray(stored.projectOrder) ? { projectOrder: [...new Set(stored.projectOrder.filter((id): id is string => typeof id === 'string'))] } : {}),
    ...(typeof stored.projectSort === 'string' && ['manual', 'updated', 'title', 'due'].includes(stored.projectSort) ? { projectSort: stored.projectSort } : {}),
  };
}

export function orderedProjects(projects: Project[], sort: string, order: string[] = []): Project[] {
  const positions = new Map(order.map((id, index) => [id, index]));
  return [...projects].sort((a, b) => sort === 'manual'
    ? (positions.get(a.id) ?? Infinity) - (positions.get(b.id) ?? Infinity) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
    : sort === 'title' ? a.title.localeCompare(b.title) : sort === 'due' ? (a.dueDate || '9999').localeCompare(b.dueDate || '9999') : b.updatedAt.localeCompare(a.updatedAt));
}

/** Move only the visible slots, preserving filtered and archived projects. */
export function moveProjectOrder(all: string[], visible: string[], source: string, target: string, after: boolean): string[] {
  if (source === target || !visible.includes(source) || !visible.includes(target)) return all;
  const next = visible.filter(id => id !== source);
  next.splice(next.indexOf(target) + Number(after), 0, source);
  const slots = new Set(visible); let index = 0;
  return all.map(id => slots.has(id) ? next[index++] : id);
}
