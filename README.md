# Local Issues

[中文说明](README.zh-CN.md)

GitHub Issues-style project tracking inside an Obsidian vault. Organize projects, issues and ongoing discussions as local Markdown files that remain readable without the plugin.

**Desktop only · Obsidian 1.14.4+ · Interface language: Simplified Chinese · MIT license**

- Multiple projects with progress, search, filters, sorting and grouping.
- Issue lists, Kanban boards and tables, with labels, milestones, assignees and due dates.
- Parent issues, sub-issues and dependencies.
- Markdown descriptions and editable comments, with chronological status history.
- Native Obsidian links, hyperlinks, attachments, pasted images and dropped files.
- An optional loopback API and a separate agent CLI with familiar `gh`-style commands and JSON output.
- Semantic links open a local web interface for creating and editing projects/issues, inline Markdown editing and previews, comments, close reasons, attachments, relations and bulk updates. Lists default to open issues and support search, filters, sorting, grouping, board and table views. Drag cards to change state. The web interface and Obsidian share the same Markdown files and revision checks, with no polling or external dependencies at runtime. Note embeds, heading/block references and advanced Obsidian rendering open in Obsidian.
- `/llms.txt` provides the agent bootstrap (including how to save the skill; web pages do not show it) and `/api/cli.mjs` downloads the installed standalone CLI (Node.js 22+).
- Revision checks and atomic writes protect edits made directly in your notes.

![Issue board with sample data](docs/images/board.png)

![Issue editor](docs/images/issue-editor.png)

## Install

