import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedProjects, moveProjectOrder, layoutPreferences } from '../src/layout-preferences';
import type { Project } from '../src/types';

test('manual project order preserves hidden slots and survives sorting independently of updates', () => {
  assert.deepEqual(moveProjectOrder(['a', 'hidden', 'b', 'archived', 'c'], ['a', 'b', 'c'], 'c', 'a', false), ['c', 'hidden', 'a', 'archived', 'b']);
  assert.deepEqual(moveProjectOrder(['a', 'b', 'c'], ['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a']);
  assert.deepEqual(moveProjectOrder(['a', 'b'], ['a', 'b'], 'a', 'missing', false), ['a', 'b']);
  const projects = [{ id: 'a', updatedAt: '2026-11-01' }, { id: 'b', updatedAt: '2026-11-06' }, { id: 'new', updatedAt: '2026-11-07' }] as Project[];
  assert.deepEqual(orderedProjects(projects, 'manual', ['a', 'b']).map(project => project.id), ['a', 'b', 'new']);
  assert.deepEqual(orderedProjects(projects, 'updated', ['a', 'b']).map(project => project.id), ['new', 'b', 'a']);
});

test('layout preferences reject malformed values and constrain usable widths', () => {
  assert.deepEqual(layoutPreferences(null), {});
  assert.deepEqual(layoutPreferences({ sidebarWidth: NaN, projectOrder: 'oops', projectSort: 'no' }), {});
  assert.deepEqual(layoutPreferences({ sidebarWidth: 999, projectOrder: ['a', 'a', null, 'b'], projectSort: 'manual' }), { sidebarWidth: 480, projectOrder: ['a', 'b'], projectSort: 'manual' });
  assert.equal(layoutPreferences({ sidebarWidth: 1 }).sidebarWidth, 180);
  assert.deepEqual(layoutPreferences({ sidebarHidden: 'false' }), {});
  assert.deepEqual(layoutPreferences({ sidebarHidden: true }), { sidebarHidden: true });
  assert.deepEqual(layoutPreferences({ sidebarHidden: false }), { sidebarHidden: false });
});
