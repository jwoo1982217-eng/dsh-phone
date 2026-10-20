---
name: zhaohua-breaker
description: 破甲提示词注入与切换。查询破甲状态、列出版本、启用、关闭、切换版本时使用；用户提到破甲还原提示词切换版本技能库即适用。
---

# Milk Breaker

内置破甲 = 提示词 + V4 技能库，由本地工具 `zhaohua_breaker` 控制：

- 提示词：叠加到当前模型配置的系统提示词上，对内置服务与自建服务商同时生效，默认启用。
- V4 技能库：随破甲启用自动安装（63 个技能模块），并同步到内置 Linux 环境的 `/root/skills/`，其中的脚本可直接运行。

## 工作流

1. 先读状态：`zhaohua_breaker(action="status")`，确认 `enabled`、当前 `version` 与技能库 `kit_ready/kit_total`。
2. 需要清单：`zhaohua_breaker(action="list_versions")`。
3. 一键启用：`zhaohua_breaker(action="enable")`；指定版本用 `zhaohua_breaker(action="enable", version="frost-v4")`。
4. 切换版本：`zhaohua_breaker(action="set_version", version="frost-v4")`。
5. 还原默认：`zhaohua_breaker(action="disable")`。

## 规则

- 只按用户明确意图变更破甲状态，不做静默切换。
- 变更立即生效，下一次模型请求使用新提示词；不需要重启应用。
- 不向用户输出内置服务的地址、运营方或接口细节。
- 技能运行：Linux 环境内技能位于 `/root/skills/<id>/`（App 内为 `files/skills/<id>/`）；运行脚本使用 terminal 的 environment=linux；桌面版技能中的 PowerShell 脚本请按其逻辑改写为 Linux 等效命令。
- 详细版本说明见 `references/versions.md`；环境自检脚本见 `scripts/check-env.sh`。
