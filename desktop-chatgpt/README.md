# 电脑 ChatGPT 会员入口

与手机版共用官方 OAuth、账号保存和 Responses 适配器，凭据保存在电脑自己的 DSH credentials 中。适配 DSH 核心 `0.2.1-alpha.1`。首次安装或升级按 [电脑版说明](../desktop/README.md)，以下安装器命令适用于已安装匹配核心的电脑。

```bash
node scripts/install-desktop-chatgpt.mjs /path/to/.dsh/profiles/web /path/to/desktop/node_modules
node scripts/install-desktop-jet-hub-chatgpt.mjs /path/to/desktop/dsh-codearts-auth
```

重启电脑 DSH 后，打开「设置 → Jet Hub → ChatGPT 会员」，直接在会员账号面板点击 Continue with ChatGPT。完成官方授权后可管理账号、工作区和模型列表，与手机版使用同一套界面。登录需用户本人操作；模型与权限以官方账号返回为准。

Jet Hub 安装器只更新三个已核对版本的客户端源文件、两个共享会员面板文件及客户端 bundle，不修改服务端、供应商配置或账号凭据。遇到其他版本或并发修改会拒绝覆盖；重复安装不改变结果。

电脑可在模型选择中使用“ChatGPT 会员”。其他程序调用时，在“设置 → Jet Hub → API 网关”启用电脑网关；地址和密钥使用该面板的值，模型 ID 为 `chatgpt-plan/<官方 slug>`。账号页不假定电脑网关已经启用，也不覆盖其端口或密钥。

手机的本机账号继续保留。电脑模式通过电脑模型选择使用已在电脑授权的账号；电脑的 loopback 授权要在电脑浏览器完成。

官方流程及功能限制见 [共享会员接入说明](../phone-account/CHATGPT.md)。本插件增加桌面入口，不升级 DSH 核心或修改 QQ/远程配对。
