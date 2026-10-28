export interface SkillOptions {
  /** Local API origin, e.g. `http://localhost:27183`. */
  origin: string;
  /** Absolute path to cli.mjs, used as a fallback when the global command is missing. */
  cli?: string;
  /** Vault path baked into the fallback command. */
  vault?: string;
}

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

function fallbackCommand(options: SkillOptions): string | undefined {
  if (!options.cli) return undefined;
  return `node ${quote(options.cli)}${options.vault ? ` --vault ${quote(options.vault)}` : ''}`;
}

const fence = '```';

function skillBody(options: SkillOptions): string {
  const fallback = fallbackCommand(options);
  return [
    '# Local Issues',
    '',
    'Obsidian 里的本地 GitHub Issues，数据就是笔记库中的 Markdown。',
    '链接：`/` 仓库 · `/项目` 项目 · `/项目/issues` 列表 · `/项目/issues/5` 第 5 条；链接可以直接当参数。',
    '',
    `和 \`gh\` 同款用法，全局命令 \`local-issues\`：`,
    '',
    fence + 'sh',
    `local-issues view '${options.origin}/项目/issues/5'`,
    fence,
    '',
    ...(fallback ? ['没装全局命令时，用完整前缀：', '', fence + 'sh', fallback, fence, ''] : []),
    '## 查',
    '',
    fence,
    'view <链接>                        # 项目 / 议题 / 列表，自动识别',
    'project list                       # 项目与完成进度',
    'issue list -P 项目 --state all     # 也可以直接 issue list <列表链接>',
    'issue list -P 项目 -S 关键词',
    'issue view 5 -P 项目 -c            # -c 显示评论与状态时间线',
    'repo view                          # 仓库与项目列表',
    fence,
    '',
    '## 改',
    '',
    fence,
    'issue create -P 项目 -t 标题 -b 正文',
    'issue edit 5 -P 项目 -F body.md    # 或 -b 正文',
    'issue comment 5 -P 项目 -b 内容',
    'issue close 5 -P 项目 --reason completed',
    'issue reopen 5 -P 项目',
    'issue attach 5 -P 项目 shot.png',
    'issue share 5 -P 项目              # 生成分享链接',
    'project create -t 标题',
    fence,
    '',
    '`--json` 输出结构化结果。改正文时带上 `--if-match <updatedAt>` 可避免覆盖别人的并发修改。关闭、删除这类操作先跟用户确认。',
    '',
    '## 兜底',
    '',
    '命令没覆盖的直接打本地 API：',
    '',
    fence,
    'api /api/health',
    'api "/api/projects"',
    'api /api/issues/5 -X PATCH -f status=closed',
    fence,
    '',
    '需要 Node.js 22+、Obsidian 运行并开启本地 API，无需登录或密钥。服务不可用时提示用户启动 Obsidian。',
  ].join('\n');
}

/** SKILL.md：一页命令速查，装进 agent 的 skills 目录。 */
export function agentSkill(options: SkillOptions): string {
  return [
    '---',
    'name: local-issues',
    `description: 管理 Obsidian 里的本地项目与议题（Local Issues）。遇到 ${options.origin}/ 开头的链接时使用。`,
    '---',
    '',
    skillBody(options),
    '',
  ].join('\n');
}

/** /llms.txt：给 Agent 的自举说明（装 skill），人类页面不展示这一段。 */
export function agentGuide(options: SkillOptions): string {
  const fallback = fallbackCommand(options);
  return [
    '# Local Issues',
    '',
    `Obsidian 里的本地项目与议题，数据是笔记库中的 Markdown。<${options.origin}>`,
    '',
    `CLI 下载：${options.origin}/api/cli.mjs（Node.js 22+，无需登录或密钥）`,
    '',
    '## 给 Agent：保存这份 skill',
    '',
    '把下面的 skill 正文存到你自己的 skills 目录，文件名 `local-issues/SKILL.md`（你的目录在哪由你自己判断）。需要 frontmatter 就直接用：',
    '',
    fence + 'sh',
    'local-issues skill',
    fence,
    '',
    '也可以指定落盘位置（会写成 `<目录>/local-issues/SKILL.md`）：',
    '',
    fence + 'sh',
    'local-issues skill --dir <你的 skills 目录>',
    fence,
    '',
    ...(fallback ? ['没有全局命令时先用完整前缀：', '', fence + 'sh', fallback, fence, ''] : []),
    '存好之后按下面的 skill 操作。人类不需要读这一节，直接看网页即可。',
    '',
    '---',
    '',
    skillBody(options),
    '',
  ].join('\n');
}
