---
name: ai-content-images
description: 将长文拆成 1–10 张图文卡片，保留 12 种视觉风格、8 种布局和 3 套配色。用户提到图文卡片、知识卡片、微信图文、文章可视化、image cards 或要求生成系列信息图时使用。
---

# Image Card Series Generator

Break down complex content into eye-catching image card series with multiple style options.

## User Input Tools

在 DSH 中需要确认时调用 `ask_user_question`。如果一次要确认多项，合并在同一次调用中；只在该工具不可用时，才退回编号文字问题。

## Image Generation Tools

本案例固定调用 DSH Plugin 工具 `generate_content_image`。该工具通过受限的本机 `codex exec --ephemeral` 桥接 `$imagegen`；这是本案例插件补充的能力，不是 DSH 原生生图能力。调用前必须先把每张图的完整提示写入独立文件，再把本次 `project_dir` 和相对路径交给工具。

**⛔ Never substitute SVG, HTML, canvas, or other code-based rendering for raster image generation.** Codex `imagegen`'s own description says it should be used "when the output should be a bitmap asset rather than repo-native code or vector." If you cannot resolve a raster backend via step 3, fall through to step 4 and ask the user — do **not** silently emit SVG, write inline `<svg>` markup, or produce HTML/CSS art as a substitute. This applies even if the article/section seems "diagram-like": the consumer skill calling this rule has already decided that a raster image is what it needs.

**⛔ Never repair rendered text by painting over a generated bitmap.** Do not use ImageMagick, Pillow, Canvas, SVG, HTML/CSS, OCR scripts, or any other programmatic overlay to cover, rewrite, erase, stroke, or replace titles, body copy, tags, or any other text inside an already generated image card. If text is wrong or unclear, regenerate from a corrected prompt, switch to a layout with less on-card text, or ask the user which imperfect candidate to keep.

**Prompt file requirement (hard)**: write each image's full, final prompt to a standalone file under `prompts/` (naming: `NN-{type}-[slug].md`) BEFORE invoking any backend. The file is the reproducibility record and lets you switch backends without regenerating prompts.

生成后调用 `inspect_content_series`，传入同一个 `project_dir` 和期望张数，检查本次新系列的 PNG 签名、尺寸、数量与提示文件数量。

## Batch Generation Policy

After every prompt file for the current generation group has been saved and verified, generate images in batches by default.

在 DSH 中按顺序调用 `generate_content_image`。插件为保护本地 Codex 会话强制并发数为 1；“批量”仍表示确认全部提示文件后连续生成，不改变下方的首图锚点链。

Rules:

- Honor the image-1 anchor chain: generate image 1 first, then batch images 2+ using image 1 as the reference.
- Never start a batch until every selected prompt file for that batch exists on disk.
- Retry failed items once without regenerating successful items.
- Do not use subagents merely to parallelize image rendering. Use subagents only for separate prompt iteration or creative exploration.

## Confirmation Policy

Default behavior: **confirm before generation**.

- Treat explicit skill invocation, a file path, matched signals/presets, and `EXTEND.md` defaults as **recommendation inputs only**. None of them authorizes skipping confirmation.
- Do **not** start Step 3 until the user completes Step 2.
- Skip confirmation only when the current request explicitly says to do so, for example: `--yes`, "直接生成", "不用确认", "跳过确认", "按默认出图", or equivalent wording.
- If confirmation is skipped explicitly, state the assumed strategy / style / layout / palette / count / backend in the next user-facing update before generating.

## Language

Respond in the user's language across questions, progress, errors, and completion summary. Keep technical tokens (style names, file paths, code) in English.

## Options

| Option | Description |
|--------|-------------|
| `--style <name>` | Visual style (see Styles below) |
| `--layout <name>` | Information layout (see Layouts below) |
| `--palette <name>` | Color override: macaron / warm / neon |
| `--preset <name>` | Style + layout + optional palette shorthand (see Presets below; per-preset prompt fragments in `references/style-presets.md`) |
| `--ref <files...>` | Reference images applied to image 1 as the series anchor |
| `--batch-size <n>` | 保留的上游兼容参数；本 DSH 案例实际固定为 1。 |
| `--yes` | Non-interactive: skip all confirmations, use EXTEND.md or built-in defaults, auto-confirm recommended plan (Path A) |

## Dimensions

