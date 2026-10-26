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

1. 从 Release 下载 `cli.mjs`。放到插件目录后，可在插件设置点击 **复制 CLI 命令**；也可以放在其他目录，并使用 `--vault` 指定笔记库。
2. 在插件设置中启用 **本地 Agent API**。全新安装时默认关闭。
3. 运行 `node cli.mjs --vault "/笔记库路径" --help`。

CLI 目前按默认 `.obsidian` 配置目录定位 API 设置。完整命令见 [English README](README.md#agent-cli)。

项目或议题的「更多 → 分享给 Agent」只复制一条命令，包含 CLI 的绝对路径、一个分享引用和 `--json`。直接粘贴给 agent，由它执行 CLI 读取；后续沿用同一个引用修改、评论或关闭，无需打开网页或提供多个 API 地址。未安装 CLI 时会提示下载。

```sh
li issue view '<议题分享引用>' --json
li issue view '<议题分享引用>' --comments
li issue edit '<议题分享引用>' --body-file description.md
li issue comment '<议题分享引用>' --body-file reply.md
li issue close '<议题分享引用>'
li issue reopen '<议题分享引用>'
li project view '<项目分享引用>' --json
li project edit '<项目分享引用>' --body '项目说明'
```

上例 `li` 可替换为复制命令中的 `node '/绝对路径/cli.mjs'`。`--comments`（`-c`）显示评论和状态时间线；JSON 可按字段读取 `comments,revision`，修改时用 `--if-match <revision>` 防止覆盖。分享引用只授予对应目标的访问权限；项目分享可读取项目及其议题列表，修改具体议题需使用该议题的分享引用。旧版 `li share ...` 命令继续兼容。

## 文件和隐私

默认笔记目录为 `Local Issues/`，每个项目包含 `project.md`、`issues/` 和 `timeline/`。附件放在 `resource/local-issues/`。停用插件后仍可直接阅读与编辑。修改时请保留 `id`、`type`、`projectId` 和 `issueId`；Issue 状态为 `open`、`in-progress`、`closed`。

无需账号、订阅或付费，没有遥测。插件不会请求远程服务。本地 API 仅监听 `127.0.0.1`，默认端口 `27183`；CLI 仅连接本机地址。API token 和分享密钥保存在插件的本地 `data.json` 中，不写入笔记正文。

分享链接包含目标的读写权限，只在运行 Obsidian 的这台电脑上可用，可以在插件设置撤销，请勿公开发布分享链接。

插件操作限定在笔记库内。独立 CLI 仅在你明确传入附件路径或 `--body-file` 时读取对应的库外文件。插件不会自动下载、安装或更新 CLI 或其他软件。设置中的 GitHub 下载链接只有在你点击时才会打开。

## 开发与反馈

```sh
npm ci
npm run build
npm test
```

测试使用临时数据和模拟的 Obsidian 组件，不访问你的笔记库。

[MIT 许可证](LICENSE)。依赖 `yaml` 使用 ISC 许可证，详见[第三方声明](THIRD_PARTY_NOTICES.txt)。示例截图为合成演示数据。问题和建议请提交到 [GitHub Issues](https://github.com/xinxinrana/obsidian-local-issues/issues)。
