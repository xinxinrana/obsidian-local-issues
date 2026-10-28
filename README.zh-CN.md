# Local Issues

[English](README.md)

GitHub Issues 的本地 Obsidian 版。一个笔记库可以有多个项目，项目下有多个 Issues，每个 Issue 下可以持续评论讨论。内容保存在普通 Markdown 文件中。

**仅支持桌面端，要求 Obsidian 1.14.4 或更新版本；当前界面为简体中文。**

- 多项目与进度、搜索、筛选、排序、分组。
- Issue 列表、看板、表格；支持标签、里程碑、负责人、截止日期。
- 父子议题与依赖关系。
- Markdown 描述、可编辑评论和状态时间线。
- Obsidian 双链、超链接、附件、直接粘贴图片和拖入文件。
- 可选的本地 API 与独立 Agent CLI，沿用 `gh` 的命令习惯，支持 JSON 输出。
- 修改时检查 revision 并原子写入，防止覆盖其他编辑。

![看板示例](docs/images/board.png)

## 安装和使用

在 [GitHub Releases](https://github.com/xinxinrana/obsidian-local-issues/releases/latest) 下载 `local-issues.zip`，将其中的 `local-issues` 文件夹放到笔记库的 `<配置目录>/plugins/` 中，再在 Obsidian 第三方插件设置中启用 **Local Issues**。默认配置目录是 `.obsidian`。

也可以单独下载同一个版本的 `main.js`、`manifest.json`、`styles.css` 放入插件目录。社区商店只会安装这三个文件；可选 CLI 需要另行下载 `cli.mjs`，完整 ZIP 已包含它。

点击左侧 **Local Issues：项目** 图标，或在命令面板运行 **Local Issues：打开项目**。先新建项目，再创建 Issue。打开原始笔记、分享等操作位于 **更多** 菜单；新建与编辑 Issue 时，可展开 **属性与关联** 设置其他字段。保存按钮始终固定在弹窗底部。

## Agent CLI

需要 Node.js 22 或更新版本，并保持 Obsidian 和插件运行。

1. 从 Release 下载 `cli.mjs` 放入插件目录（完整 ZIP 已包含；社区商店安装需另行下载）。
2. 在插件设置中启用 **本地 Agent API**。全新安装时默认关闭。
3. 插件加载后会把全局命令 `local-issues` 写到 `~/.local/bin`，指向当前笔记库并通过 `--vault` 自动读取端口；端口改动无需重装。该目录不在 PATH 时会有提示，设置页也可随时「安装命令 / 移除命令」。
4. 把用法交给 agent：**复制引导语** 会复制「把 skill 存到你自己的 skills 目录」的说明，agent 自己知道目录在哪；**复制 Skill** 只复制 `SKILL.md` 正文。也可以让 agent 自己执行 `local-issues skill`（或 `local-issues skill --dir <目录>` 直接落盘）。

命令缺失时用 `node '/插件目录/cli.mjs' --vault "/笔记库路径" --help` 代替。完整命令见 [English README](README.md#agent-cli)。

分享内容是可读的语义化链接，例如 `http://localhost:27183/local-issues/issues/5`。浏览器打开即可新建和编辑项目、议题，在原位置编写／预览正文和评论、修改属性与父子／依赖关系、切换关闭原因、删除评论。支持粘贴图片、拖入附件，或在编辑区按 `⌘/Ctrl+Shift+U` 选择文件；`⌘/Ctrl+Enter` 提交。网页与 Obsidian 共用同一份 Markdown 数据和 revision 冲突检查，保存失败时保留草稿，离开或切换未保存的编辑前会要求确认。

列表默认显示未关闭议题，支持开启／关闭切换、搜索、筛选、排序、分组，以及列表／看板／表格视图。可全选当前结果，批量修改状态、标签和里程碑；失败项保留选中，可读取最新数据后重试。看板卡片可拖到对应状态列。网页仅使用插件内置的本机脚本，不轮询、不下载外部图片。

同一链接交给 agent 时，用 CLI 直接读取 JSON。仓库首页、项目、Issues 列表和具体议题均可复制对应链接；列表链接保留筛选参数。无需登录或密钥。网页支持常见 Markdown、任务列表、表格及双链；笔记嵌入、标题／块引用和复杂 Obsidian 渲染请在 Obsidian 中查看。

`http://localhost:27183/llms.txt` 提供 Agent 自举说明（含保存 skill 的办法，网页里不显示这一段）；`http://localhost:27183/api/cli.mjs` 下载当前插件目录中的独立 CLI，需要 Node.js 22+。插件目录缺少 CLI 时会提示下载失败，不会自动安装软件。

```sh
local-issues view '<资源链接>' --json
local-issues issue list '<Issues 列表链接>' --json
local-issues issue view '<议题链接>' --comments
local-issues issue edit '<议题链接>' --body-file description.md
local-issues issue comment '<议题链接>' --body-file reply.md
local-issues issue close '<议题链接>'
```

插件会自动安装 `local-issues` 命令；也可以从源码目录运行 `npm install -g .`（Windows 也适用）。上例 `local-issues` 可替换为 `node '/路径/cli.mjs' --vault '/笔记库路径'`。项目参数 `-P` 接受项目标题、文件夹名或链接里的项目名。详细路由与命令见[链接与 CLI 使用说明](docs/agent-cli.zh-CN.md)。

## 文件和隐私

默认笔记目录为 `Local Issues/`，每个项目包含 `project.md`、`issues/` 和 `timeline/`。附件放在 `resource/local-issues/`。停用插件后仍可直接阅读与编辑。修改时请保留 `id`、`type`、`projectId` 和 `issueId`；Issue 状态为 `open` 或 `closed`；关闭原因 `closeReason` 为 `completed`、`on-hold` 或 `not-planned`。旧的 `in-progress` 会按开启读取。

无需账号、订阅或付费，没有遥测。插件不会请求远程服务。本地 API 仅监听 `127.0.0.1`，默认端口 `27183`；CLI 仅连接本机地址。本地服务无需凭据，拒绝浏览器跨域请求。

资源链接只定位本机数据，仅在运行 Obsidian 的这台电脑上可用。

插件操作限定在笔记库内。独立 CLI 仅在你明确传入附件路径或 `--body-file` 时读取对应的库外文件。插件不会自动下载、安装或更新 CLI 或其他软件。设置中的 GitHub 下载链接只有在你点击时才会打开。

## 开发与反馈

```sh
npm ci
npm run build
npm test
```

测试使用临时数据和模拟的 Obsidian 组件，不访问你的笔记库。

[MIT 许可证](LICENSE)。依赖 `yaml` 使用 ISC 许可证，详见[第三方声明](THIRD_PARTY_NOTICES.txt)。示例截图为合成演示数据。问题和建议请提交到 [GitHub Issues](https://github.com/xinxinrana/obsidian-local-issues/issues)。
