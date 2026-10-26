#!/usr/bin/env node
/*!
MIT License

Copyright (c) 2026 Evan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

*/

// src/routes.ts
function parseResource(url) {
  const p = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (p[0] !== "repos") return void 0;
  if (!p[1] || url.username || url.password || url.hash) throw new Error("\u4ED3\u5E93\u94FE\u63A5\u683C\u5F0F\u4E0D\u6B63\u786E\u3002");
  if (p.length === 2) return { kind: "repo", repo: p[1], suffix: [] };
  if (p[2] !== "projects" || !p[3]) throw new Error("\u9879\u76EE\u94FE\u63A5\u683C\u5F0F\u4E0D\u6B63\u786E\u3002");
  if (p.length === 4) return { kind: "project", repo: p[1], project: p[3], suffix: [] };
  if (p[4] !== "issues") throw new Error("\u8BAE\u9898\u94FE\u63A5\u683C\u5F0F\u4E0D\u6B63\u786E\u3002");
  if (p.length === 5) return { kind: "issues", repo: p[1], project: p[3], suffix: [] };
  if (!/^[1-9]\d*$/.test(p[5]) || !Number.isSafeInteger(Number(p[5]))) throw new Error("\u8BAE\u9898\u7F16\u53F7\u5FC5\u987B\u662F\u6B63\u6574\u6570\u3002");
  return { kind: "issue", repo: p[1], project: p[3], number: Number(p[5]), suffix: p.slice(6) };
}