Three independent knobs combine freely:

| Dimension | Controls | Options |
|-----------|----------|---------|
| **Style** | Visual aesthetics (lines, decorations, rendering) | 12 styles (see Styles below) |
| **Layout** | Information structure (density, arrangement) | 8 layouts (see Layouts below) |
| **Palette** (optional) | Color override, replaces the style's default colors | macaron / warm / neon (see Palettes below) |

Example: `--style notion --layout dense` makes an intellectual knowledge card; add `--palette macaron` to soften the colors without changing notion's rendering rules. A `--preset` is a shorthand for style + layout (+ optional palette).

**Palette behavior**: no `--palette` → style's built-in colors; `--palette <name>` → overrides colors only, rendering rules unchanged. Some styles declare a `default_palette` (e.g., sketch-notes defaults to macaron).

## Styles (12)

| Style | Description |
|-------|-------------|
| `cute` (Default) | Sweet, adorable, girly aesthetic |
| `fresh` | Clean, refreshing, natural |
| `warm` | Cozy, friendly, approachable |
| `bold` | High impact, attention-grabbing |
| `minimal` | Ultra-clean, sophisticated |
| `retro` | Vintage, nostalgic, trendy |
| `pop` | Vibrant, energetic, eye-catching |
| `notion` | Minimalist hand-drawn line art, intellectual |
| `chalkboard` | Colorful chalk on black board, educational |
| `study-notes` | Realistic handwritten photo style, blue pen + red annotations + yellow highlighter |
| `screen-print` | Bold poster art, halftone textures, limited colors, symbolic storytelling |
| `sketch-notes` | Hand-drawn educational infographic, macaron pastels on warm cream, wobble lines |

Per-style specifications: `references/presets/<style>.md`.

## Layouts (8)

| Layout | Description |
|--------|-------------|
| `sparse` (Default) | 1-2 points, maximum impact |
| `balanced` | 3-4 points, standard |
| `dense` | 5-8 points, knowledge-card style |
| `list` | Enumeration / ranking (4-7 items) |
| `comparison` | Side-by-side contrast |
| `flow` | Process / timeline (3-6 steps) |
| `mindmap` | Center-radial (4-8 branches) |
| `quadrant` | Four-quadrant / circular sections |

Layout specs: `references/elements/canvas.md`.

## Palettes (optional override)

Replaces the style's colors while keeping rendering rules (line treatment, textures) intact.

| Palette | Background | Zone Colors | Accent | Feel |
|---------|------------|-------------|--------|------|
| `macaron` | Warm cream #F5F0E8 | Blue #A8D8EA, Lavender #D5C6E0, Mint #B5E5CF, Peach #F8D5C4 | Coral #E8655A | Soft, educational |
| `warm` | Soft peach #FFECD2 | Orange #ED8936, Terracotta #C05621, Golden #F6AD55, Rose #D4A09A | Sienna #A0522D | Earth tones, cozy |
| `neon` | Dark purple #1A1025 | Cyan #00F5FF, Magenta #FF00FF, Green #39FF14, Pink #FF6EC7 | Yellow #FFFF00 | High-energy, futuristic |

Palette specs: `references/palettes/<palette>.md`.

## Presets (style + layout shortcuts)

Quick-start combos, grouped by scenario. Use `--preset <name>` or recommend during Step 2.

**Knowledge & Learning**:

| Preset | Style | Layout | Best For |
|--------|-------|--------|----------|
| `knowledge-card` | notion | dense | 干货知识卡、概念科普 |
| `checklist` | notion | list | 清单、排行榜 |
| `concept-map` | notion | mindmap | 概念图、知识脉络 |
| `swot` | notion | quadrant | SWOT 分析、四象限 |
| `tutorial` | chalkboard | flow | 教程步骤、操作流程 |
| `classroom` | chalkboard | balanced | 课堂笔记、知识讲解 |
| `study-guide` | study-notes | dense | 学习笔记、考试重点 |
| `hand-drawn-edu` | sketch-notes | flow | 手绘教程、流程图解 |
| `sketch-card` | sketch-notes | dense | 手绘知识卡 |
| `sketch-summary` | sketch-notes | balanced | 手绘总结、图文笔记 |

**Lifestyle & Sharing**:

