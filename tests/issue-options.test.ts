import test from 'node:test';
import assert from 'node:assert/strict';
import { issueOptions } from '../src/issue-options';
import type { Issue, Project } from '../src/types';

const projects = [{ id: 'a', title: '当前项目' }, { id: 'b', title: '其他项目' }] as Project[];
const issue = (number: number, title: string, projectId = 'a') => ({ id: `${projectId}-${number}`, number, title, projectId }) as Issue;

test('relation options group the current project and order by distance rather than creation order', () => {
  const choices = [issue(2, '较早'), issue(45, '前一条'), issue(47, '后一条'), issue(46, '当前议题'), issue(1, '外部', 'b')];
  assert.deepEqual(issueOptions(choices, projects, 'a', 46, '', new Set(['a-46'])).map(issue => issue.id), ['a-47', 'a-45', 'a-2', 'b-1']);
});

test('keyword relevance outranks number distance, and normal text, full-width numbers and legacy prefixes work', () => {
  const choices = [issue(45, '输入框问题'), issue(1, '输入'), issue(2, '输入优化'), issue(3, '其他内容')];
  assert.deepEqual(issueOptions(choices, projects, 'a', 46, '输入').map(issue => issue.number), [1, 45, 2]);
  assert.deepEqual(issueOptions(choices, projects, 'a', 46, '@输入').map(issue => issue.number), [1, 45, 2]);
  assert.deepEqual(issueOptions(choices, projects, 'a', 46, '/＃４５').map(issue => issue.number), [45]);
  assert.deepEqual(issueOptions(choices, projects, 'a', 46, '当前项目 优化').map(issue => issue.number), [2]);
  assert.deepEqual(issueOptions(choices, projects, 'a', 46, '没有匹配'), []);
});

test('cross-project search finds matches without including the issue itself or existing dependencies', () => {
  const choices = [issue(45, '同项目'), issue(46, '自身'), issue(1, '外部匹配', 'b')];
  assert.deepEqual(issueOptions(choices, projects, 'a', 46, '其他项目 外部').map(issue => issue.id), ['b-1']);
  assert.deepEqual(issueOptions(choices, projects, 'a', 46, '', new Set(['a-45', 'a-46', 'b-1'])), []);
});