// src/cli.ts
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
var HELP = `Local Issues \xB7 Obsidian \u672C\u5730\u9879\u76EE\u4E0E Issues

\u7528\u6CD5: li <\u547D\u4EE4> [\u53C2\u6570] [\u9009\u9879]

  view <\u8BED\u4E49\u5316URL>
  repo view <\u4ED3\u5E93URL> | link
  project list | view <\u9879\u76EE> | create | edit <\u9879\u76EE> | share <\u9879\u76EE>
  issue list | view <\u7F16\u53F7/\u53CC\u94FE/ID/\u5206\u4EABURL> | create | edit <\u5F15\u7528>
  issue comment <\u5F15\u7528> | close <\u5F15\u7528> | reopen <\u5F15\u7528>
  issue attach <\u5F15\u7528> <\u6587\u4EF6> | share <\u5F15\u7528>
  comment edit <\u8BC4\u8BBAID> --body "\u5185\u5BB9"
  share view <\u5206\u4EABURL> | edit <\u5206\u4EABURL> | comment <\u5206\u4EABURL>
  share comment-edit <\u5206\u4EABURL> <\u8BC4\u8BBAID> --body "\u5185\u5BB9"
  resolve '[[\u7B14\u8BB0\u6216Issue]]'
  api <\u63A5\u53E3\u8DEF\u5F84> [-X METHOD] [-f key=value]

\u5E38\u7528\u9009\u9879:
  -c, --comments            \u663E\u793A\u8BC4\u8BBA\u4E0E\u72B6\u6001\u65F6\u95F4\u7EBF
  -P, --project <\u540D\u79F0/ID>    \u6307\u5B9A\u9879\u76EE\uFF08Issue \u7F16\u53F7\u5728\u9879\u76EE\u5185\u552F\u4E00\uFF09
  -t, --title <\u6807\u9898>        \u9879\u76EE\u6216 Issue \u6807\u9898
  -b, --body <Markdown>     \u63CF\u8FF0\u6216\u8BC4\u8BBA\u5185\u5BB9
  -F, --body-file <\u6587\u4EF6>    \u4ECE\u6587\u4EF6\u8BFB\u6B63\u6587\uFF1B\u7528 - \u4ECE\u6807\u51C6\u8F93\u5165\u8BFB\u53D6
  -s, --state <\u72B6\u6001>        open / in-progress / closed / all
  -l, --label <\u6807\u7B7E>        \u53EF\u591A\u6B21\u4F7F\u7528\uFF0C\u6216\u7528\u9017\u53F7\u5206\u9694
  -a, --assignee <\u540D\u5B57>     \u53EF\u591A\u6B21\u4F7F\u7528
      --milestone <\u540D\u79F0>   \u91CC\u7A0B\u7891
      --parent <Issue>     \u7236\u8BAE\u9898\uFF1B\u7A7A\u5B57\u7B26\u4E32\u53EF\u6E05\u9664
      --depends-on <Issue> \u4F9D\u8D56\uFF1B\u53EF\u591A\u6B21\u4F7F\u7528
      --due-date YYYY-MM-DD
      --author <\u540D\u5B57>      \u8BC4\u8BBA\u6216\u521B\u5EFA\u8005\uFF0C\u9ED8\u8BA4 Agent
  -S, --search <\u5173\u952E\u8BCD>    \u641C\u7D22\u6807\u9898\u3001\u6B63\u6587\u3001\u6807\u7B7E
  -L, --limit <\u6570\u91CF>       \u5217\u8868\u4E0A\u9650\uFF0C\u9ED8\u8BA4 30
      --json [\u5B57\u6BB5,\u5B57\u6BB5]   \u8F93\u51FA JSON\uFF0C\u7701\u7565\u5B57\u6BB5\u8F93\u51FA\u5B8C\u6574\u5BF9\u8C61
      --web                \u5728 Obsidian \u4E2D\u6253\u5F00
      --vault <\u7B14\u8BB0\u5E93\u8DEF\u5F84> \u4F7F\u7528\u8BE5\u7B14\u8BB0\u5E93\u7684\u672C\u5730 API \u8BBE\u7F6E
      --if-match <\u65F6\u95F4>    \u4EC5\u5F53 updatedAt \u5339\u914D\u65F6\u4FEE\u6539\uFF0C\u9632\u6B62\u8986\u76D6

\u793A\u4F8B:
  li project create -t "\u6211\u7684\u9879\u76EE"
  li issue create -P "\u6211\u7684\u9879\u76EE" -t "\u652F\u6301\u56FE\u7247" -b "\u8BF4\u660E [[\u8BBE\u8BA1\u7A3F]]"
  li issue comment 1 -P "\u6211\u7684\u9879\u76EE" -F comment.md
  li issue list -P "\u6211\u7684\u9879\u76EE" --state all --json number,title,status
  li issue attach 1 -P "\u6211\u7684\u9879\u76EE" screenshot.png
  li issue share '[[Local Issues/\u9879\u76EE/issues/0001]]'

\u9700\u8981\u5728 Obsidian \u4E2D\u542F\u7528 Local Issues \u548C\u672C\u5730 API\u3002API \u53EA\u76D1\u542C\u672C\u673A\u3002
\u8BED\u4E49\u5316\u94FE\u63A5\u4EC5\u5B9A\u4F4D\u8D44\u6E90\uFF0C\u65E0\u9700\u767B\u5F55\u6216\u5BC6\u94A5\uFF1B\u65E7\u5206\u4EAB\u94FE\u63A5\u7EE7\u7EED\u517C\u5BB9\u3002`;
var aliases = { c: "comments", P: "project", t: "title", b: "body", F: "body-file", l: "label", a: "assignee", s: "state", S: "search", L: "limit", h: "help", X: "method", f: "field", H: "header" };
var booleans = /* @__PURE__ */ new Set(["help", "web", "comment", "comments"]);
var multiples = /* @__PURE__ */ new Set(["label", "assignee", "depends-on", "add-label", "remove-label", "field", "header"]);
var allowed = /* @__PURE__ */ new Set(["project", "title", "body", "body-file", "state", "status", "label", "assignee", "milestone", "parent", "depends-on", "due-date", "author", "search", "limit", "json", "web", "vault", "url", "if-match", "help", "method", "field", "header", "comment", "add-label", "remove-label", "description", "comments"]);
function parse(argv) {
  const args = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      args.push(arg);
      continue;
    }
    const match = /^--?([^=]+)(?:=(.*))?$/.exec(arg);
    const key = aliases[match[1]] ?? match[1];
    if (!allowed.has(key)) throw new Error(`\u672A\u77E5\u9009\u9879 ${arg}\uFF1B\u8FD0\u884C li --help \u67E5\u770B\u7528\u6CD5\u3002`);
    let value = match[2] ?? true;
    if (key === "json") {
      if (match[2] === void 0 && argv[i + 1] && /^[A-Za-z][\w]*(?:,[A-Za-z][\w]*)*$/.test(argv[i + 1]) && i >= 2) value = argv[++i];
    } else if (!booleans.has(key) && match[2] === void 0) {
      if (argv[i + 1] === void 0 || argv[i + 1].startsWith("--") && argv[i + 1] !== "-") throw new Error(`${arg} \u7F3A\u5C11\u53C2\u6570\u3002`);
      value = argv[++i];
    }
    if (multiples.has(key)) {
      const old = Array.isArray(flags[key]) ? flags[key] : [];
      flags[key] = [...old, String(value)];
    } else flags[key] = value;
  }
  return { args, flags };
}
var val = (f, key) => typeof f[key] === "string" ? f[key] : void 0;
function list(f, key) {
  if (f[key] === void 0) return void 0;
  return (Array.isArray(f[key]) ? f[key] : [String(f[key])]).flatMap((x) => key === "field" || key === "header" ? [x] : x.split(",")).map((x) => x.trim()).filter(Boolean);
}
function required(value, label) {
  if (!value) throw new Error(`\u8BF7\u63D0\u4F9B${label}\u3002`);
  return value;
}
function body(f) {
  const file = val(f, "body-file");
  if (file !== void 0) return readFileSync(file === "-" ? 0 : resolve(file), "utf8");
  return val(f, "body") ?? val(f, "description");
}
function findVault(explicit) {
  if (explicit) return resolve(explicit);
  const installed = dirname(realpathSync(resolve(process.argv[1])));
  if (basename(installed) === "local-issues" && basename(dirname(installed)) === "plugins" && basename(dirname(dirname(installed))) === ".obsidian") return dirname(dirname(dirname(installed)));
  let dir = process.cwd();
  while (true) {
    if (existsSync(resolve(dir, ".obsidian"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return void 0;
}
function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("\u4EC5\u652F\u6301 http://127.0.0.1 \u7684\u672C\u673A\u63A5\u53E3\u4E0E\u5206\u4EAB\u94FE\u63A5\u3002");
  return url;
}
function client(f, shared, resource) {
  let base = val(f, "url") ?? (process.env.LOCAL_ISSUES_URL || void 0);
  const vault = findVault(val(f, "vault") ?? process.env.LOCAL_ISSUES_VAULT);
  if (!shared && vault) {
    const file = resolve(vault, ".obsidian/plugins/local-issues/data.json");
    if (existsSync(file)) {
      const config = JSON.parse(readFileSync(file, "utf8"));
      base ??= `http://127.0.0.1:${config.apiPort ?? config.port ?? 27183}`;
    }
  }
  base ??= resource?.origin;
  const baseUrl = shared ?? localUrl(base ?? "http://127.0.0.1:27183");
  const headers = { "Content-Type": "application/json" };
  const match = val(f, "if-match");
  if (match) headers["If-Match"] = match;
  for (const header of list(f, "header") ?? []) {
    const colon = header.indexOf(":");
    if (colon <= 0) throw new Error("-H \u683C\u5F0F\u4E3A Name: value");
    headers[header.slice(0, colon)] = header.slice(colon + 1).trim();
  }
  return { async request(path, method = "GET", value) {
    const url = new URL(path, baseUrl);
    if (url.origin !== baseUrl.origin) throw new Error("\u63A5\u53E3\u5730\u5740\u5FC5\u987B\u4FDD\u6301\u540C\u4E00\u672C\u673A\u670D\u52A1\u3002");
    let response;
    try {
      response = await fetch(url, { method, headers, body: value === void 0 ? void 0 : JSON.stringify(value), signal: AbortSignal.timeout(3e4) });
    } catch (error) {
      throw new Error(`\u65E0\u6CD5\u8FDE\u63A5 Local Issues\u3002\u8BF7\u786E\u8BA4 Obsidian \u548C\u672C\u5730 API \u5DF2\u542F\u52A8\u3002${error instanceof Error && error.name === "TimeoutError" ? "\u8BF7\u6C42\u8D85\u65F6\u3002" : ""}`);
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`\u63A5\u53E3\u8FD4\u56DE\u4E86\u975E JSON \u5185\u5BB9\uFF08${response.status}\uFF09\u3002`);
    }
    if (!response.ok || !payload.ok) throw new Error(`${payload.error?.code ?? response.status}: ${payload.error?.message ?? "\u64CD\u4F5C\u5931\u8D25"}`);
    return payload.data;
  } };
}
function print(data, flags, kind) {
  if (flags.json !== void 0) {
    const fields = typeof flags.json === "string" ? flags.json.split(",") : null;
    const select = (item) => fields && item && typeof item === "object" ? Object.fromEntries(fields.map((k) => [k, item[k]])) : item;
    console.log(JSON.stringify(Array.isArray(data) ? data.map(select) : select(data), null, 2));
    return;
  }
  if (typeof data === "string") {
    console.log(data);
    return;
  }
  if (Array.isArray(data)) {
    if (!data.length) {
      console.log("\u6CA1\u6709\u5339\u914D\u7684\u6761\u76EE\u3002");
      return;
    }
    for (const item of data) console.log(kind === "project" ? `${item.title}	${item.status}	${item.closedCount ?? 0}/${item.issueCount ?? 0}	${item.id}` : `#${item.number}	${item.status}	${item.title}	${(item.labels ?? []).join(", ")}`);
    return;
  }
  if (data?.url) {
    console.log(data.url);
    return;
  }
  if (data?.markdown) {
    console.log(data.markdown);
    return;
  }
  if (data?.issue) {
    console.log(`#${data.issue.number} ${data.issue.title}
${data.issue.status} \xB7 ${data.issue.id}

${data.issue.body}`);
    for (const entry of flags.comments ? data.timeline ?? [] : []) console.log(`
---
${entry.author} \xB7 ${entry.createdAt} \xB7 ${entry.id}
${entry.kind === "event" ? `${entry.from} \u2192 ${entry.to}` : entry.body}`);
    return;
  }
  if (data?.project) {
    console.log(`${data.project.title}
${data.project.description}
`);
    print(data.issues ?? [], {}, "issue");
    return;
  }
  if (data?.title) {
    console.log(`${data.number ? `#${data.number} ` : ""}${data.title}
${data.path ?? data.id}`);
    return;
  }
  if (data?.body !== void 0) {
    console.log(`${data.id ? `${data.id}
` : ""}${data.body}`);
    return;
  }
  console.log(JSON.stringify(data, null, 2));
}
function issuePatch(f) {
  const result = {};
  const scalar = { title: "title", status: "status", milestone: "milestone", parent: "parent", "due-date": "dueDate", author: "author" };
  for (const [flag, field] of Object.entries(scalar)) if (val(f, flag) !== void 0) result[field] = val(f, flag);
  if (val(f, "state") !== void 0) result.status = val(f, "state");
  const content = body(f);
  if (content !== void 0) result.body = content;
  for (const [flag, field] of [["label", "labels"], ["assignee", "assignees"], ["depends-on", "dependencies"]]) if (list(f, flag) !== void 0) result[field] = list(f, flag);
  return result;
}
async function main() {
  const { args, flags } = parse(process.argv.slice(2));
  if (flags.help || !args.length || args[0] === "help") {
    console.log(HELP);
    return;
  }
  let [command, action, ref, extra] = args;
  if (command === "view" || command === "resolve" && action?.startsWith("http://")) {
    ref = action;
    action = "view";
  }
  const resourceUrl = ref?.startsWith("http://") ? localUrl(ref) : void 0;
  const resource = resourceUrl ? parseResource(resourceUrl) : void 0;
  if (resource) {
    if (resource.suffix.length) throw new Error("\u8BF7\u4F7F\u7528\u4ED3\u5E93\u3001\u9879\u76EE\u3001Issues \u5217\u8868\u6216\u8BAE\u9898\u94FE\u63A5\u3002");
    if (command === "view" || command === "resolve" || command === "share") {
      command = resource.kind === "repo" ? "repo" : resource.kind === "project" ? "project" : "issue";
      if (resource.kind === "issues" && action === "view") action = "list";
    }
    const expected = resource.kind === "repo" ? "repo" : resource.kind === "project" ? "project" : "issue";
    if (command !== expected || (resource.kind === "issues" ? action !== "list" : action === "list" || action === "create")) throw new Error("\u547D\u4EE4\u4E0E\u94FE\u63A5\u76EE\u6807\u4E0D\u5339\u914D\uFF1B\u4F7F\u7528 li view <\u94FE\u63A5> \u81EA\u52A8\u8BC6\u522B\u76EE\u6807\u3002");
  }
  let shared;
  const maybe = ["share", "issue", "project"].includes(command) ? ref : void 0;
  if (!resource && maybe?.startsWith("http://")) {
    const parsed = localUrl(maybe);
    if (/^\/api\/shares\/[^/]+\/resolve$/.test(parsed.pathname)) shared = parsed;
    else throw new Error("\u8BF7\u63D0\u4F9B\u5B8C\u6574\u7684\u5206\u4EAB\u94FE\u63A5\u3002");
  }
  const api = client(flags, shared, resource ? resourceUrl : void 0);
  const project = val(flags, "project");
  const issuePath = (value) => resourceUrl && resource ? resourceUrl.toString() : `/api/issues/${encodeURIComponent(value)}${project ? `?project=${encodeURIComponent(project)}` : ""}`;
  const subPath = (value, suffix) => {
    if (resourceUrl && resource) {
      const url = new URL(resourceUrl);
      url.pathname += `/${suffix}`;
      return url.toString();
    }
    return `/api/issues/${encodeURIComponent(value)}/${suffix}${project ? `?project=${encodeURIComponent(project)}` : ""}`;
  };
  let data;
  if (shared) {
    const url = new URL(shared);
    if (flags.web) throw new Error("\u5206\u4EAB\u5F15\u7528\u901A\u8FC7 CLI \u8BBF\u95EE\uFF1B--web \u4EC5\u7528\u4E8E\u672C\u5730\u7F16\u53F7\u6216 ID\u3002");
    if (action === "view" || action === "get") data = await api.request(url.pathname + url.search);
    else if (action === "edit") {
      const current = await api.request(url.pathname + url.search), patch = issuePatch(flags);
      if (current.kind === "issue" && (flags["add-label"] || flags["remove-label"])) {
        patch.labels = [.../* @__PURE__ */ new Set([...patch.labels ?? current.issue.labels, ...list(flags, "add-label") ?? []])].filter((x) => !(list(flags, "remove-label") ?? []).includes(x));
        if (!val(flags, "if-match")) patch.expectedUpdatedAt = current.issue.revision ?? current.issue.updatedAt;
      }
      if (current.kind === "project" && patch.body !== void 0) {
        patch.description = patch.body;
        delete patch.body;
      }
      if (current.kind === "issue") {
        patch.actor = val(flags, "author") ?? "Agent";
        delete patch.author;
      }
      data = await api.request(url.pathname + url.search, "PATCH", patch);
    } else if (action === "close" || action === "reopen") data = await api.request(url.pathname + url.search, "PATCH", { status: action === "close" ? "closed" : "open", actor: val(flags, "author") ?? "Agent" });
    else if (action === "comment") {
      url.pathname = url.pathname.replace(/\/resolve$/, "/comments");
      data = await api.request(url.pathname + url.search, "POST", { body: required(body(flags), "\u8BC4\u8BBA\u6B63\u6587\uFF08--body \u6216 --body-file\uFF09"), author: val(flags, "author") ?? "Agent" });
    } else if (action === "comment-edit") {
      url.pathname = url.pathname.replace(/\/resolve$/, `/comments/${encodeURIComponent(required(extra, "\u8BC4\u8BBAID"))}`);
      data = await api.request(url.pathname + url.search, "PATCH", { body: required(body(flags), "\u8BC4\u8BBA\u6B63\u6587\uFF08--body \u6216 --body-file\uFF09") });
    } else throw new Error("\u5206\u4EAB\u94FE\u63A5\u652F\u6301 view\u3001edit\u3001comment\u3001comment-edit\u3001close\u3001reopen\u3002");
  } else if (command === "repo") {
    if (action === "view" && resourceUrl && resource?.kind === "repo") data = await api.request(resourceUrl.toString());
    else if (action === "link") data = await api.request("/api/links");
    else throw new Error("\u7528\u6CD5\uFF1Ali repo view <\u4ED3\u5E93URL> \u6216 li repo link");
  } else if (command === "project") {
    if (action === "list") {
      const query = new URLSearchParams();
      if (val(flags, "state")) query.set("state", val(flags, "state"));
      if (val(flags, "search")) query.set("search", val(flags, "search"));
      data = await api.request(`/api/projects?${query}`);
    } else if (action === "view") data = await api.request(resourceUrl && resource ? resourceUrl.toString() : `/api/projects/${encodeURIComponent(required(ref, "\u9879\u76EE"))}`);
    else if (action === "create" || action === "edit") {
      const value = {};
      if (val(flags, "title") !== void 0) value.title = val(flags, "title");
      const content = body(flags);
      if (content !== void 0) value.description = content;
      if (val(flags, "state") ?? val(flags, "status")) value.status = val(flags, "state") ?? val(flags, "status");
      if (val(flags, "due-date") !== void 0) value.dueDate = val(flags, "due-date");
      if (action === "create") required(value.title, "\u6807\u9898\uFF08--title\uFF09");
      data = await api.request(action === "create" ? "/api/projects" : resourceUrl && resource ? resourceUrl.toString() : `/api/projects/${encodeURIComponent(required(ref, "\u9879\u76EE"))}`, action === "create" ? "POST" : "PATCH", value);
    } else if (action === "share") data = resourceUrl && resource ? { url: resourceUrl.toString() } : await api.request(`/api/links?ref=${encodeURIComponent(required(ref, "\u9879\u76EE"))}`);
    else throw new Error("\u672A\u77E5\u9879\u76EE\u547D\u4EE4\u3002\u8FD0\u884C li --help \u67E5\u770B\u7528\u6CD5\u3002");
  } else if (command === "issue") {
    if (action === "list") {
      const query = new URLSearchParams(resourceUrl && resource ? resourceUrl.search : "");
      query.set("state", val(flags, "state") ?? val(flags, "status") ?? query.get("state") ?? (resource ? "all" : "open"));
      query.set("limit", val(flags, "limit") ?? query.get("limit") ?? "30");
      if (project) query.set("project", project);
      for (const key of ["search", "milestone"]) if (val(flags, key) !== void 0) query.set(key, val(flags, key));
      for (const label of list(flags, "label") ?? []) query.append("label", label);
      for (const name of list(flags, "assignee") ?? []) query.append("assignee", name);
      data = await api.request(resourceUrl && resource ? `${resourceUrl.origin}${resourceUrl.pathname}?${query}` : `/api/issues?${query}`);
    } else if (action === "view") data = await api.request(issuePath(required(ref, "Issue \u5F15\u7528")));
    else if (action === "create") data = await api.request("/api/issues", "POST", { ...issuePatch(flags), title: required(val(flags, "title"), "\u6807\u9898\uFF08--title\uFF09"), project: required(project, "\u9879\u76EE\uFF08--project\uFF09"), author: val(flags, "author") ?? "Agent" });
    else if (action === "edit") {
      const patch = issuePatch(flags);
      patch.actor = val(flags, "author") ?? "Agent";
      delete patch.author;
      if (flags["add-label"] || flags["remove-label"]) {
        const current = (await api.request(issuePath(required(ref, "Issue \u5F15\u7528")))).issue;
        patch.labels = [.../* @__PURE__ */ new Set([...patch.labels ?? current.labels, ...list(flags, "add-label") ?? []])].filter((x) => !(list(flags, "remove-label") ?? []).includes(x));
        if (!val(flags, "if-match")) patch.expectedUpdatedAt = current.revision ?? current.updatedAt;
      }
      data = await api.request(issuePath(required(ref, "Issue \u5F15\u7528")), "PATCH", patch);
    } else if (action === "comment") data = await api.request(subPath(required(ref, "Issue \u5F15\u7528"), "comments"), "POST", { body: required(body(flags), "\u8BC4\u8BBA\u6B63\u6587\uFF08--body \u6216 --body-file\uFF09"), author: val(flags, "author") ?? "Agent" });
    else if (action === "close" || action === "reopen") data = await api.request(subPath(required(ref, "Issue \u5F15\u7528"), action), "POST", { actor: val(flags, "author") ?? "Agent" });
    else if (action === "attach") {
      const file = resolve(required(extra, "\u9644\u4EF6\u6587\u4EF6"));
      const attachment = await api.request(subPath(required(ref, "Issue \u5F15\u7528"), "attachments"), "POST", { name: basename(file), base64: readFileSync(file).toString("base64") });
      await api.request(subPath(ref, "comments"), "POST", { body: [body(flags), attachment.markdown].filter(Boolean).join("\n\n"), author: val(flags, "author") ?? "Agent" });
      data = attachment;
    } else if (action === "share") {
      const current = await api.request(issuePath(required(ref, "Issue \u5F15\u7528")));
      data = await api.request(`/api/links?ref=${encodeURIComponent(current.issue.id)}`);
    } else throw new Error("\u672A\u77E5 Issue \u547D\u4EE4\u3002\u8FD0\u884C li --help \u67E5\u770B\u7528\u6CD5\u3002");
  } else if (command === "comment" && action === "edit") data = await api.request(`/api/comments/${encodeURIComponent(required(ref, "\u8BC4\u8BBA ID"))}`, "PATCH", { body: required(body(flags), "\u8BC4\u8BBA\u6B63\u6587\uFF08--body \u6216 --body-file\uFF09") });
  else if (command === "resolve") data = await api.request(`/api/resolve?ref=${encodeURIComponent(required(action, "\u53CC\u94FE\u6216\u5F15\u7528"))}`);
  else if (command === "api") {
    const fields = {};
    for (const field of list(flags, "field") ?? []) {
      const equal = field.indexOf("=");
      if (equal <= 0) throw new Error("-f \u683C\u5F0F\u4E3A key=value");
      const value = field.slice(equal + 1);
      try {
        fields[field.slice(0, equal)] = JSON.parse(value);
      } catch {
        fields[field.slice(0, equal)] = value;
      }
    }
    let path = required(action, "\u63A5\u53E3\u8DEF\u5F84");
    if (!path.startsWith("/api/")) path = `/api/${path.replace(/^\//, "")}`;
    const method = (val(flags, "method") ?? (Object.keys(fields).length ? "POST" : "GET")).toUpperCase();
    data = await api.request(path, method, method === "GET" ? void 0 : fields);
  } else throw new Error("\u672A\u77E5\u547D\u4EE4\u3002\u8FD0\u884C li --help \u67E5\u770B\u7528\u6CD5\u3002");
  if (flags.web && !shared) {
    const target = data?.kind === "repo" ? void 0 : data?.issue?.id ?? data?.project?.id ?? data?.id ?? ref;
    if (target) await api.request("/api/open", "POST", { ref: target });
  }
  if (flags.json !== void 0 && data?.issue) data = { ...data.issue, project: data.project, comments: data.comments, timeline: data.timeline, subIssues: data.subIssues, dependencies: data.dependencies };
  else if (flags.json !== void 0 && data?.project) data = { ...data.project, issues: data.issues };
  print(data, flags, command);
}
void main().catch((error) => {
  console.error(`li: ${error instanceof Error ? error.message : "\u64CD\u4F5C\u5931\u8D25"}`);
  process.exitCode = 1;
});
