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
    '编号只在项目内唯一：跨项目读取或修改时带上 `-P <项目>`（接受标题、文件夹名或链接里的项目名），或直接传链接。',
    '',
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
    '**每一条写操作都带 `--author <你的名字>`。** agent 用 `WorkBuddy`，代用户发言前先确认归属。默认值是 `Agent`，作者写进去后很难追溯是谁写的，所以是"动手前就填对"，不要依赖默认值。',
    '',
    fence,
    'issue create -P 项目 -t 标题 -b 正文 --author WorkBuddy',
    'issue edit 5 -P 项目 -F body.md --author WorkBuddy   # 或 -b 正文',
    'issue comment 5 -P 项目 -b 内容 --author WorkBuddy',
    'issue attach 5 -P 项目 shot.png --author WorkBuddy   # 会额外创建一条评论',
    'issue close 5 -P 项目 --reason completed --author WorkBuddy',
    'issue reopen 5 -P 项目 --author WorkBuddy',
    'issue share 5 -P 项目              # 生成分享链接',
    'project create -t 标题 --author WorkBuddy',
    fence,
    '',
    '`issue attach` 不是单纯上传：它会把文件存进 `resource/local-issues/`，并在时间线上自动建一条只含 `![[...]]` 的评论——所以要带 `--author`，要改说明就编辑那条评论。想让图配一段说明，用 `issue attach ... -b 说明文字 --author 名字` 一次写完，别先 attach 再 comment。',
    '',
    '输出：默认是制表符分隔的文本（列表列依次为编号、状态、项目、标题、标签；带 `-P` 或链接时没有项目列），空字段留空但不省略制表符。需要给程序处理时加 `--json`，可裁剪字段（`--json number,title,status`）；跨项目列表里每条都带 `project` 字段。',
    '',
    '改正文时带上 `--if-match <updatedAt>` 可避免覆盖别人的并发修改。作者写错了用 `comment edit <评论ID> -b 内容 --author 名字` 改正（不传 `--author` 就保持原值）；删除评论是 `comment delete`，和 `issue close` 一样先跟用户确认。',
    '',
    '`--help` 查看全部用法，`local-issues issue --help` 只看某一组命令；`local-issues --version` 显示版本。',
    '',
    '标签写重要性和类别（`-l P1,CLI`），版本号写里程碑（`--milestone 0.2.4`）：里程碑按版本记录发版，标签不要放版本号。',
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
    '路径里的议题要用编号而不是内部 id（`/api/issues/<编号>?project=<项目名>`）；改评论作者走 `api /api/comments/<评论ID> -X PATCH -f body=内容 -f author=名字`。',
    '',
    '需要 Node.js 22+、Obsidian 运行并开启本地 API，无需登录或密钥。服务不可用时提示用户启动 Obsidian。',
  ].join('\n');
}

/** SKILL.md：一页命令速查，装进 agent 的 skills 目录。 */
export function agentSkill(options: SkillOptions): string {
  return [
    '---',
    'name: local-issues',
    `description: 查看、创建、修改、评论、关闭 Obsidian 本地项目与议题（Local Issues）时使用；用户没有给链接、只说“看看我的 issues”“建个议题”时也要使用，${options.origin}/ 开头的链接同样适用。`,
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
    '存好之后按下面的命令操作。人类不需要读这一节，直接看网页即可。',
    '',
    fence,
    'view <链接>                    # 项目 / 议题 / 列表，自动识别',
    'issue list -P 项目 --state all # 编号只在项目内唯一，跨项目要带 -P 或传链接',
    'issue view 5 -P 项目 -c        # 带评论时间线',
    'issue comment 5 -P 项目 -b 内容 --author WorkBuddy',
    'issue close 5 -P 项目 --reason completed --author WorkBuddy',
    fence,
    '',
    '写操作一律带 `--author <你的名字>`（agent 用 WorkBuddy）：默认值是 `Agent`，事后容易分不清是谁写的。',
    '',
    '标签只写重要性和类别（`-l P1,CLI`），版本号写里程碑（`--milestone 0.2.4`）。',
    '',
    '完整命令速查用 `local-issues skill`；`local-issues issue --help` 查看某一组命令。',
    '',
  ].join('\n');
}
