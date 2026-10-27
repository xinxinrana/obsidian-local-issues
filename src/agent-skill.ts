export function agentSkill(cliPath: string, port: number): string {
  const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
  const origin = `http://localhost:${port}`;
  const cli = `node ${quote(cliPath)} --url ${quote(origin)}`;
  return `---
name: local-issues
description: 使用 Local Issues CLI 管理 Obsidian 本地项目与议题。遇到 ${origin}/ 或 http://127.0.0.1:${port}/ 开头的资源链接时使用。
---

# Local Issues

Local Issues 是 Obsidian 中的本地 GitHub Issues：项目下有议题，议题有正文、状态、评论和附件。看到上述端口的链接时，通过下面的 CLI 读取和操作，不用浏览器或网页抓取工具。

链接含义：\`/\` 是仓库，\`/项目名\` 是项目，\`/项目名/issues\` 是议题列表，\`/项目名/issues/5\` 是第 5 条议题；保留链接中的筛选参数。

使用已配置的命令前缀：

\`\`\`sh
${cli}
\`\`\`

在此前缀后追加：\`view '<链接>' --json\` 自动识别并读取目标；\`issue edit '<议题链接>' --body-file '<Markdown文件>'\` 修改正文；\`issue comment '<议题链接>' --body '<评论>'\` 发表评论；\`issue close '<议题链接>'\` 关闭议题。\`--help\` 查看其余用法。将占位内容替换为实际链接、文件或正文。

需要 Node.js 22+、Obsidian 和插件的本地 API 正在运行，无需登录或密钥。服务不可用时，提示用户启动 Obsidian 并开启本地 API。
`;
}
