# 一句话产品视频产物契约

本文件定义 DSH 快路径必须生成的中间产物。它补充上游完整工作流，不替代上游的故事与动效方法。

## RESEARCH.md

第一部分记录至少四条真实搜索：

```markdown
## 查询记录

1. 产品事实
   - query: "..."
2. 用户问题
   - query: "..."
3. 同类表达
   - query: "..."
4. 视觉线索
   - query: "..."
```

第二部分用表格记录至少 8 个去重来源：

```markdown
| 来源 | URL | 已证实事实 | 视频中的用途 |
| --- | --- | --- | --- |
| 官方网站 | https://... | ... | 品牌定位/界面/色彩 |
```

最后写三项结论：唯一值得拍的变化、可使用的视觉事实、没有证据所以明确舍弃的说法。搜索摘要只能作为事实线索；不得把来源页面的长段文字或版权不明图片直接复制进成果。

## BRIEF.md

```yaml
---
workflow: product-launch-video
flow: automation
storyboard: no
message: "视频唯一要传达的一句话"
destination: embed
aspect: 16:9
language: zh-CN
audience: "目标受众"
length: 10s
audio: none
output: renders/<project-slug>.mp4
---
```

正文顺序：用户原话、用户明确项、默认推断项、唯一主张、视觉关键词、禁止项、输出。

## frame.md

必须包含：

- 六个颜色角色：canvas、ink、muted、primary、secondary、signal；
- 展示字体、正文字体、数字字体；
- 12 列安全网格、主信息区和四周安全区；
- 背景、信息、动作三层的视觉规则；
- 统一的 motion curve 与 stagger 节奏；
- 禁止 CDN、禁止逐页 PPT 式硬切、禁止无意义装饰。

## STORYBOARD.md

```yaml
---
workflow: product-launch-video
duration: 10
width: 1920
height: 1080
fps: 30
music: none
---
```

每个段落使用以下字段：

```markdown
## Frame 01 — 名称

- status: outline | animated
- src: compositions/frames/01-name.html
- start: 0
- duration: 2
- purpose: 这一段推动什么信息
- screen_copy: 屏幕文字
- asset_candidates: 使用的真实素材或“原创 SVG/CSS”
- transition_in: 转场方式
- transition_out: 转场方式
- continuity: 与下一段共享的元素、方向、位置或颜色

### Shot sequence

- 0.0–0.4s：构图、动作、缓动
- 0.4–1.5s：构图、动作、缓动
- 1.5–2.0s：构图、动作、缓动
```

## HyperFrames HTML

每个 frame 的最小结构：

```html
<div id="root" data-composition-id="frame-01" data-width="1920" data-height="1080">
  <div class="clip ground" data-start="0" data-duration="2" data-track-index="0"></div>
  <section class="clip content" data-start="0" data-duration="2" data-track-index="1"></section>
</div>
<script>
  const timeline = gsap.timeline({ paused: true });
  timeline.fromTo('.content', { opacity: 0, y: 40 }, { opacity: 1, y: 0, duration: .6 }, 0);
  window.__timelines = window.__timelines || {};
  window.__timelines['frame-01'] = timeline;
</script>
```

最终 `index.html` 用 `data-composition-src` 按绝对时间组装各 frame，并把总时长写入根 composition。
