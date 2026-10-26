# Local Issues：Agent 交付与 CLI

## 交付方式

项目或议题「更多 → 分享给 Agent」复制一条可直接运行的命令：

```sh
node '/笔记库/.obsidian/plugins/local-issues/cli.mjs' issue view '<分享引用>' --json
```

项目使用 `project view`。把这一条命令交给 agent 即可；agent 通过 CLI 读取内容，沿用同一个引用完成后续操作。命令包含 CLI 绝对路径，不依赖预先安装 `li`。未安装 `cli.mjs` 时，插件提示从 Release 下载。

## 命令约定

以下 `li` 代表交付命令中的 `node '/绝对路径/cli.mjs'`：

```sh
li issue view '<引用>' --json number,title,body,comments,revision
li issue view '<引用>' --comments
li issue edit '<引用>' --body-file description.md --if-match '<revision>'
li issue edit '<引用>' --add-label feature --remove-label bug
li issue comment '<引用>' --body-file reply.md
li issue close '<引用>'
li issue reopen '<引用>'
li project view '<项目引用>' --json
li project edit '<项目引用>' --body '项目说明'
```

正文支持 `--body`、`--body-file <文件>`、`--body-file -`（标准输入）。普通输出默认显示正文，`--comments` / `-c` 显示评论与状态时间线；JSON 通过字段选择控制输出。读取 `revision` 后，修改时传入 `--if-match` 可检测并发冲突。

本地已授权 CLI 还支持项目内编号（配合 `-P`）、稳定 ID 和 Obsidian 双链。旧分享引用和 `li share ...` 命令继续有效。

## 权限范围

分享引用仅在运行 Obsidian 的本机有效，携带目标的读写权限，不需要整库 API token。议题分享只允许操作该议题及其评论；项目分享可读取项目及议题列表、修改项目，修改具体议题应使用议题分享。撤销分享后，原引用失效。不要公开含密钥的实际引用。

`--web` 只用于本地编号或 ID；agent 交付通过 CLI 获取 JSON。Obsidian 双链用于笔记间关联，CLI 分享引用用于授权访问。

## 设计依据

沿用 GitHub CLI 的「对象 + 动作 + 编号或 URL + 选项」结构，减少 agent 学习成本与交付文字：

- [gh issue view](https://cli.github.com/manual/gh_issue_view)：编号或 URL、评论、JSON。
- [gh issue edit](https://cli.github.com/manual/gh_issue_edit)：URL 引用、正文文件、标签。
- [gh issue comment](https://cli.github.com/manual/gh_issue_comment)：同一引用下发表评论。

保留现有分享凭据和权限边界，交付内容只包含一条入口命令。