Download `local-issues.zip` from [Releases](https://github.com/xinxinrana/obsidian-local-issues/releases/latest), extract the `local-issues` folder into `<vault>/<config-directory>/plugins/`, and enable **Local Issues** in Obsidian's Community plugins settings. The default configuration directory is `.obsidian`.

Alternatively, place `main.js`, `manifest.json` and `styles.css` from the same release into that plugin folder. The CLI is optional and distributed separately as `cli.mjs`; the complete ZIP includes it.

Open the ribbon button **Local Issues：项目**, or run **Local Issues：打开项目** in the command palette. Create a project, then create its first issue. The **更多** menus contain note and sharing actions. In the issue editor, expand **属性与关联** to set labels, milestones, assignees and relationships.

## Agent CLI

The CLI requires Node.js 22+ and a running desktop Obsidian instance with Local Issues enabled.

1. Open the Local Issues settings. The complete ZIP includes `cli.mjs`; other installations can download it through **安装 CLI**.
2. Enable **本地 Agent API** in plugin settings. It is disabled by default on a new installation.
3. Click **安装 CLI** in settings. The installer checks Node.js 22+, reuses the bundled CLI or downloads the matching release with SHA-256 verification, installs `local-issues` in `~/.local/bin`, configures your user PATH and verifies the command. Reopen your terminal to use it. Failures show the current step and a relevant recovery action. The command uses `--vault`, so port changes need no reinstall.
4. **复制引导语** copies a short hand-off telling the agent to save the skill into its own skills directory; **复制 Skill** copies `SKILL.md` only. Agents can also run `local-issues skill` (or `local-issues skill --dir <dir>`).

Without the command, use `node '/path/to/plugin/cli.mjs' --vault "/path/to/vault" --help`.

**复制引导语** provides the agent hand-off; **复制 Skill** provides the standalone skill contents.

The default configuration directory is `.obsidian`. The CLI currently expects that default directory when locating a vault's API settings.

For bash or zsh, define a convenience function after installing the CLI in the plugin folder:

```sh
local-issues() { node '/path/to/vault/.obsidian/plugins/local-issues/cli.mjs' "$@"; }

local-issues project create -t 'My project'
local-issues issue create -P 'My project' -t 'Support pasted images' -b 'See [[Design]]'
local-issues issue list -P 'My project' --state all --json number,title,status
local-issues issue view 1 -P 'My project' --json
local-issues issue comment 1 -P 'My project' -b 'Agent progress update' --author Agent
local-issues issue edit 1 -P 'My project' --label feature --milestone 'First release'
local-issues issue attach 1 -P 'My project' ./screenshot.png
local-issues issue close 1 -P 'My project'
local-issues issue reopen 1 -P 'My project'
```

`--body-file file.md` reads Markdown from a file; `--body-file -` reads standard input. Use project-scoped numbers, stable IDs or full Obsidian links to identify issues. `--if-match <revision>` rejects a stale edit; read the current revision with `issue view --json` first.

Choose **分享给 Agent** to copy a readable resource URL, such as:

```text
http://localhost:27183/
http://localhost:27183/local-issues
http://localhost:27183/local-issues/issues?state=open
http://localhost:27183/local-issues/issues/5
```

The repository is the current vault. Project URL names remain stable after title edits. **复制 Issues 列表链接** preserves the current list filters. Links contain no executable commands or credentials. No login or keys are required.

```sh
local-issues view '<resource URL>' --json
local-issues repo view '<repo URL>' --json
local-issues project view '<project URL>' --json
local-issues issue list '<issues list URL>' --json
local-issues issue view '<issue URL>' --comments
local-issues issue edit '<issue URL>' --body-file description.md --if-match '<revision>'
local-issues issue comment '<issue URL>' --body-file reply.md
local-issues issue close '<issue URL>'
local-issues issue reopen '<issue URL>'
```

The settings installer installs the `local-issues` command; `npm install -g .` from the source directory also works, including on Windows. `local-issues view` infers the target type; `-P` accepts a project title, folder name or the project name from a link. Replace `local-issues` with `node '/absolute/path/cli.mjs' --vault '/path/to/vault'` if needed. Existing legacy share URLs and `local-issues share ...` commands remain compatible. See the [link and CLI guide](docs/agent-cli.zh-CN.md).

## Local data and privacy

Projects, issues, comments and status events live in `Local Issues/` by default. Each project has a `project.md` file, an `issues/` folder and a `timeline/` folder. Images and attachments are stored in `resource/local-issues/`. You can read and edit these Markdown files with Obsidian or another editor. Preserve their `id`, `type`, `projectId` and `issueId` properties. Issue states are `open` and `closed`; `closeReason` is `completed`, `on-hold`, or `not-planned`. Legacy `in-progress` is read as open.

No account, subscription, payment or remote service is required. There is no telemetry. Normal project operations use no external services; clicking **安装 CLI** may download the matching CLI and checksum file from GitHub. Its optional HTTP server binds only to `127.0.0.1`, on port `27183` by default. CLI requests are restricted to loopback HTTP addresses. The local API requires no credentials and rejects browser cross-origin requests.

Resource links identify local data. They work only on the computer running Obsidian; the local CLI can read and modify the active vault.

Project data stays inside the vault. The separate CLI reads its settings from the vault and reads attachment or body files outside the vault **only when you explicitly pass their paths**. CLI installation starts only when you click **安装 CLI**. It writes a user-local launcher and, where necessary, a marked shell PATH block (or the Windows user PATH). Uninstall removes its managed launcher and PATH changes while retaining the plugin CLI asset and unrelated user configuration. Existing commands owned by other tools or vaults are never overwritten. The plugin does not install commands on startup or install Node.js automatically; missing Node.js produces a download link and an optional executable-path field.

## Develop

```sh
npm ci
npm run build
npm test
```

The build produces `main.js` and `cli.mjs`. Tests use temporary data and mocked Obsidian components; they do not access your vault. Release tags exactly match `manifest.json` versions, without a `v` prefix. Upload `main.js`, `manifest.json` and `styles.css` to each GitHub release; attach `cli.mjs` and the complete ZIP for CLI and manual installations.

## License and support

[MIT](LICENSE). Bundled `yaml` uses the ISC license; see [third-party notices](THIRD_PARTY_NOTICES.txt). Demo screenshots contain synthetic example data.

Report bugs and feature requests in [GitHub Issues](https://github.com/xinxinrana/obsidian-local-issues/issues).
