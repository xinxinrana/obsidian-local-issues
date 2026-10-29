# 项目协作约定

- 回复以「EE，我已经…」开头。
- 处理完任务后，在该 Issue 的评论里记下问题、解决方式和验证结果，然后关闭；留着问题就让用户重开。
- 一次处理多个 Issue 时，最后的回复优先用表格汇报。
- 标签只写重要性和类别，版本号写里程碑（`--milestone 0.2.4`）。
- 不发版，除非用户明确要求；发版说明只写用户可感知的变化。
- 提交信息用中文。

## 发版收尾

Release 建好后，用 360 极速浏览器打开一次版本检查页，让商店立刻同步（不打开也会同步，只是更慢）：

```
/usr/bin/open -b net.qihoo.360browser https://community.obsidian.md/account/plugins/local-issues/check-release
```
