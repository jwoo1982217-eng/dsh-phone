---
name: first-time-setup
description: First-time setup flow for ai-content-images preferences
---

# First-Time Setup

## Overview

When no EXTEND.md is found, guide user through preference setup.

**⛔ BLOCKING OPERATION**: This setup MUST complete before ANY other workflow steps. Do NOT:
- Ask about content/article
- Ask about style or layout
- Ask about target audience
- Proceed to content analysis

ONLY ask the questions in this setup flow, save EXTEND.md, then continue.

## Setup Flow

```
No EXTEND.md found
        │
        ▼
┌─────────────────────┐
│ ask_user_question   │
│ (all questions)     │
└─────────────────────┘
        │
        ▼
┌─────────────────────┐
│ Create EXTEND.md    │
└─────────────────────┘
        │
        ▼
    Continue to Step 1
```

## Questions

**Language**: Use user's input language or saved language preference.

在 DSH 中使用一次 `ask_user_question` 提交多个问题：

### Question 1: Watermark

```
header: "Watermark"
question: "Watermark text for generated images? Type your watermark content (e.g., name, @handle)"
options:
  - label: "No watermark (Recommended)"
    description: "No watermark, can enable later in EXTEND.md"
```

Position defaults to bottom-right.

### Question 2: Preferred Style

```
header: "Style"
question: "Default visual style preference? Or type another style name or your custom style"
options:
  - label: "None (Recommended)"
    description: "Auto-select based on content analysis"
  - label: "cute"
    description: "Sweet, adorable - classic Content Platform aesthetic"
  - label: "notion"
    description: "Minimalist hand-drawn, intellectual"
```

### Question 3: Save Location

```
header: "Save"
question: "Where to save preferences?"
options:
  - label: "Project"
    description: ".baoyu-skills/ (this project only)"
  - label: "User"
    description: "~/.baoyu-skills/ (all projects)"
```

## Save Locations

| Choice | Path | Scope |
|--------|------|-------|
| Project | `.dsh/ai-content-images/EXTEND.md` | Current project |
| User | `$DSH_HOME/ai-content-images/EXTEND.md` | All projects |

## After Setup

1. Create directory if needed
2. Write EXTEND.md with frontmatter
3. Confirm: "Preferences saved to [path]"
4. Continue to Step 1

## EXTEND.md Template

```yaml
---
version: 1
watermark:
  enabled: [true/false]
  content: "[user input or empty]"
  position: bottom-right
  opacity: 0.7
preferred_style:
  name: [selected style or null]
  description: ""
preferred_layout: null
language: null
preferred_image_backend: dsh-content-imagegen
generation_batch_size: 1
custom_styles: []
---
```

`preferred_image_backend: dsh-content-imagegen` 是本案例固定值，指向场景 DSH Plugin。它通过本机 Codex CLI 桥接 `$imagegen`，不是 DSH 原生生图。

`generation_batch_size: 1` 是本案例固定并发限制。

## Modifying Preferences Later

See the `## Changing Preferences` section in `SKILL.md` for the canonical list of common edits (pin backend, change defaults, retrigger setup). Full schema: `preferences-schema.md`.