| Preset | Style | Layout | Best For |
|--------|-------|--------|----------|
| `cute-share` | cute | balanced | 少女风分享、日常推荐 |
| `girly` | cute | sparse | 甜美封面、氛围感 |
| `cozy-story` | warm | balanced | 生活故事、情感分享 |
| `product-review` | fresh | comparison | 产品对比、测评 |
| `nature-flow` | fresh | flow | 健康流程、自然主题 |

**Impact & Opinion**:

| Preset | Style | Layout | Best For |
|--------|-------|--------|----------|
| `warning` | bold | list | 避坑指南、重要提醒 |
| `versus` | bold | comparison | 正反对比 |
| `clean-quote` | minimal | sparse | 金句、极简封面 |
| `pro-summary` | minimal | balanced | 专业总结、商务内容 |

**Trend & Entertainment**:

| Preset | Style | Layout | Best For |
|--------|-------|--------|----------|
| `retro-ranking` | retro | list | 复古排行、经典盘点 |
| `throwback` | retro | balanced | 怀旧分享 |
| `pop-facts` | pop | list | 趣味冷知识 |
| `hype` | pop | sparse | 炸裂封面、惊叹分享 |

**Poster & Editorial**:

| Preset | Style | Layout | Best For |
|--------|-------|--------|----------|
| `poster` | screen-print | sparse | 海报风封面、影评书评 |
| `editorial` | screen-print | balanced | 观点文章、文化评论 |
| `cinematic` | screen-print | comparison | 电影对比、戏剧张力 |

Full prompt-fragment definitions: `references/style-presets.md`.

## Auto-Selection

Match content signals to the best combo. First row whose keywords appear wins; fall back to `cute-share` if nothing matches.

| Signals in source | Style | Layout | Recommended preset |
|-------------------|-------|--------|--------------------|
| beauty, fashion, cute, girl, pink | `cute` | sparse/balanced | `cute-share`, `girly` |
| health, nature, fresh, organic | `fresh` | balanced/flow | `product-review`, `nature-flow` |
| life, story, emotion, warm | `warm` | balanced | `cozy-story` |
| warning, important, must, critical | `bold` | list/comparison | `warning`, `versus` |
| professional, business, elegant | `minimal` | sparse/balanced | `clean-quote`, `pro-summary` |
| classic, vintage, traditional | `retro` | balanced | `throwback`, `retro-ranking` |
| fun, exciting, wow, amazing | `pop` | sparse/list | `hype`, `pop-facts` |
| knowledge, concept, productivity, SaaS | `notion` | dense/list | `knowledge-card`, `checklist` |
| education, tutorial, learning, classroom | `chalkboard` | balanced/dense | `tutorial`, `classroom` |
| notes, handwritten, study guide, realistic | `study-notes` | dense/list/mindmap | `study-guide` |
| movie, poster, opinion, editorial, cinematic | `screen-print` | sparse/comparison | `poster`, `editorial`, `cinematic` |
| hand-drawn, infographic, workflow, 手绘，图解 | `sketch-notes` | flow/balanced/dense | `hand-drawn-edu`, `sketch-card`, `sketch-summary` |

## Style × Layout Matrix

Compatibility scores (✓✓ highly recommended, ✓ works well, ✗ avoid). Use when the user picks a non-default combo and you want to flag a poor match.

|              | sparse | balanced | dense | list | comparison | flow | mindmap | quadrant |
|--------------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| cute         | ✓✓ | ✓✓ | ✓  | ✓✓ | ✓  | ✓  | ✓  | ✓  |
| fresh        | ✓✓ | ✓✓ | ✓  | ✓  | ✓  | ✓✓ | ✓  | ✓  |
| warm         | ✓✓ | ✓✓ | ✓  | ✓  | ✓✓ | ✓  | ✓  | ✓  |
| bold         | ✓✓ | ✓  | ✓  | ✓✓ | ✓✓ | ✓  | ✓  | ✓✓ |
| minimal      | ✓✓ | ✓✓ | ✓✓ | ✓  | ✓  | ✓  | ✓  | ✓  |
| retro        | ✓✓ | ✓✓ | ✓  | ✓✓ | ✓  | ✓  | ✓  | ✓  |
| pop          | ✓✓ | ✓✓ | ✓  | ✓✓ | ✓✓ | ✓  | ✓  | ✓  |
| notion       | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓✓ |
| chalkboard   | ✓✓ | ✓✓ | ✓✓ | ✓✓ | ✓  | ✓✓ | ✓✓ | ✓  |
| study-notes  | ✗  | ✓  | ✓✓ | ✓✓ | ✓  | ✓  | ✓✓ | ✓  |
| screen-print | ✓✓ | ✓✓ | ✗  | ✓  | ✓✓ | ✓  | ✗  | ✓✓ |
| sketch-notes | ✓  | ✓✓ | ✓✓ | ✓✓ | ✓  | ✓✓ | ✓✓ | ✓  |

