# 手机 DeepSeek 账号入口

该附加包给既有 rc.8 安卓运行时增加官方 DeepSeek 账号的 PKCE 登录与
`deepseek-account` 模型路由。手机顶部“账号 → DeepSeek 账号”进入登录页。
凭据通过手机本地 credentials 服务保存，既不拷贝 Mac 账号，也不回连 Mac。

`vendor/protocol.js` 转译自 DeepSeek 官方仓库的
`packages/credentials/deepseek-account-platform/src/protocol.ts`，Git blob
`a8ab9b3d3c85d2f80036ce8d6d403a755862cb36`，MIT 许可证见 vendor 目录。
`vendor/adapter.js` 提供 rc.8 的模型发现、图片能力检查、超时与取消外层。
账号请求由 `messages-adapter.js` 覆盖为官方账号使用的 `/anthropic/v1/messages` 与
`x-dsh-auth-token`，禁止请求跟随重定向，并在 401 时只删除仍匹配该请求的旧凭据。
`vendor/messages` 转译自官方 master 的 serialize/translate/replay/sse/transport，
将 ToolCallId 接到 rc.8 的 CallId、将旧工具结果投影为 Messages tool-role、
采用内联图片并去除新版 requestImageHandleText 依赖，保留响应的思考签名。
源文件对应 Git blobs：serialize bbfd01d3c3221beacc55a5440f4c26ad1f743f51、
translate deb901119ee8308f2fe1420222dda0ffdf6b7cbf、replay f285ebaeae5084bd9f46f6d80a741eaf4984088b、
sse cec99869a264dc65f775663285d3fc47a382afde、transport 935e8855df9d699723be98291140abb90c798331。

该账号路由使用官方 Messages 端点。0.1.4 已于 2026-10-03 在 Android 实机验证：
官方账号授权保留、本机请求 HTTP 200、流式回复完成，聊天页面连续两轮正常回复。
每位使用者仍需在自己的手机上完成官方登录。
未提供 API Key 自动导入或手机/电脑间账号同步。

运行 `node --test account.test.js`；构建脚本将附加包放入树与 phone profile。

同一附加包也提供独立的 [ChatGPT 会员官方接入](CHATGPT.md)，使用独立凭据和
`chatgpt-plan` 路由；DeepSeek 授权与请求协议保持原样。

Jet Hub 多连接：正常会员请求自动循环使用支持该模型的已授权连接；读取模型目录不占顺位，当前管理连接不被请求改写。明确 401/权限或 429 失败且尚未交付内容时换下一个连接；限流连接暂时冷却 60 秒，进程重启清空冷却和顺位。已有流输出后的错误保留原错误，不重放。
