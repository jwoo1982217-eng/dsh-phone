---
name: to-spec
description: 把已经讨论清楚的产品需求综合为本地可追踪规格，不重新访谈用户，也不依赖外部 Issue 系统。
user-invocable: true
disable-model-invocation: false
---

# 从讨论生成规格

本 Skill 改造自 `mattpocock/skills` 的 `to-spec`，固定上游提交为 `068b6e0c62393147daf03530149cdce209c93da8`。本版本适配 DeepSeek Harness 文件工具，并把外部 Issue Tracker 改成课程可直接领取的本地 Markdown 规格。许可证见 `LICENSE.txt`。

## 前提

当前对话已经完成需求讨论或 `grill-me` 共同理解确认。不要重新进行产品访谈；只综合已有事实。若存在会改变成果形态的关键缺口，列出缺口并停止，不要自行猜测。

## 流程

1. 读取仓库约束、`CONTEXT.md`、相关 ADR、现有源码和测试，使用项目已有领域语言。
2. 找到最高层、最接近用户行为的测试 seam。优先复用现有浏览器、CLI 或公开 API seam，数量越少越好。
3. 用一句话向用户确认 seam；已经在当前对话明确确认时不得重复询问。
4. 从对话提取一个 kebab-case 功能标识 `<slug>`。
5. 使用文件工具写入 `.scratch/<slug>/spec.md`。目录不存在时创建，不连接 GitHub、GitLab、Linear 或其他账号。
6. 规格完成后把 frontmatter `status` 设为 `ready-for-agent`，并报告文件路径和唯一测试 seam。

## 规格结构

```markdown
---
title: <中文标题>
status: ready-for-agent
test_seam: <公开测试边界>
---

# <标题>产品规格

## Problem Statement
## Solution
## User Stories
## Implementation Decisions
## Testing Decisions
## Out of Scope
## Further Notes
```

要求：

- User Stories 使用长编号列表，覆盖正常路径、失败反馈、可访问性和领取用户体验。
- Implementation Decisions 记录已经作出的技术与交互决定，不粘贴完整实现代码。
- Testing Decisions 明确外部行为、独立期望值、已有测试先例和唯一 seam。
- Out of Scope 写清不做的内容，防止开发阶段扩张。
- 不把尚未执行的构建、测试或 DeepSeek Harness 工具调用写成已通过。

## 完成条件

- 规格只来自已确认讨论、仓库事实和工具核验。
- 测试 seam 明确，后续 TDD 可直接读取字面量。
- 本地规格真实写入磁盘，状态为 `ready-for-agent`。
