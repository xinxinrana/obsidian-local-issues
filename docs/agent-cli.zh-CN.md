# Local Issues：链接与 CLI

分享内容是一条语义化链接。人通过路径看懂目标，agent 通过 CLI 读取和操作。无需登录、token 或分享密钥。

| 链接路径 | 指向 |
| --- | --- |
| `/repos/obsidian` | 当前笔记库，即本地仓库 |
| `/repos/obsidian/projects/local-issues` | 一个项目 |
| `/repos/obsidian/projects/local-issues/issues` | 项目的议题列表 |
| `/repos/obsidian/projects/local-issues/issues?state=open&label=bug` | 项目内未关闭、标签为 bug 的议题 |
| `/repos/obsidian/projects/local-issues/issues/5` | 项目内第 5 条议题 |

完整地址以 `http://127.0.0.1:27183` 开头。`obsidian` 来自笔记库名称，`local-issues` 来自项目名称；中文名称保留中文，重名时添加数字后缀。项目链接名首次生成后固定，修改项目标题仍可访问原链接。

## 复制链接

- 项目首页：复制仓库链接。
- 项目「更多 → 分享给 Agent」：复制项目链接。
- 项目「更多 → 复制 Issues 列表链接」：复制列表链接，保留当前状态、搜索、标签、里程碑筛选。
- 议题「更多 → 分享给 Agent」：复制该议题链接。

链接只定位资源，不嵌入命令、文件路径、密钥或 API 内部路由。

## Agent 使用

在 Obsidian 中启用 Local Issues 的本地 API。CLI 需要 Node.js 22 或以上；安装 `cli.mjs` 后，可使用已配置的 `li` 命令，也可用 `node '/路径/cli.mjs'` 代替 `li`。

```sh
li view '<任意资源链接>' --json
li repo view 'http://127.0.0.1:27183/repos/obsidian' --json
li project view 'http://127.0.0.1:27183/repos/obsidian/projects/local-issues' --json
li issue list 'http://127.0.0.1:27183/repos/obsidian/projects/local-issues/issues?state=open' --json
li issue view 'http://127.0.0.1:27183/repos/obsidian/projects/local-issues/issues/5' --json
```

`li view` 自动识别仓库、项目、列表或议题。修改、评论、关闭沿用同一议题链接：

```sh
li issue edit '<议题链接>' --body-file description.md --if-match '<revision>'
li issue comment '<议题链接>' --body-file reply.md
li issue close '<议题链接>'
li issue reopen '<议题链接>'
```

`--json number,title,body,comments,revision` 选择字段；`--comments` 显示评论与状态时间线；`--body-file -` 从标准输入读取正文。读取 revision 后使用 `--if-match` 可检测并发覆盖。

服务仅监听本机，拒绝浏览器跨域请求。链接本身不授予额外权限；本机 CLI 可操作当前库。旧分享链接继续兼容，但不再需要其中的 key。Obsidian 双链用于笔记关联，资源链接用于跨工具定位。

## 参考

沿用 GitHub CLI 的对象、动作、编号或 URL 和选项结构：[gh issue view](https://cli.github.com/manual/gh_issue_view)、[gh issue edit](https://cli.github.com/manual/gh_issue_edit)、[gh issue comment](https://cli.github.com/manual/gh_issue_comment)。
