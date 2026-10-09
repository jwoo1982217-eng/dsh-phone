# 电脑版安装、启动与手机配对

本仓库同时包含 Android APK 源码和电脑版适配源码。电脑版是运行在电脑本机的 DSH Web 界面，使用系统浏览器；不是 Android APK，也不是官方 Electron 安装包。两端固定使用官方 `0.2.1-alpha.1` 预览版核心，包含 Jet Hub、ChatGPT 会员、Noema、技能和加密远程连接。

## 安装电脑版

需要 Git、Node.js 24.11+（包含 npm）；安装命令固定使用 pnpm 10.34.6，不替换电脑的全局 pnpm。Windows 若原生终端依赖需要编译，需安装 C++ 构建工具；本次实际验证平台为 macOS arm64。

```sh
git clone https://cnb.cool/applecabal/dsh-phone.git
cd dsh-phone
npx --yes pnpm@10.34.6 --dir desktop-runtime install --frozen-lockfile
node scripts/install-desktop.mjs
node scripts/start-desktop.mjs
```

只安装 `desktop-runtime`，不需要 Android SDK、NDK，也不用构建 APK 或安装手机的 `runtime`。首次安装会建立空白 `~/.dsh/profiles/web`；已有账号、聊天、技能、配对和自定义预设保留。安装前备份将被替换的程序入口，位置由安装器输出。重装前先等正在运行的 AI 任务完成，再按 Ctrl+C 停止原 DSH。

Mac 以后可以双击 `desktop/start.command`；下载 ZIP 丢失执行权限时，先运行 `chmod +x desktop/start.command`。Windows 双击 `desktop/start.cmd`；Linux 在仓库目录运行 `node scripts/start-desktop.mjs`。

通过新启动器启动的 DSH 已在运行时，再点快捷方式会打开当前网页，不另起占用 3080 的进程。启动器仅在本机 DSH 用户目录保存可重复打开的登录入口（文件权限 0600），不上传或加入源码。

启动后自动打开默认浏览器。若提示 `dsh web authentication required`，从启动终端打开当次打印的**完整链接（含 `?token=…`）**。新浏览器或重启后不要复用旧 token，也不要把登录链接发给别人。手机配对链接在下一节生成，和浏览器登录链接不同。

关闭网页不会停止电脑服务；在启动终端按 Ctrl+C 才停止 DSH。关闭终端、关机或电脑休眠会中断远程访问。本安装器不会修改开机启动和休眠设置。

## 升级已有电脑版

先等任务完成并停止旧 DSH，然后在本仓库执行：

```sh
git pull --ff-only
npx --yes pnpm@10.34.6 --dir desktop-runtime install --frozen-lockfile
node scripts/install-desktop.mjs
node scripts/start-desktop.mjs
```

如果旧安装目录中还有 `node_modules/.bin/dsh` 或旧启动快捷方式，可同时更新旧 CLI 引用：

```sh
node scripts/install-desktop.mjs --legacy-desktop /path/to/old-dsh
```

此后推荐使用本仓库的 `desktop/start.command` 或 `scripts/start-desktop.mjs`，它们直接调用锁定的电脑版核心，避免旧目录调用 rc.8、新 profile 却加载 0.2.1 插件的混用。不要移动或删除仓库目录，已安装的插件入口引用这个目录。

pnpm 12 的本地插件冻结安装检查在本项目的全新目录中会误报 `ERR_PNPM_OUTDATED_LOCKFILE`；使用上面固定的 10.34.6 命令，保留锁文件校验和依赖发布时间检查。无需删除锁文件或关闭检查。[上游相关问题](https://github.com/pnpm/pnpm/issues/16332)

## Pocket 扫码连接手机 App

新安装器自带 Pocket 2.10.6，手机使用 0.1.55 或更新版。

1. 电脑 DSH「设置 → 手机访问」打开 Pocket；外出使用时点「开启公网访问」，阅读并确认页面提示。
2. 手机 App 点「电脑 → 扫码连接电脑（Pocket）」，允许相机权限，扫描电脑二维码。
3. 在 App 内输入电脑显示的访问密码，进入电脑 DSH。下次点「电脑」打开保存的地址，点「手机」返回本机。

地址变化时从「服务 → 设备连接」重新扫码，也可以粘贴 Pocket 链接。电脑、DSH 和隧道需要保持在线。原 API 同步与手机模型网关使用「服务 → 设备连接 → 原设备连接方式」。

## 原有加密中继配对

1. 电脑启动 DSH，保持运行。手机安装本项目 APK，打开后等待「运行中」；手机本机可以单独使用。
2. 电脑另开一个终端，在同一仓库目录启动密文中继。先安装 [Cloudflare 官方 cloudflared](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/)，再运行：

   ```sh
   node scripts/start-home-relay.mjs
   ```

   如果 Mac 的 cloudflared 放在 `~/.local/bin`，使用：

   ```sh
   DSH_CLOUDFLARED="$HOME/.local/bin/cloudflared" node scripts/start-home-relay.mjs
   ```

3. 复制中继终端输出的 `wss://…trycloudflare.com/relay`。电脑浏览器在同一已登录 DSH 页面打开 `/phone-peer`（默认 `http://127.0.0.1:3080/phone-peer`），粘贴中继地址，点击「生成连接链接」，再复制 `dsh-phone://peer/connect#…`。
4. 手机 APK 点「服务 → 设备连接 → 原设备连接方式」，粘贴这个**配对链接**，点「连接并打开电脑」。连接成功后看到的对话和工作区都来自电脑；顶部「手机」可切回手机本机。

两端不用同一 Wi-Fi，可以使用手机流量。家里的电脑、DSH 和中继都需要保持在线。Quick Tunnel 是临时地址，中继重启后地址会变化，需在电脑生成新链接并重新粘贴到手机；长期固定入口见 [远程连接说明](../peer/README.md)。中继只发布密文通道，电脑的 3080 与网关 8326 不对公网开放。

## 模型与技能

- 电脑「设置 → Jet Hub → ChatGPT 会员」由本人完成授权；其他账号在 Jet Hub 配置。桌面与手机共用适配器代码，各自保存账号。
- 手机「服务 → 设备连接」可预览并同步普通 API 配置到电脑。网页登录账号不会直接复制；电脑可以通过「手机模型网关」调用手机账号，手机需保持在线并允许网关共享。
- 电脑用户技能放在 `~/.dsh/skills/<技能名>/SKILL.md`，刷新后调用。此目录在本机用户目录，安装器不会移动到云盘。
- 电脑模式的代码、目录、执行工具都在电脑上运行；手机本机模式操作手机文件。它们不是两套聊天数据库的自动合并。

## 本次验证范围

Mac arm64 已验证新 profile 安装、重装保留自定义配置、真实核心启动、浏览器认证以及账号/配对入口。其他桌面系统使用上游原生依赖，未作本项目的 Windows/Linux 实机验收。手机 Android 工具限制见主 README 的 0.1.29 说明，不能把 Android 上的沙箱限制套用到电脑。

## Agent 人设与主副卡

电脑「设置 → Agent 人设」可新建主卡、副卡并一键应用已保存组合。手机切到电脑模式后，同一设置页管理电脑上的人设。手机和电脑各自保存卡库，可通过 JSON 导出/导入传递卡片与组合；导入不自动启用。详细步骤见 [Agent 人设说明](../peer/agent-cards/README.md)。
