---
name: dsh-motion-deck
description: 当用户提供一段演示文稿主题、内容大纲或会议材料，希望生成结构完整、视觉突出、每页有动画的 HTML 演示文稿时使用；从新内容生成 8 页单文件 HTML，不生成 pptx，也不改写已有案例。
user-invocable: true
disable-model-invocation: false
---

# 从用户大纲生成 8 页 HTML 动效演示

用户提供的主题和大概内容是唯一事实来源。你的工作不是替用户重新选题，而是完成：**保真整理 → 8 页叙事 → 视觉模板 → 逐页动效 → 单文件 HTML → 插件验收**。

## 硬边界

- 每次新任务只写入 `generated/<project-slug>/`；若目录已存在，使用语义化后缀，不覆盖。
- 不读取、不复制、不修改案例根部的 `input/outline.json`、`output/index.html` 或旧 `decision.json`。
- 可以复用本 Skill 内置的四套模板、8 种动画配方和渲染 Plugin；不能复用示例演示中的 DeepSeek Harness 内容。
- 用户没有提供的数字、事实、案例和结论不得编造；材料不够支撑 8 页时，用章节页、结构图或总结页组织已有内容，不虚构新事实。
- 最终只生成 HTML，不生成、承诺或描述 `.pptx`。
- 不引入在线字体、外部脚本、批注、演讲者后台或复杂编辑器。

## 输入判断

以下输入足以直接开始，不再追问：

- 明确的演示主题；
- 3 个以上核心内容点，或一段能拆出 3 个以上要点的正文；
- 可以判断的大致受众或使用场景。

只有缺少演示主题或完全没有可拆分内容时，才使用 `ask_user_question` 一次补齐。用户未指定页数时固定 8 页；未指定视觉模板时按本 Skill 规则推荐默认模板。

## 第 1 阶段：保存原始材料并拆成 8 页

### 1.1 创建新项目

创建：

```text
generated/<project-slug>/
├── input/
│   ├── source.md
│   └── outline.json
└── output/
```

把用户输入原样保存到 `input/source.md`。这份文件是事实基线，后续每页内容都必须能在其中找到依据。

### 1.2 先写一句叙事主张

在 `outline.json` 中先确定：

- `deck.title`：演示标题；
- `deck.brand`：演示主体或组织名；
- `deck.eyebrow`：不超过 28 个字符的英文或中文短标签；
- `deck.cta`：最后一页行动主张；
- `deck.footer`：页脚署名；
- `deck.thesis`：观众看完后只需要记住的一句话。

如果一句话塞进两个以上主张，先收敛成一个主张，再用页面证明它。

### 1.3 使用 8 页叙事骨架

根据用户材料调整页面内容，但保持以下功能分工：

| 页码 | 页面任务 | 推荐内容形态 |
| --- | --- | --- |
| 01 | 建立主题与期待 | 标题、主张、3 个关键词 |
| 02 | 交代背景或前后反差 | Before/After、现状/目标 |
| 03 | 给出核心结构 | 三层模型、三项原则、三类对象 |
| 04 | 解释方法或过程 | 4～5 步流程、时间线、执行链 |
| 05 | 展开关键机制 | 关系图、能力网络、要素连接 |
| 06 | 呈现选择或策略 | 两种方案、三个决策、优先级 |
| 07 | 汇总证据或成果 | 3～5 个成果、案例、指标或结论 |
| 08 | 收束唯一主张 | 总结、行动建议、CTA |

不要机械套标题；页面任务可以依据材料调换，但必须形成“开场 → 展开 → 证明 → 收束”的完整弧线。

### 1.4 每页内容约束

`outline.slides` 必须恰好 8 项，每项包含：

```json
{
  "section": "01 · 背景",
  "title": "这一页只表达一个结论",
  "summary": "用一到两句话解释标题，不重复标题。",
  "points": ["要点一", "要点二", "要点三"]
}
```

规则：