## Outline Strategies

Three differentiated approaches — each produces a structurally different outline. The workflow recommends one; Path C generates all three and lets the user choose.

| Strategy | Concept | Best for | Structure |
|----------|---------|----------|-----------|
| **A — Story-Driven** | Personal experience as the thread, emotional resonance first | Reviews, personal shares, transformation | Hook → Problem → Discovery → Experience → Conclusion |
| **B — Information-Dense** | Value-first, efficient information delivery | Tutorials, comparisons, checklists | Core conclusion → Info card → Pros/Cons → Recommendation |
| **C — Visual-First** | Visual impact as core, minimal text | High-aesthetic products, lifestyle, mood content | Hero image → Detail shots → Lifestyle scene → CTA |

## Reference Images

User-supplied refs are **separate from** the internal "image-1 as anchor" chain (Step 3) — they layer on top of it.

**Intake**: via `--ref <files...>` or paths pasted in conversation.
- File path → copy to `refs/NN-ref-{slug}.{ext}`
- Pasted with no path → ask for the path, or extract style traits as a text fallback

**Usage modes** (per reference):

| Usage | Effect |
|-------|--------|
| `direct` | Pass the file to the backend (typically on image 1 only, so the anchor propagates through the chain) |
| `style` | Extract style traits and append to every card's prompt body |
| `palette` | Extract hex colors and append to every card's prompt body |

Record refs in each affected card's prompt frontmatter:

```yaml
references:
  - ref_id: 01
    filename: 01-ref-brand.png
    usage: direct
```

At generation time: verify files exist. Image 1 with `usage: direct` + backend that accepts refs → pass via the backend's ref parameter (becomes the chain anchor). Images 2+ keep using image-1 as `--ref` per Step 3 — do NOT re-stack user refs on top (avoids conflicting signals). For `style`/`palette`, embed extracted traits in every prompt.

## File Layout

```
generated/{topic-slug}/
├── source-{slug}.{ext}
├── analysis.md
├── outline-strategy-{a,b,c}.md    # Path C only
├── outline.md
├── prompts/NN-{type}-{slug}.md
├── output/NN-{type}-{slug}.png
└── refs/                          # only if --ref used
```

**Slug**: 2-4 words, kebab-case. "AI 工具推荐" → `ai-tools-recommend`. On collision, append `-YYYYMMDD-HHMMSS`.

**新生成硬约束**：每次都从用户本轮输入建立新的 `generated/{topic-slug}/`。不得读取案例根目录的 `input/deepseek-harness-article/` 或 `output/deepseek-harness/` 来代替分析、提示或生成结果；它们只是教师展示案例。

**Backup rule** (applies throughout): before overwriting any file — source, outline, prompt, image — rename the existing one to `<name>-backup-YYYYMMDD-HHMMSS.<ext>`. This protects user edits.

## Workflow

```
- [ ] Step 0: Load EXTEND.md ⛔ BLOCKING (interactive only)
- [ ] Step 1: Analyze content → analysis.md
- [ ] Step 2: Smart Confirm ⚠️ REQUIRED (Path A / B / C)
- [ ] Step 3: Generate images
- [ ] Step 4: Completion report
```

### Step 0: Load EXTEND.md ⛔ BLOCKING

Check these paths in order; first hit wins:

| Path | Scope |
|------|-------|
| `.dsh/ai-content-images/EXTEND.md` | Project |
| `${XDG_CONFIG_HOME:-$HOME/.config}/dsh/ai-content-images/EXTEND.md` | XDG |
| `$DSH_HOME/ai-content-images/EXTEND.md` | User home |

- **Found** → read, parse, print a summary (style / layout / watermark / language), continue.
- **Not found + interactive** → run first-time setup (see `references/config/first-time-setup.md`) and save before anything else. Do NOT analyze content or ask style questions until preferences exist — this keeps first-run behavior predictable.
- **Not found + `--yes`** → skip setup, use built-in defaults (no watermark, style/layout auto-selected, language from content). Do not prompt, do not create EXTEND.md.

