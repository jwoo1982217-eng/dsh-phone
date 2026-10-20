# 手机 ChatGPT 会员接入

在「设置 → Jet Hub → ChatGPT 会员」点击 **Continue with ChatGPT**。系统浏览器打开 OpenAI
官方授权页面；完成后点击「返回 DSH 手机版」，在同一 Jet Hub 面板查看当前账号的官方可用模型。
需要符合条件的账号与工作区，并明确授予 `chatgpt.tokens.use.direct`；仅登录身份
不足以启用会员调用。此接入不包含账号凭据，也不读取 Mac 或 ChatGPT 网页的 Cookie。

DSH、QQ 和墨听使用现有模型网关：

- 地址：`http://127.0.0.1:8326/v1`
- 密钥：Jet Hub 的现有网关密钥。
- 模型：账号页显示的 `chatgpt-plan/<官方 slug>`，或客户端获取 `/v1/models`。
- 聊天：兼容 `/v1/chat/completions` 的普通及流式调用。

上游使用 OAuth Bearer 调用公共 `/v1/models` 与 `/v1/responses`，模型名称及顺序
来自当前账号返回的 `models` 目录，过滤 `visibility: list`。DSH 模型名称附带
「ChatGPT 会员」以标明用量来源；发送给上游的是原始 slug。当前接入不保证某个网页
Pro 模型必定出现在接口目录，也不保证它与网页对话使用相同的限额。

会话请求使用 `store: false`、`stream: true`，携带完整历史。DSH 本地 JSON 函数工具
封装在 `dsh` namespace，工具结果按 call ID 回传；执行权限仍由 DSH 原有规则决定。
同一账号及模型的加密推理内容可用于下一轮，切换账号不会复用这类内容。
只收到部分文字、连接中断或最后出现额度错误时，不会把回答标记为成功。

会员接口当前不支持生图、音视频、OpenAI 托管 MCP／连接器、原生 computer use、
Code Interpreter 或 File Search。DSH 原有本地工具可以按函数协议调用。
图片输入仅在官方目录明确声明模型支持图片时启用；普通文本附件沿用 DSH 现有处理。
温度、最大输出 token 等不受此接口支持的调参不会发送；stop 参数会明确报错。
生图需要另行配置支持生图的官方 API 供应商。

每个账号／工作区注册分别保存 issued client ID、验证后的身份与令牌。
凭据位于 DSH credentials 服务；界面只显示脱敏身份。续期按连接串行，保存旋转后的
refresh token；退出只清除并尝试撤销所选连接。远程撤销失败时可在
[ChatGPT 用量设置](https://chatgpt.com/settings/usage) 管理授权。

离线验证：在仓库根目录运行 `node --test phone-account/*.test.js`。
测试使用本地签名身份夹具与模拟 OpenAI 响应，并通过真实 DSH runtime 和本机网关
验证模型目录、聊天与工具调用；不登录真实账号，不发送付费推理请求。
实际账号资格、登录浏览器与手机网络环境仍需安装后验证。

官方依据（核对日期：2026-10-04）：

- [注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [账号与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [界面要求](https://developers.openai.com/siwc/ui-ux-guidelines)

本接入为本项目独立实现，没有移植参考 APK 的反编译代码。