- 标题建议不超过 24 个汉字；
- summary 不超过 80 个汉字；
- points 为 3～5 项，每项不超过 30 个汉字；
- 一页只服务一个结论；
- 连续两页不能只是相同的卡片列表；
- 事实、数字和专有名词必须忠于 `source.md`。

完整结构：

```json
{
  "deck": {
    "title": "演示标题",
    "brand": "主体名称",
    "eyebrow": "TOPIC · YEAR",
    "cta": "最后的行动主张",
    "footer": "主体 · 演示名称",
    "thesis": "观众最终只记住的一句话"
  },
  "slides": []
}
```

**阶段门禁：** `source.md` 与 `outline.json` 已新建；outline 恰好 8 页；每页至少 3 个要点；没有出现用户未提供的事实。

## 第 2 阶段：选择视觉模板和叙事重点

四套模板都内置在最终 HTML 中，用户可以在页面中按数字键 1～4 一键切换。Plugin 参数决定首次打开时的默认模板：

| id | 模板 | 适用内容 |
| --- | --- | --- |
| `ocean` | 深海指挥舱 | 科技发布、产品能力、系统架构；对比强、视觉冲击最大 |
| `airlab` | 晴空研究所 | 教学说明、创新项目、团队分享；清新、明亮、亲和 |
| `swiss` | 瑞士编辑 | 研究报告、方法论、专业知识；网格清晰、信息克制 |
| `gallery` | 午夜美术馆 | 品牌发布、管理层汇报、成果展示；高级、克制、舞台感 |

叙事重点使用兼容 id：

- `plugin`：方法结构；
- `human`：用户参与或决策；
- `result`：成果证据。

用户已指定风格时服从用户；否则根据受众、场景和内容密度选择一个默认模板，不需要额外询问。选择理由写入 `input/decision-note.md`，不超过三句话。

## 第 3 阶段：调用 DSH Plugin 生成新 HTML

完成新大纲后必须调用：

```text
render_motion_deck(
  project_dir: "generated/<project-slug>",
  theme: "ocean | airlab | swiss | gallery",
  focus: "plugin | human | result"
)
```

Plugin 会读取本次生成的 `input/outline.json`，把内容装入内置四模板和 8 个独立动画配方，生成：

```text
generated/<project-slug>/input/decision.json
generated/<project-slug>/output/index.html
```

8 页动画语义固定，但内容来自新大纲：

1. `title-bridge`：标题分层与核心连接；
2. `split-contract`：左右对比；
3. `orbit-assembly`：三层结构聚合；
4. `pipeline-run`：流程轨迹依次运行；
5. `constellation-bind`：关系线描绘与节点汇聚；
6. `decision-flip`：决策分支与预览翻转；
7. `fan-results`：成果卡片扇形展开；
8. `converge-mark`：要点汇聚到最终主张。

不得用 Bash 或文件复制冒充 `render_motion_deck` 调用。

## 第 4 阶段：插件复验并交付

生成后必须调用：

```text
inspect_motion_deck(project_dir: "generated/<project-slug>")
```

检查项包括：

- 新大纲的 8 个标题全部进入 HTML；
- 8 页结构完整；
- 8 个动画配方互不重复；
- 四套模板仍可切换；
- 默认模板和叙事重点生效；
- reduced-motion 下静态可读；
- 无外部字体、脚本和样式；
- 内联 JavaScript 语法通过。

最终报告：新项目目录、默认模板、叙事重点、8/8 动画、检查结果和 `output/index.html` 路径。不要把案例根部的 `output/index.html` 当成本次成果。

## 测试成功的工具轨迹

1. `skill` 加载 `dsh-motion-deck`；
2. DSH 文件工具写入新 `source.md` 和 `outline.json`；
3. `render_motion_deck` 接收新项目目录并生成新 HTML；
4. `inspect_motion_deck` 验收同一个新项目；
5. 成果位于 `generated/<project-slug>/output/index.html`。

只切换案例根部旧 HTML 的主题不算通过。