**EXTEND.md keys**: watermark, preferred style/layout, custom style definitions, language preference, preferred image backend, generation batch size. Schema: `references/config/preferences-schema.md`.

### Step 1: Analyze Content → `analysis.md`

1. Save the source (backup rule applies if `source.md` exists).
2. Run the deep analysis in `references/workflows/analysis-framework.md`: content type, hook potential, audience, engagement signals, visual opportunity map, swipe flow.
3. Detect source language, pick recommended image count (2-10).
4. Auto-recommend strategy + style + layout + palette using the **Auto-Selection** table above.
5. Write everything to `analysis.md`.

### Step 2: Smart Confirm ⚠️ REQUIRED

**Hard gate**: this step is mandatory per the [Confirmation Policy](#confirmation-policy) — Step 3 cannot start until the user confirms here (or explicitly opts out with `--yes` / equivalent wording in the current request).

Goal: present the auto-recommended plan and let the user confirm or adjust. Skip this step entirely under `--yes` — proceed with Path A using the analysis and any CLI overrides.

**Display summary** before asking:

```
📋 内容分析
  主题：[topic] | 类型：[content_type]
  要点：[key points]
  受众：[audience]

🎨 推荐方案（自动匹配）
  策略：[A/B/C] [name]（[reason]）
  风格：[style] · 布局：[layout] · 配色：[palette or 默认] · 预设：[preset]
  图片：[N]张（封面+[N-2]内容+结尾）
  元素：[background] / [decorations] / [emphasis]
```

Then ask one question — three paths. Verbatim option copy: `references/confirmation.md`.

**Path A — Quick confirm** (trust auto-recommendation): generate a single outline using the recommended strategy + style → save to `outline.md` → Step 3.

**Path B — Customize**: ask five questions (strategy/style, layout, palette, count, optional notes) with the recommendation pre-filled — blanks keep the recommendation. Generate one outline with the user's choices → `outline.md` → Step 3. See `references/confirmation.md`.

**Path C — Detailed mode**: two sub-confirmations.

- *Step 2a — Content understanding*: ask selling points (multi-select), audience, style preference (authentic / professional / aesthetic / auto), optional context. Update `analysis.md`.
- *Step 2b — Three outline variants*: generate `outline-strategy-a.md`, `outline-strategy-b.md`, `outline-strategy-c.md`. Each MUST have a different structure AND a different recommended style — include `style_reason` in the frontmatter. Page-count heuristic: A ~4-6, B ~3-5, C ~3-4. Template: `references/workflows/outline-template.md`; frontmatter example in `references/confirmation.md`.
- *Step 2c — Selection*: ask three questions (outline A/B/C/Combined, style, visual elements). Save selected/merged outline to `outline.md` → Step 3.

### Step 3: Generate Images

With confirmed outline + style + layout + palette:

**Visual consistency — image-1 anchor chain**: character / mascot / color rendering drifts between calls unless you anchor them. Generate image 1 (cover) first WITHOUT `--ref`, then pass image 1 as `--ref` to every subsequent image. This is the single most important consistency trick for this skill — don't skip it even if the backend also supports a session ID.

Generation flow:

1. Write the full prompt for every image to `prompts/NN-{type}-{slug}.md` in the user's preferred language (backup rule applies), then verify all selected prompt files exist.
2. Generate **image 1** first without `--ref`; backup rule applies to the PNG file. This establishes the anchor.
3. Build a task list for **images 2+** using image 1 as `--ref <path-to-image-01.png>`.
4. 按 `## Batch Generation Policy` 顺序生成 images 2+；每张都调用一次 `generate_content_image`，参数中的 `project_dir` 始终为本次 `generated/{topic-slug}`，`prompt_file` 为相对该目录的 `prompts/...`，参考图为相对该目录的 `output/01-....png`。
5. Report progress after each completed image. On failure, retry only the failed item once from the same saved prompt file.
6. 全部生成后调用 `inspect_content_series({ project_dir, expected_count })`，只验收本次新系列；不使用教师案例的 manifest。

**Watermark** (if enabled in EXTEND.md): append to the generation prompt:

```
Include a subtle watermark "[content]" positioned at [position].
The watermark should be legible but not distracting.
```

See `references/config/watermark-guide.md`.

**Backend selection**: 使用 `generate_content_image`。Prompt files MUST exist before invoking the tool. 该桥接的边界见 [references/codex-imagegen.md](references/codex-imagegen.md)。

**Session ID** (if the backend supports `--sessionId`): use `cards-{topic-slug}-{timestamp}` for every image; combined with the ref chain this gives maximum consistency.

### Step 4: Completion Report

```
Image Card Series Complete!

Topic: [topic]
Mode: [Quick / Custom / Detailed]
Strategy: [A/B/C/Combined]
Style: [name]
Palette: [name or "default"]
Layout: [name or "varies"]
Location: [directory]
Images: N total

✓ analysis.md
✓ outline.md
✓ outline-strategy-a/b/c.md (detailed mode only)

- 01-cover-[slug].png ✓ Cover (sparse)
- 02-content-[slug].png ✓ Content (balanced)
- ...
- NN-ending-[slug].png ✓ Ending (sparse)
```

## Content Breakdown Principles

| Position | Purpose | Typical layout |
|----------|---------|----------------|
| Cover (image 1) | Hook + visual impact | `sparse` |
| Content (middle) | Core value per image | `balanced` / `dense` / `list` / `comparison` / `flow` |
| Ending (last) | CTA / summary | `sparse` or `balanced` |

For the style × layout compatibility matrix, see the **Style × Layout Matrix** above.

## Image Modification

| Action | How |
|--------|-----|
| Edit | Update `prompts/NN-{type}-{slug}.md` **first**, then regenerate with the same session ID |
| Add | Specify position, create prompt, generate, renumber subsequent files `NN+1`, update outline |
| Delete | Remove files, renumber subsequent `NN-1`, update outline |

Always update the prompt file before regenerating — it's the source of truth and makes changes reproducible.

Text correction policy:

- If a card's title, body copy, tags, or any other rendered text is misspelled, garbled, hard to read, or visually weak, do not patch the bitmap with code.
- For text-correction regenerations, write a new prompt file and a new output path so the flawed candidate is preserved for comparison.
- Post-processing is limited to crop, resize, compression, or format conversion that does not alter text or the main composition.

## References

| File | Content |
|------|---------|
| `references/confirmation.md` | `ask_user_question` 的各确认路径文案 |
| `references/style-presets.md` | Full preset shortcut definitions |
| `references/presets/<style>.md` | Per-style element definitions |
| `references/palettes/<name>.md` | Per-palette color definitions |
| `references/elements/canvas.md` | Aspect ratios, safe zones, grid layouts |
| `references/elements/image-effects.md` | Cutout, stroke, filters |
| `references/elements/typography.md` | Decorated text, tags, text direction |
| `references/elements/decorations.md` | Emphasis marks, backgrounds, doodles, frames |
| `references/workflows/analysis-framework.md` | Content analysis framework |
| `references/workflows/outline-template.md` | Outline template with layout guide |
| `references/workflows/prompt-assembly.md` | Prompt assembly guide |
| `references/config/preferences-schema.md` | EXTEND.md schema |
| `references/config/first-time-setup.md` | First-time setup flow |
| `references/config/watermark-guide.md` | Watermark configuration |

## Notes

- Auto-retry once on generation failure before reporting an error.
- For sensitive public figures, use stylized cartoon alternatives.
- Smart Confirm (Step 2) is required; Detailed mode adds a second confirmation (2a + 2c).

## Changing Preferences

EXTEND.md lives at the first matching path listed in Step 0. Three ways to change it:

- **Edit directly** — open EXTEND.md and change fields. Full schema: `references/config/preferences-schema.md`.
- **Reconfigure interactively** — delete EXTEND.md (or ask "reconfigure ai-content-images preferences" / "重新配置"). The next run re-triggers first-time setup.
- **Common one-line edits**:
  - `preferred_image_backend: dsh-content-imagegen` — 本案例固定的 DSH Plugin bridge。
  - `generation_batch_size: 1` — 本案例强制串行，保护本地 Codex 会话。
  - `preferred_style: notion`, `preferred_layout: dense`, `preferred_palette: macaron`, `language: zh`.
  - `watermark.enabled: true` + `watermark.content: "@handle"` — add a watermark.
