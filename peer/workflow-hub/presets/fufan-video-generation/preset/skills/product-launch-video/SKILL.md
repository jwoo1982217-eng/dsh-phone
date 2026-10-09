---
name: product-launch-video
description: 当用户用一句话要求生成产品发布片、功能预告片、应用宣传片或网站展示视频时使用；从空白目录自动生成简报、设计规范、分镜、HyperFrames 源码和经过验收的 MP4，而不是重渲染仓库内已有案例。
user-invocable: true
disable-model-invocation: false
---

# 一句话生成产品发布视频

把用户的一句话视为**唯一原始输入**。第一步必须调用 DSH `web_search` 获取足够信息；`RESEARCH.md`、`BRIEF.md`、`frame.md`、`STORYBOARD.md`、`compositions/`、`index.html` 和 MP4 都是本次会话生成的项目源码或成果，绝不能要求用户预先提供。

本 Skill 移植自 HyperFrames `product-launch-video` 的完整产品视频工作流，并针对 DeepSeek Harness 做了三项简化：默认自动执行、首版默认无配音、由 DSH 文件与 Shell 工具直接完成构建。上游完整流程、参考和脚本保存在 [`upstream/`](upstream/UPSTREAM-SKILL.md)，固定版本与许可见 [`upstream/LICENSE`](upstream/LICENSE)。

## 不可违反的生成边界

- 新任务只写入调用目录下全新的 `generated/<project-slug>/`。
- 不读取、不复制、不改写调用目录根部已有的 `BRIEF.md`、`STORYBOARD.md`、`frame.md`、`compositions/`、`assets/screens/` 或 `output/`。
- 若目标目录已存在，使用语义化后缀，例如 `<project-slug>-v2`；不得覆盖。
- 固定使用桌面端已检测并安装的 `hyperframes@0.7.109`，不得自行升级、登录、云发布或安装在线 Skill。
- 用户给出的品牌、产品、卖点和视觉要求必须进入新项目；不得把 DeepSeek Harness 示例文案带进其他主题。
- 用户一句话已包含主题时直接执行。只有连“做什么产品的视频”都无法判断时，才使用 `ask_user_question` 问一次。

## 一句话的默认补全

用户没有明确说明时，使用以下默认值并写入 `BRIEF.md` 的“推断项”，不要逐项追问：

| 字段 | 默认值 |
| --- | --- |
| 意图 | 产品宣传，而不是操作录屏 |
| 时长 | 10 秒 |
| 画幅 | 16:9，1920×1080 |
| 帧率 | 30fps |
| 音频 | 无配音、无音乐，`music: none` |
| 流程 | `automation`，不暂停等分镜批准 |
| 叙事 | 钩子 → 机制 → 证据 → 品牌收束 |
| 输出 | `renders/<project-slug>.mp4` |

## 完整执行流程

必须按顺序执行并通过每一步门禁。详细的故事、镜头与转场方法分别读取：

- [`upstream/references/story-design.md`](upstream/references/story-design.md)
- [`upstream/references/visual-design.md`](upstream/references/visual-design.md)
- [`upstream/references/motion-language.md`](upstream/references/motion-language.md)
- [`upstream/references/cut-catalog.md`](upstream/references/cut-catalog.md)
- [`references/artifact-contract.md`](references/artifact-contract.md)

### 0. 先检索，暂不写视频

在初始化工程、编写简报或设计画面之前，必须真实调用 DSH `web_search`。至少完成四个不同维度的查询：

1. **产品事实：** 产品/品牌官方定位、核心能力、准确名称与官网；
2. **用户问题：** 目标受众、具体痛点、使用情境和可量化变化；
3. **同类表达：** 同类产品通常强调什么，避免生成空泛卖点；
4. **视觉线索：** 官方品牌颜色、界面、Logo、媒体资料或可合法引用的视觉来源。

每个查询必须使用不同关键词。合并去重后至少保留 8 个有效 URL，其中必须有产品官方来源，并尽量包含至少 2 个独立可信来源。搜索结果不足时继续补查，不得用模型记忆补齐虚构事实。

