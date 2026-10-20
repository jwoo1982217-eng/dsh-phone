# DSH Codex ImageGen Bridge

DSH 本身不提供原生生图工具。本案例安装 `dsh-content-imagegen` Plugin 后，由模型调用 `generate_content_image`；插件在受限临时工作目录中执行本机 `codex exec --ephemeral`，再把一张 PNG 复制到案例的 `output/` 下。

## 调用约定

- `prompt_file`：案例根目录内、已经落盘的 Markdown 提示文件相对路径。
- `output_file`：只能是 `output/` 下的 `.png` 相对路径。
- `reference_image`：可选，只能指向案例根目录内已有图片；第 2 张起传第 1 张作为风格锚点。
- `aspect_ratio`：默认 `3:4`。
- 插件强制并发数为 1，并设置 7 分钟超时。

插件不接收 API Key。它复用本机已登录的 Codex CLI；没有登录或没有 `$imagegen` 能力时会明确失败。

## Stdout contract

DSH 工具返回结构化对象：

- 成功：`status=generated`、输出相对路径、字节数、宽高、提示文件、是否使用参考图。
- 失败：工具调用以明确错误结束，不写入目标 PNG。

失败后不要自行切换 HTML、SVG 或画布替代；先报告原因，再由用户决定是否重试。

## Batch semantics

- 每次工具调用只生成一张图；系列图逐张调用。
- 风格一致性来自 `reference_image` 指向首图，不依赖 session id。
- 宽高由生成模型决定；工具会读取 PNG 头返回实际尺寸，最后用 `inspect_content_series` 验收画幅与系列数量。
