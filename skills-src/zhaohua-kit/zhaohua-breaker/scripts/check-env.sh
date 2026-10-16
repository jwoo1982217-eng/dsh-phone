#!/bin/sh
# Milk Breaker 环境自检：破甲提示词在 App 内，技能库同步到 Linux 环境 /root/skills。
set -u
echo "Milk Breaker 环境自检"
echo "- 破甲提示词：App 内置资产提供，必需依赖为 0"
if [ -d /root/skills ]; then
  n=$(ls /root/skills 2>/dev/null | wc -l | tr -d ' ')
  echo "- V4 技能库（Linux 环境）：/root/skills 可见，$n 个技能目录"
else
  echo "- V4 技能库（Linux 环境）：未挂载（请先在 App 中启用破甲，或重开终端会话）"
fi
for c in python3 node jq curl; do
  if command -v "$c" >/dev/null 2>&1; then
    echo "- $c: $(command -v "$c")"
  else
    echo "- $c: 未安装（可选，仅供扩展脚本任务）"
  fi
done
echo "结论：可直接使用 zhaohua_breaker 工具；技能脚本经 /root/skills/<id>/scripts/ 运行。"