检索阶段先在会话中整理结果，不读取案例根部旧文件，也不开始写 HTML。输出应能回答：产品是什么、为谁解决什么、最值得拍的一个变化是什么、哪些视觉事实可用、哪些说法没有证据所以不用。

**门禁：** 工具轨迹中至少出现 4 次成功的 `web_search`；收集到至少 8 个去重来源和一个官方来源。未达到时不得进入工程初始化。

### 1. 创建全新工程并固化 RESEARCH.md

从用户内容提取短的 kebab-case 项目名，在调用目录执行：

```bash
hyperframes init "generated/<project-slug>" \
  --non-interactive \
  --example=blank \
  --resolution=landscape \
  --skill=product-launch-video
```

进入新目录后执行后续命令。初始化之前目录必须不存在；初始化之后先写 `RESEARCH.md`，再写 `BRIEF.md`。`RESEARCH.md` 必须记录四个查询、来源 URL、可信事实、对应的视频用途以及被舍弃的无证据说法，格式见 `references/artifact-contract.md`。若案例包中存在 `.agents/skills/product-launch-video/assets/gsap.min.js`，复制到新项目 `assets/vendor/gsap.min.js`，生成的 HTML 只引用这个本地脚本。

**门禁：** 新目录、`hyperframes.json`、`package.json` 和 `RESEARCH.md` 存在；研究文件至少含 8 个去重来源；目录内尚未出现旧案例内容。

### 2. 生成 BRIEF 与素材事实包

读取本次生成的 `RESEARCH.md`，把用户原话逐字写入 `BRIEF.md`，再分开记录“用户明确项”“检索证实项”和“默认推断项”。简报至少包含产品、唯一主张、受众、时长、画幅、语言、音频、视觉关键词、禁止项、事实来源和最终输出路径。

有 URL 时可执行 HyperFrames capture；没有 URL 时走 no-capture 路线，生成：

```text
capture/extracted/visible-text.txt
capture/extracted/tokens.json
capture/extracted/asset-descriptions.md
capture/assets/
```

`visible-text.txt` 保存用户原话；`tokens.json` 保存品牌标题、描述、色板和字体；没有真实素材时，`asset-descriptions.md` 必须明确写“无外部素材，使用原创排版、SVG 与 CSS 图形”，不能假装抓取成功。

**门禁：** Agent 能用一句话复述产品和唯一主张；每个关键产品事实都能追溯到 `RESEARCH.md`；输入事实包齐全。

### 3. 生成 frame.md 设计系统

根据用户视觉要求生成 `frame.md`，至少固定：canvas、ink、muted、primary、secondary、signal 六个颜色角色；展示字体与正文字体；圆角、网格、留白；图形语言；动画节奏；三条禁止项。

首版至少包含三种视觉层次：

1. 环境层：渐变、网格、粒子或光带之一；
2. 信息层：标题、核心能力、证据数字或真实产品片段；
3. 动作层：轨迹、形态变化、计数、遮罩或连续镜头运动。

不要只做“居中文字淡入淡出”。每个镜头必须有一个与产品含义对应的视觉动作。

**门禁：** `frame.md` 中的色板和视觉关键词能追溯到用户原话或明确默认值；整片只使用一套设计系统。

### 4. 生成 STORYBOARD.md

先读上游 `story-design.md` 与 `visual-design.md`，再写 `STORYBOARD.md`。10 秒首版建议 4 个连续段落，不等于四张 PPT：

1. `0.0–2.0s`：钩子，建立问题或欲望；
2. `2.0–5.0s`：机制，展示产品如何行动；
3. `5.0–8.0s`：证据，让成果或变化成为画面主体；
4. `8.0–10.0s`：品牌收束与一句行动主张。

每段必须写：目的、时间、画面构图、屏幕文字、资产候选、动画、转场入场、与下一段的连续元素。完整格式见 `references/artifact-contract.md`。

无配音时不生成 `SCRIPT.md`，并在 frontmatter 写 `music: none`。把所有段落状态先写为 `outline`；HTML 完成后逐段改为 `animated`。

**门禁：** `BRIEF.md`、`frame.md`、`STORYBOARD.md` 都是本次会话新建；时间相加等于目标时长；每段服务于唯一主张。

