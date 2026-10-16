# DSH 0.2.1-alpha.1 适配补丁

全部 JS / YAML 基于官方 dsh-v0.2.1-alpha.1 发布产物，保留 MIT LICENSE。

- app-boot：Android 使用已开启 --expose-internals 的内置加载器，避免加载没有 Android 包的 require-builtin 原生扩展。
- bash-local：手机使用应用随包提供的 Bionic bash。
- session-persistence-jsonl：Android 通过临时目录 fsync / rename 原子发布会话，避免不支持的硬链接；桌面沿用官方分支。
- client-connection：声明 Web 服务依赖，让独立管理 RPC 通道完成注册；本机回环地址不受浏览器的互联网离线提示阻断，页面从缓存恢复或回到前台时恢复断开的实时连接。保留官方 Host/Origin 和浏览器会话认证，不重发用户任务。
- client-ui-conversation：桌面和手机普通 Enter 换行，输入框声明回车键提示，并显示文字发送按钮；保留输入法候选确认、菜单选择、Ctrl/Cmd+Enter 与发送/排队/插话/停止原有流程。
- client-ui-model-selection：点击直接打开搜索列表，模型名、ID 和 API 来源可组合搜索，提供 API 筛选、收藏和最近使用。手机浮动面板、平板居中宽面板自适应横竖屏及软键盘；圆角面板四周留白，中间列表独立触摸滚动；键盘 Tab 不会意外切换模型。仅本浏览器保存模型标识偏好，Host 目录、选择请求、推理等级与失败恢复仍使用本版 SDK。维护源码为 `runtime/client-src/model-picker.jsx` 和 `.css`，运行 `node scripts/build-model-picker.mjs` 生成覆盖文件；`node scripts/model-picker-ui.test.mjs` 使用同版正式前端共享模块验证。
- compaction-basic：摘要默认输出预算为 8192 tokens，使用已声明的低档推理等级；同一轮自动压缩连续失败达到重试预算时明确结束本轮，保留原历史，避免每一步重复发压缩请求。显式配置的摘要预算继续生效。
- settings：把旧 noema-memory 设置迁入新版 dsh-noema 配置表单。
- web-app presets：标准、创作、PTC 预设启用 timed 提问（120 秒）；迟到的回答继续送入原会话，不产生默认许可。

上游源码：https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.1
