# Local Issues：链接与 CLI

分享内容是一条语义化链接。浏览器打开会显示本机 HTML 阅读页面，编辑时可进入 Obsidian；agent 通过 CLI 读取 JSON 和操作数据。无需登录、token 或分享密钥。浏览器通过 `Accept: text/html` 获取网页；CLI 和不声明 HTML 的请求继续获取 JSON。

| 链接路径 | 指向 |
| --- | --- |
| `/` | 当前笔记库，即本地仓库 |
| `/local-issues` | 一个项目 |
| `/local-issues/issues` | 项目的议题列表 |
| `/local-issues/issues?state=open&label=bug` | 项目内未关闭、标签为 bug 的议题 |
| `/local-issues/issues/5` | 项目内第 5 条议题 |

完整地址以 `http://localhost:27183` 开头。`local-issues` 来自项目名称；中文名称保留中文，重名时添加数字后缀。项目链接名首次生成后固定，修改项目标题仍可访问原链接。

## 复制链接

- 项目首页：复制仓库链接。
- 项目「更多 → 分享给 Agent」：复制项目链接。
- 项目「更多 → 复制 Issues 列表链接」：复制列表链接，保留当前状态、搜索、标签、里程碑筛选。
- 议题「更多 → 分享给 Agent」：复制该议题链接。

链接只定位资源，不嵌入命令、文件路径、密钥或 API 内部路由。

## Agent 使用

在 Obsidian 中启用 Local Issues 的本地 API。CLI 需要 Node.js 22 或以上；从源码目录运行 `npm install -g .` 后，可使用 `local-issues` 命令（支持 Windows），也可用 `node '/路径/cli.mjs'` 代替 `local-issues`。

```sh
local-issues view '<任意资源链接>' --json
local-issues repo view 'http://localhost:27183/' --json
local-issues project view 'http://localhost:27183/local-issues' --json
local-issues issue list 'http://localhost:27183/local-issues/issues?state=open' --json
local-issues issue view 'http://localhost:27183/local-issues/issues/5' --json
```

`local-issues view` 自动识别仓库、项目、列表或议题。修改、评论、关闭沿用同一议题链接：

```sh
local-issues issue edit '<议题链接>' --body-file description.md --if-match '<revision>'
local-issues issue comment '<议题链接>' --body-file reply.md
local-issues issue close '<议题链接>' --reason completed
local-issues issue reopen '<议题链接>'
```

`--json number,title,body,comments,revision` 选择字段；`--comments` 显示评论与状态时间线；`--body-file -` 从标准输入读取正文。读取 revision 后使用 `--if-match` 可检测并发覆盖。

服务仅监听本机，拒绝浏览器跨域请求。链接本身不授予额外权限；本机 CLI 可操作当前库。旧分享链接继续兼容，但不再需要其中的 key。Obsidian 双链用于笔记关联，资源链接用于跨工具定位。

## 参考

沿用 GitHub CLI 的对象、动作、编号或 URL 和选项结构：[gh issue view](https://cli.github.com/manual/gh_issue_view)、[gh issue edit](https://cli.github.com/manual/gh_issue_edit)、[gh issue comment](https://cli.github.com/manual/gh_issue_comment)。

关闭原因可选 `completed`（完成）、`on-hold`（搁置）或 `not-planned`（不做），默认为 `completed`。