### 5. 生成 HyperFrames 源码

为每段生成 `compositions/frames/NN-*.html`，再生成 `index.html` 组装连续时间线。

- 每个 frame 必须有唯一 `data-composition-id`、正确的 `data-start`、`data-duration` 和 `data-track-index`。
- 可计时元素使用 `class="clip"`；全屏背景也必须是独立的 full-duration clip，不能只给 `#root` 设置背景。
- GSAP timeline 必须 `{ paused: true }`，并注册到 `window.__timelines[compositionId]`。
- 动画使用绝对时间参数；退出动作要在镜头结束前完成。
- 相邻镜头至少共享一个连续元素或运动方向，避免逐页硬切。
- 页面不得引用 CDN、远程字体或旧案例截图。没有素材时使用原创 SVG、CSS、排版和数据图形。
- 画面文字不超出安全区；屏幕同一时刻优先保留一个主标题和一个证据层。

完成后把 `STORYBOARD.md` 的段落状态改为 `animated`。

**门禁：** 新项目包含至少 3 个 frame HTML 和一个组装后的 `index.html`；源码能独立解释用户的新主题。

### 6. 先检查，再渲染

在案例包根目录执行我们的 DSH 适配检查，再在新项目执行 HyperFrames 检查：

```bash
node .agents/skills/product-launch-video/scripts/validate-project.mjs "generated/<project-slug>"

cd "generated/<project-slug>"
hyperframes lint
hyperframes check
hyperframes snapshot --at 1,3.5,6.5,9
```

检查失败时只修最小源码并重跑失败项。不要绕过错误直接渲染。快照生成后读取或打开联系表，确认没有裁切、遮挡、空白镜头或明显的 PPT 式硬切。

**门禁：** DSH 适配检查、lint 和 check 均退出 0；联系表已实际查看。

### 7. 渲染并验收 MP4

测试提示中写明“直接完成”时，无需再次等待确认，前台执行：

```bash
hyperframes render \
  --skill=product-launch-video \
  --quality=high \
  --output "renders/<project-slug>.mp4"

ffprobe -v error \
  -show_entries format=duration:stream=codec_name,codec_type,width,height,r_frame_rate,pix_fmt,nb_frames \
  -of json "renders/<project-slug>.mp4"

ffmpeg -v error -i "renders/<project-slug>.mp4" -f null -
```

渲染必须在前台等待退出码。最终只报告真实结果：生成目录、六类源码、中间产物、MP4 路径、编码、画幅、帧率、时长、帧数、音轨和全帧解码结果。

## 测试成功的可观察证据

DSH 会话中应依次出现：

1. `skill` 加载 `product-launch-video`；
2. `web_search` 至少执行 4 次，覆盖产品事实、用户问题、同类表达和视觉线索；
3. Shell 调用桌面端托管的 `hyperframes init` 创建新目录；
4. 文件工具新建 `RESEARCH.md`、`BRIEF.md`、`frame.md`、`STORYBOARD.md` 和 frame HTML；
5. Shell 调用本 Skill 的 `validate-project.mjs`；
6. Shell 调用 HyperFrames lint、check、snapshot、render；
7. Shell 调用 ffprobe 与 FFmpeg；
8. 新 MP4 出现在 `generated/<project-slug>/renders/`。

只读取旧项目并运行 `npm run render`，或只切换旧素材，均判定为失败。

## 上游与 DSH 改造边界

- **保留：** HyperFrames 的简报事实源、品牌采集/no-capture 分支、设计系统、故事脊柱、分镜、逐镜头视觉设计、连续转场、检查、快照、渲染和媒体规格验收。
- **DSH 改造：** 一句话自动补全、四维 Web Search 研究门禁、`RESEARCH.md` 事实层、全新目录约束、DSH Skill 触发、Agent Preset、DSH 文件/Shell 工具映射、固定版 CLI、课程级无配音快路径和防复用验证器。
- **不伪装：** HyperFrames 是外部 Apache-2.0 视频引擎；DeepSeek Harness 负责理解需求、生成项目源码、调用引擎和验收成果。
