# DSH 手机版：在 Android 手机上运行 AI 助手

这是一个 **DeepSeek Harness 的社区 Android 封装与适配项目**。它把 AI 聊天、模型账号管理、QQ 机器人、技能、长期记忆和代码工作区放进一个手机应用，让手机可以独立运行助手、管理自己的资料，并通过 QQ 接收任务。

**主项目来自 DeepSeek 官方开源的 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness)**。本仓库在官方引擎和社区插件的基础上，增加 Android 启动与后台服务、手机界面适配、账号入口、QQ 安装及扫码引导，以及手机技能和文件管理功能。

**特别感谢 Jet／iJetLi 开源 [deepseek-harness-codearts（dsh-codearts-auth / Jet Hub）](https://gitee.com/iJetLi/deepseek-harness-codearts#dsh-codearts-auth)**，为多供应商账号登录、模型接入和本机模型网关提供了基础。完整来源及许可见下方 [开源来源与致谢](#开源来源与致谢)。

当前应用版本为 **0.1.56 / versionCode 59**，包名 `com.dshphone`，支持 **Android 9 及以上、arm64**。

手机版设置窗口撑满可见区域；插件市场和 Agent 人设共用设置窗口的滚动区域。
目录在后台载入时也会更新嵌入页高度；已有本机缓存立即显示并在后台刷新，网络失败仍可搜索和浏览缓存。

**电脑版源码也在本仓库**：只安装 `desktop-runtime` 即可使用，不需要 Android SDK 或构建 APK。首次安装、旧版升级、启动快捷方式与手机链接配对步骤见 [电脑版说明](desktop/README.md)。

## 可以用它做什么

- **手机 AI 助手**：与模型对话，管理会话、模型账号和自己的文件。
- **QQ 机器人**：给机器人设置名字、性格和模型，在 QQ 私聊或群聊中向它提问、交代任务。
- **教助手做事**：导入中文 Markdown、SKILL.md 或技能 ZIP，把工作方法保存为可调用的技能；提示卡可单独编辑和启用。
- **记忆与资料管理**：通过 Noema 保存、搜索和召回长期记忆，在手机工作区整理资料。
- **代码与脚本工作**：读取、编辑、保存代码，在手机本地执行 Node.js／Bash；QQ 管理员可按界面设置开启相应执行能力。
- **手机 App 与本机工具**：复用聊天已有的“仅可查看 / 工作区内修改 / 完全权限”，无需额外批准开关。完全权限下可连续操作 MT、Reqable 等 App，截图、点击、输入、长按和滑动；Shizuku 按 App 查 Logcat，Termux 官方接口返回命令输出与退出码。首次 Android 后端权限由本人启用，详见 [手机操作插件](phone-control/README.md)。
- **在外面操作家里电脑**：0.1.55 起，顶部「电脑 → 扫码连接电脑（Pocket）」扫描电脑「设置 → 手机访问」二维码，在 App 内输入访问密码直接连接；保存地址后，下次点「电脑」即可打开。地址变化时从「服务 → 设备连接」重新扫码。普通 API 同步和手机模型网关仍使用「原设备连接方式」，详见 [远程连接说明](peer/README.md)。
- **连接自己部署的 Hermes**：「服务 → 远程 Hermes」或「设置 → 远程 Hermes」保存服务器 HTTPS 地址与连接密钥，把任务交给服务器执行，查看结果、停止任务和逐次确认服务器操作。模型在服务器上自配，跨网络使用需要可达地址。详见 [Hermes 远程接入](phone-cloud-tools/REMOTE.md)。
- **让外部 AI 使用手机工具**：「服务 → 手机工具箱」或「设置 → 手机工具箱」独立配对并选择共享技能与工具，支持 Codex、桌面 DSH、Hermes 等 MCP stdio 客户端，手机批准后本地执行并返回结果。详见 [通用接入包](phone-cloud-tools/README.md)。
- **电脑独立登录 ChatGPT 会员**：在「设置 → Jet Hub → ChatGPT 会员」管理账号，与手机版保持一致。在电脑浏览器完成官方授权后可供电脑对话及其 API 网关使用。详见 [电脑 ChatGPT 入口](desktop-chatgpt/README.md)。

DSH 的 Node.js 服务、网页界面、工作区和账号数据运行在 Android 手机本机，**日常使用无需连接家里的 Mac 或电脑**。AI 模型请求仍发送到使用者配置的云服务，需要网络和自己的账号或 API Key。QQ 登录端通过手机上的 Termux／NapCat 运行，首次使用按应用内向导完成授权和扫码。

## 第一次使用

1. **安装并打开 APK**：等待顶部显示「运行中」。本仓库提供源码，构建方法见 [构建](#构建)；已有 APK 的使用者可直接安装。
2. **配置 AI 模型**：顶部「账号」登录 DeepSeek；ChatGPT 会员在「设置 → Jet Hub → ChatGPT 会员」登录，其他供应商也在「设置 → 模型／Jet Hub」配置，再在聊天页选择模型。
3. **先在应用内聊天**：确认模型可以回复，再按需要启用技能、记忆和工作区。
4. **需要 QQ 机器人时**：进入顶部「QQ」，填写机器人与管理员 QQ 号，在「连接」页按引导授权运行环境、安装 QQ 登录端并显示二维码。机器人 QQ 在另一部手机上时，直接用那部手机的 QQ「扫一扫」扫描并确认；同一部手机可截图后从 QQ「扫一扫 → 相册」选择。
5. **设置并启动机器人**：在「性格」「群聊」里设置模型和交互方式，保存后启动。页面显示「QQ 已连接」后，用其他 QQ 账号发送消息检查回复；登录完成后二维码会隐藏，刷新按钮会停用。

## 功能详情

- WebView 中使用 DSH 聊天和 Jet Hub，设置页面适配手机宽度。
- Jet Hub 账号备份通过系统保存窗口选择手机本地目录；保留加密与明文格式，只有文件写入完成才提示保存成功，取消或失败可以重试。
- Jet Hub 提供 AutoClaw（智谱澳龙）的手机号登录、官方模型目录和积分读取。
- 顶部「账号 → DeepSeek 账号」使用官方 PKCE 授权，账号保存在各自手机。
- 「设置 → Jet Hub → ChatGPT 会员」按 OpenAI 官方 Sign in with ChatGPT 流程在系统浏览器授权，读取账号可用模型并接入现有本机网关；支持聊天和本地函数工具。当前会员接口不支持生图，详见 [ChatGPT 接入说明](phone-account/CHATGPT.md)。
- 顶部「QQ」提供连接、人设、群聊、模型、启停和导入导出界面。
- 顶部独立「技能」入口支持 ZIP、Markdown 和 TXT 自动读取，选择文件后点「导入并启用」即可；无需填写名称、用途或步骤。DSH 聊天和 QQ 共用技能，切换 API 仍可调用。
- 聊天输入框「上传」和「＋」打开同一个菜单，可选择「上传图片」「上传文件」，原有指令和工作区文件入口保留。图片支持从相册多选、预览及移除；用量弹窗适配屏幕边界并在内部滚动。
- 「上传文件」支持 UTF-8 文本、CSV 和代码文件（单个 128 KB），原文加入待发送草稿；PNG/JPG/WebP/GIF 进入原生图片附件，可预览和移除。图片分析需选择支持看图的模型。普通文档保持对话材料；技能 ZIP 和 SKILL.md 自动走技能导入，ZIP 必须包含有效的标准技能目录。导入保留原文及配套资料，不执行包内脚本。
- 技能 ZIP、SKILL.md 从「上传文件」选择并自动导入，无需单独的技能上传入口；发送草稿会加载导入的完整技能原文。其他 Markdown/TXT 可从顶部「技能」导入，或作为附件让助手通过 phone_skill_import 原文保存。消息由用户发送。
- 「技能包」支持 ZIP 检查与安装，保留脚本、参考资料及目录路径；可搜索和停用整包或单项。
- DSH Agent 在「设置 → Agent 人设」管理主卡、副卡和组合；技能中心也提供入口。旧「提示卡」开关继续管理 QQ，已有卡片会迁移到 Agent 副卡库。
- 「运行增强」提供命令超时、大文件读取、子任务深度的兼容检查、备份及恢复；可查看原包 40 项的状态。
- 手机左侧栏默认收起，点「☰ 菜单」展开，选择功能后自动关闭。
- 菜单、会话标题和模式放在同一行，输入框压缩为文本与一行工具；上传功能归入统一菜单，会员用量收进「⋯」，让出更多对话空间。
- 手机模型弹窗按输入框边界定位，名称换行、列表滚动和末尾模型选择适配窄屏。
- 手机工作区支持文本与代码导入、读取、编辑、保存和实际 Node.js/Bash 执行。
- 顶部「服务 → 文件访问权限」可授权共享存储访问；授权后聊天「添加工作区」默认打开手机存储，可选择下载、文档、SD 卡等可访问目录。未授权时保留内部工作区与手机存储入口，授权后重新打开目录选择即可，无需重启服务。安卓仍限制其他应用私有目录及 Android/data、Android/obb；电脑模式的工作区选择对应电脑文件夹。
- 设置补齐 Noema 记忆；Jet Hub 手机端保留供应商图标卡片。
- 模型网关地址为 `http://127.0.0.1:8326/v1`，聊天界面为 `http://127.0.0.1:3080`。
- 兼容旧版 WebView 缺失的 AbortSignal.any／timeout；兼容脚本在客户端模块之前加载。
- 系统文件选择器通过 ACTION_OPEN_DOCUMENT 获取所选文件的读取授权，支持未知 MIME 类型的 Markdown；无需“所有文件访问”权限。
- 程序升级保留已有手机账号、设置和聊天记录。
- 「服务 → 备份与恢复」提供原生快速备份、最近两份环境恢复及撤销上次恢复；网页启动失败时也可进入。恢复保留最新账号、对话、人设卡、配对及工作区资料，详见 [备份与恢复说明](docs/phone-recovery.md)。
- 「设置 → 插件市场」可搜索 dsh-market 使用的社区目录，手机端提供主动开启的「允许试装」，安装前自动备份；安装失败恢复环境，使用后不合适可从原生恢复页撤回。固定 NPM 版本或 GitHub 提交，已知平台/SDK 冲突及内置核心覆盖仍会拦截。电脑目标单独显示，在卡片中检查并确认安装固定版本，无需终端，详见 [受控市场说明](peer/controlled-market/README.md)。

## 配置机器人和模型

参考 [通用 QQ 配置模板](phone-qq/qq-config-template.json)，填写自己的机器人 QQ 号、
管理员 QQ 号、群号、OneBot WebSocket 地址和连接令牌，再从 APK 顶部「QQ」导入。
本仓库不包含维护者的 QQ 号码、私人令牌、模型密钥、聊天记录或工作区数据。

首次使用可在「QQ → 连接」中按三步引导授权手机运行环境、安装并启动 QQ 登录端、显示并扫描 QQ 登录二维码。安装向导使用已安装的官方 Termux 和 NapCat 官方脚本，自动填写本机连接地址和令牌。Android/Termux 权限及 QQ 扫码由使用者自己确认。QQ 登录端装好后与 DSH 一起在手机运行；网络模型仍需要联网。

「群聊」里的代码执行开关只对管理员私聊生效，默认关闭。管理员开启后可让机器人运行 Node/Bash、改文件和联网；群聊和非管理员私聊保持原工作区权限。安卓受限命令沙箱取决于内核 Landlock 支持，详见 0.1.29 说明。技能和记忆是持久保存方法与经验，不会自动重训模型权重。

模型 API 密钥在「设置 → 模型」填写。回聊天页选择模型后，停止并重新启动机器人。
`groupModel` 两项为 `null` 时群聊跟随 DSH 默认模型；显式填写时仅覆盖群聊，私聊仍使用默认模型。
OneBot `accessToken` 用于 QQ 连接鉴权，不是模型 API Key。

详见 [QQ 导入说明](phone-qq/README.md) 和 [DeepSeek 账号说明](phone-account/README.md)。

## 技能包

源码仓库不附带用户提供的第三方技能 ZIP。使用者可从「技能」导入自己的压缩包或文档；自动读取并启用，不需要填写手动编辑表单。单包最多 24 MB／512 个技能；导入保留附件而不运行安装器。需要制作包含个人技能资料的 APK 时，可先运行 `python3 scripts/prepare-skill-pack.py /path/to/pack.zip`，再生成资源和构建。生成的 `phone-qq/private-skill-pack.zip` 已排除在版本控制之外，分发第三方资料前请核对其许可。

把同一份技能库加入桌面 DSH，可运行 `node scripts/install-desktop-skills.mjs /path/to/pack.zip "$HOME/.dsh/skills"`。保留配套目录；两个同名版本另存，已有目录不覆盖。提示卡和运行补丁不会由这个桌面导入命令自动启用。

手机版启动前只应用已选择且匹配的 3 个运行增强。原包的全局审批放行、文件围栏移除和第三方 hooks 改写未应用；执行权限使用已有个人会话及 QQ 管理员私聊预设。所有 40 项的状态显示在界面中，不能将“可管理提示卡”视作原源码补丁已写入。

## 源码目录

| 路径 | 内容 |
| --- | --- |
| `app/` | Android 壳、后台服务、启动逻辑、手机 CSS/JS |
| `phone-account/` | 独立账号授权、Messages 适配与离线测试 |
| `phone-control/` | DSH 手机操作工具、JSON CLI 与 Android 原生授权桥接协议 |
| `phone-cloud-tools/` | 通用手机工具箱、MCP 连接器、中继与可选 Hermes 远程聊天 |
| `phone-qq/` | 脱敏模板、配置检查、机器人启停与离线测试 |
| `peer/` | 加密中继、电脑远程界面、手机网关与 API 配置同步 |
| `desktop-chatgpt/` | 电脑 ChatGPT 会员登录入口，复用官方会员适配器 |
| `vendor/dsh-channel-qq/` | QQ 插件源码及对应编译代码，无私人配置 |
| `vendor/dsh-codearts-auth/` | Jet Hub 插件源码及新版 SDK 的 RPC 兼容修复 |
| `runtime/` | 固定版本依赖、Android 兼容桩与启动兼容源码 |
| `home-template/` | 空白 phone profile，中文界面，无账号数据 |
| `scripts/` | 可移植资源生成与个人配置导出脚本 |

## 构建

需要 JDK 17+、Android SDK 36、Python 3、Node 22.19+ 或 24+、pnpm 10+。
本仓库发布源码，不包含从其他 APK 提取的原生二进制或已有安装包。
先准备具有合法来源的 Android/Bionic arm64 Node 可执行文件及其依赖库，
Bash 和 Noema 的固定来源、许可证与重建脚本见 [原生引擎说明](native/README.md)。
将 Node 可执行文件命名为 `libnode.so`，放入 `app/src/main/jniLibs/arm64-v8a/`。
此处需要可直接执行的 ELF，而不是仅用于 `dlopen` 的 Node 共享库。

```sh
git clone https://github.com/jwoo1982217-eng/dsh-phone
cd dsh-phone
cd runtime
pnpm install --frozen-lockfile --ignore-scripts
cd ..
python3 scripts/prepare-native.py
# 安装 Rust 和 NDK r28c 并设置 ANDROID_NDK_HOME 后：
python3 scripts/build-noema-android.py
python3 scripts/build-flock-android.py
python3 scripts/build-landlock-android.py
python3 scripts/build-assets.py
# 设置 ANDROID_HOME / JAVA_HOME，或创建自己的 local.properties 指定 sdk.dir。
./gradlew :app:clean :app:assembleDebug
```

编译结果在 `app/build/outputs/apk/debug/app-debug.apk`。
生成资源后才执行 Gradle，不要在 tar 写入期间同时打包。交付 APK 使用 clean 构建，避免增量 ZIP 保留旧资源区块导致文件体积虚增。
资源有变动时增加 `NodeRunner.ASSET_VERSION`；不要删除使用者的整个 `dsh-home`。

Android 不能加载桌面的 koffi、node-pty、sharp 原生版本，因此当前运行时使用兼容桩。
终端、部分原生图片和语音工具需要另行提供 Android 实现，不能仅凭网页相同视为可用。

## 验证

```sh
node --test phone-account/*.test.js phone-qq/*.test.js scripts/*.test.mjs peer/*.test.mjs
```

测试覆盖授权、Messages 传输、机器人生命周期、Android 会话创建、ZIP 检查、技能加载、提示卡和运行增强。实际技能包解析测试需通过 `DSH_TEST_SKILL_ZIP=/path/to/private-skill-pack.zip` 提供资料；未提供时该项跳过。2026-10-04，0.1.15 的账号、QQ、自动文件导入和 Android 会话测试共 75 项全部通过（提供技能测试包）。393px 窄屏实际页面验证了文档上传进入聊天草稿、图片附件预览、无表单技能导入、旧 WebView 兼容和侧栏收起；未在验证时发送付费模型请求。实机已确认 QQ 登录和机器人连接，真实消息回复及持续后台运行需另行验收。
0.1.3 修复 Android 的 `EACCES: permission denied, link`：完整写入并同步临时会话目录后原子移动，
并发创建不会覆盖旧日志，失败时清理临时目录；聊天记录格式保持不变。另有模拟 OneBot 验证。
0.1.4 修正 DeepSeek 账号聊天的 Messages 地址为官方 `/anthropic/v1/messages`，解决旧地址的 HTTP 404；地址依据 [DeepSeek 官方 Messages 文档](https://api-docs.deepseek.com/guides/anthropic_api/)。
2026-10-03 已在 Android 实机覆盖升级并保留账号和会话；本机请求 HTTP 200、完整流式回复通过，
聊天页面连续两轮消息均正常回复。QQ 真实收发和后台持续运行仍需分别验收。
0.1.5 的 Android 原生 Bash 已通过脚本输出和文件写入检查，原生 Noema MCP 已通过初始化、写入、搜索和召回检查；手机 QQ 登录端的首次环境授权、安装和 QQ 登录仍由使用者按向导完成，不能据模拟 OneBot 连接宣称真实 QQ 已登录。
0.1.6 已在 Android 实机覆盖安装并完成资源升级，账号保留；实际手机服务读取到 151 个技能、12 张提示卡和配套资料，长任务及大文件增强已写入。393 px 浏览器预览验证模型菜单完整显示、滚动及末尾选项选择；此项是窄屏预览，不是手机截图。

0.1.7 修复新版 PRoot-Distro 将列表输出到标准错误流导致重复创建已有容器的问题。安装向导复用新旧存储布局中的已有环境，通过容器内部写入并备份 QQ 配置；环境无法启动时保留数据并停止。安装入口也会先准备缺少的 curl。

0.1.8 为每次 NapCat 安装创建独立临时工作目录，避免上次残留的 `./NapCat` 触发上游保护检查；已有解压目录和容器保留。回归测试验证连续重试使用不同目录且旧文件不变。

## 开源来源与致谢

感谢 DeepSeek 官方及各社区项目的作者和贡献者开放源码，让这份手机适配可以建立在已有成果上。

| 上游项目 | 本项目使用的基础与致谢 | 来源及许可 |
| --- | --- | --- |
| **DeepSeek 官方 DeepSeek Harness** | AI 助手主引擎、聊天界面、插件体系与账号协议；感谢 DeepSeek 开源 DSH。本项目固定使用 `@deepseek-ai/dsh@0.2.1-alpha.1` 预览版。 | [官方源码](https://github.com/deepseek-ai/deepseek-harness) · [官方文档](https://deepseek-harness.github.io/deepseek-harness/) · MIT；[保留的许可](phone-account/vendor/LICENSE.deepseek) |
| **Jet／iJetLi：deepseek-harness-codearts** | `dsh-codearts-auth`／Jet Hub 的多供应商登录、模型接入及网关；感谢插件作者和贡献者。本仓库保留上游源码，并加入手机适配和兼容修复。 | [插件项目与使用说明](https://gitee.com/iJetLi/deepseek-harness-codearts#dsh-codearts-auth) · MIT；[保留的许可](vendor/dsh-codearts-auth/LICENSE) |
| **ZSeven-W：dsh-noema／Noema** | DSH 长期记忆插件和记忆引擎；感谢 Noema 的开源实现。 | [DSH 插件](https://github.com/ZSeven-W/dsh-noema) · [记忆引擎](https://github.com/ZSeven-W/noema) · MIT；[保留的许可](vendor/dsh-noema/LICENSE) |
| **Termux 与 NapCatQQ** | 手机 Linux 运行环境与 QQ 登录／OneBot 连接；感谢相关项目提供手机 QQ 登录端所需的基础。NapCat 由使用者按向导安装。 | [Termux](https://github.com/termux/termux-app) · [NapCatQQ](https://github.com/NapNeko/NapCatQQ) · [NapCat 安装说明](https://napneko.github.io/guide/boot/Shell) |

QQ 通道移植所保留的来源许可见 [OpenClaw 许可](vendor/dsh-channel-qq/LICENSE.openclaw)。Noema、Bash 及其依赖的固定版本、重建方法和 GPL／LGPL／MIT 等许可见 [原生引擎说明](native/README.md)；APK 内保留对应许可。各组件按各自上游许可使用和分发，原作者的版权与许可声明继续保留。

### 0.1.9：QQ 安装包下载修复

安装前先校验 QQ Debian 包及 ARM64 程序。官网失效时，自动提取 NapCat 官方 ARM64 镜像中固定 SHA256 的 QQ 资源，仅提取 `opt/QQ`，不运行 Docker。下载失败自动重试，完整 SHA256 校验后继续安装；失败时保留原 QQ 环境和配置。安装器按实际 QQ 版本运行，不再使用失效的 50828 下载地址。资源版本为 13。

### 0.1.10：AutoClaw 账号入口

Jet Hub 增加 AutoClaw (智谱) 图标卡片。点击「+ 新建账号」后直接填写自己的手机号和短信验证码；无需依赖电脑上的 AutoClaw。登录成功后读取该账号的官方模型目录和积分，支持账号去重、自动续期及模型开关。ZCode 入口保留。操作与实现边界见 [AutoClaw 说明](vendor/dsh-codearts-auth/docs/autoclaw.md)。

验证码不写入本地存储；公开源码不含个人手机号、账号令牌或验证码。该入口已做离线协议与消息测试，真实短信登录和模型调用仍需使用者完成。新版首次打开会更新资源（ASSET_VERSION 14），保留原账号和会话。

### 0.1.11：QQ 解压兼容修复

修复部分手机 Linux/PRoot 中 GNU tar 在恢复目录权限时报告 `Cannot change mode: No such file or directory` 的解压失败。安装包校验和 NapCat 正式安装都改为 Python 的安全数据解压；保留 ARM64、版本、大小与路径检查，QQ 可执行权限单独设置。当前官方安装脚本的解压命令不匹配时停止安装，已有目录与配置备份保留。

新包保留 AutoClaw 接入。首次重新打开更新资源到 ASSET_VERSION 15；然后在「机器人 → 连接 → ②安装并启动 QQ 登录端」重试。现有 Linux 容器继续复用，QQ 的首次真实启动与扫码仍需使用者完成。

0.1.14 在机器人连接页直接显示 QQ 登录二维码与扫码、确认、初始化和在线状态，提供刷新及连接按钮。管理令牌不会进入二维码状态响应。包名调整为 `com.dshphone`；Android 将包名变化视为独立应用，已有数据需要迁移。

手机技能导入支持普通中文 Markdown，自动识别标题、用途和调用标识，保留正文；名称可以使用中文，标准 SKILL.md 继续兼容。

0.1.15 新增聊天「上传」和独立「技能」入口：普通文档／图片用于本次分析，技能文档／ZIP 自动读取并持久保存，共用技能库跨 DSH 和 QQ 使用。修复旧 WebView AbortSignal 兼容及系统文件授权；手机侧栏默认收起。

0.1.16 修复聊天「投喂技能」选择 ZIP 时缺少上传处理的问题，支持在聊天入口直接导入整个技能包。

## 0.1.18：Jet Hub 对话网关兼容

AutoClaw 的普通 OpenAI 请求自动补充接口要求的客户端前缀，保留用户的系统提示词和消息，修复缺少前缀造成的 HTTP 406／网关 502。网关遇到明确的额度用尽、未登录和限流错误时保留具体原因与对应状态，不再统一包装成 502。账号没有某个模型的可用权益时，仍需等待额度恢复或使用有权益的模型。

AutoClaw 与网关专项测试 139 项通过。更新资源版本 23，保留现有账号、会话、技能和机器人配置。

## 0.1.20：ChatGPT 会员加入 Jet Hub

修复上一版会员账号入口只在顶部、没有出现在 Jet Hub 列表的问题。Jet Hub 新增「ChatGPT 会员」卡片，直接管理登录、账号与工作区切换、退出和官方模型列表。授权仍在系统浏览器完成，返回后更新面板。顶部「账号」恢复为 DeepSeek 入口，两套账号互不覆盖。

资源版本升为 25，升级保留已有账号、会话、技能和机器人配置；模型调用沿用 0.1.19 的官方接入。

## 0.1.19：ChatGPT 会员官方接入

顶部「账号 → ChatGPT 会员」通过系统浏览器完成 OpenAI 官方授权，返回 DSH 后读取当前账号的可用模型。新模型接入现有网关，支持普通／流式聊天及本地函数工具；模型选择旁显示会员方案用量来源与管理链接。账号授权、旋转续期和退出相互隔离，升级资源到版本 24，保留原有账号、会话、技能和机器人配置。

45 项离线测试与 Android 编译通过，真实账号授权和模型回复仍需安装后测试。当前会员接口不支持生图；使用说明及官方依据见 [ChatGPT 接入说明](phone-account/CHATGPT.md)。

## 0.1.23：两端接入官方新功能

修复手机软键盘挡住输入框：键盘打开时输入框和发送按钮留在键盘上方，手机本机和电脑模式都适用。请覆盖安装新版 APK，保留原账号、配置和配对。两端核心和远程事件协议须一起升级。

手机和电脑统一使用官方 DSH `0.2.1-alpha.1`（仍为预览版）。新增模型搜索、草稿保留、文件/目录/会话引用、让智能体创建插件、自动化任务面板和异步问答。问答默认等待 120 秒，之后可稍后回答；权限确认仍遵循原有许可流程。

电脑侧栏「自动化任务」可管理定时任务，手机独立模式的菜单也有相同入口；电脑模式看到的是电脑的任务。定时执行要求对应设备的 DSH 服务继续运行。插件入口可让 AI 创建插件，需要时切换创作模式。未创建任何实际定时任务。

外网展示地址使用官方 `dsh web --public-url https://你的入口/`，需配合已有反向代理及相应 trusted-host 配置。该选项不自动申请域名或中继，手机现有加密配对链接继续使用。

桌面运行时：在 `desktop-runtime/` 执行 `pnpm install --frozen-lockfile --ignore-scripts`；随后运行 `node scripts/install-desktop-upstream.mjs <电脑项目目录> <DSH_HOME/profiles/web>`。安装器保留原插件源码与恢复入口。升级前应备份 DSH_HOME；会话格式由官方迁移器读取。

## 0.1.24：修复旧手机配置升级后无法启动

旧版手机 profile 内的官方 SDK 副本会遮住新版运行库，造成插件版本冲突和缺少导出的启动错误。启动前将自带官方模块入口同步到当前程序树，保留旧程序备份、用户插件、账号、会话与配对信息；迁移失败时停止启动并保留原数据。资源解压串行执行，防止重复启动时互相覆盖。

会话恢复和模型切换使用 Android 原生文件锁：将官方 Node-API flock 绑定编译为 Bionic/arm64 库并随 APK 安装，保持内核独占锁、进程退出自动释放和冲突拒绝的行为。修复切换模型时 `flock is not supported on android-arm64` 报错。

会话首次保存和旧日志升级使用 Android `renameat2(RENAME_NOREPLACE)` 原子发布，保留现有文件锁的 inode，不依赖安卓禁止的硬链接，也不覆盖已有日志。

安卓打包按依赖声明的 `os` / `cpu` 筛掉其他平台的原生包，移除误带入的 macOS LibreOffice、语音识别等文件。桌面运行时继续保留本机依赖。覆盖安装 APK 即可，不要卸载或清除应用数据。

远程加载适配新版合并插件脚本地址：静态回复压缩、扩大有界传输窗口，小文件合并到首个回复中；完全相同修订的脚本可从手机本机读取。官方账号说明脚本含大段图片，两端 SHA-256 相同的程序内容无需重复传输，手机重建后再核验整个电脑脚本的长度和 SHA-256；不匹配时完整下载。API 和任务事件仍从电脑读取。

## 0.1.25：蓝色鲸鱼应用图标

启动器与安装界面改为白底、DeepSeek 蓝色鲸鱼，适配圆形、圆角方形等系统图标形状，并提供 Android 13 及以上的主题单色层。鲸鱼轮廓来自 [DeepSeek Harness 的图标素材](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.1/apps/desktop/resources/icon.svg)，沿用上游 MIT 许可并保留来源；应用名称继续为「DSH 手机版」。本次仅更新 Android 图标和应用版本，不触发运行时资源升级。

## 0.1.26：补齐共享依赖目录的升级迁移

旧版本的官方 SDK 也可能存在 `profiles/node_modules` 或 home 根的 `node_modules` 中。启动前同时检查这两层和当前 phone profile，备份并迁移自带官方模块，避免旧 SDK 与新版运行库混用。用户插件、账号、会话和设置保留，现有实际依赖目录不会被整体替换；同一目录的多个链接入口只处理一次，旧的失效 SDK 链接可恢复。

打包和启动都校验自带 DSH SDK 的版本一致性，不给旧插件添加兼容性豁免。迁移输出写入临时私有文件后读取，避免大量输出阻塞启动；启动页显示应用与资源版本，日志显示 SDK 检查结果。覆盖安装本版后，资源版本 30 会更新程序并自动执行迁移。

## 0.1.27：修复目录别名导致的空迁移结果

Android 上 `/data/data` 和 `/data/user/0` 等路径可能指向同一应用目录。Node 会解析模块路径，而启动参数保留原路径，旧入口判断因此可能跳过迁移并返回空内容。现在比较实际文件路径，首次安装和升级都会执行检查；空输出和错误报告也会显示明确的启动阶段错误。

资源版本 31 会更新修复后的脚本。新增目录别名下的首次安装、升级和校验失败回归，以及使用实际 `NodeRunner`、应用私有目录、原生 Node 和绝对路径的独立 Android 启动测试。覆盖安装即可，账号与对话无需清除。

## 0.1.28：修复 ChatGPT 调用工具后无法继续

ChatGPT 会员流式接口有时在逐条发送完整输出后，用空输出列表结束请求。现在保留这些已完成的工具、文字和加密思考记录，后续请求能正确关联工具调用与结果，避免工具执行后报 400。已有对话中的空重放记录从原消息重新构建，不修改历史消息；手机与电脑安装器共用同一适配器。

新增空结束列表、连续工具调用、文字回复及旧对话恢复回归。真实 Android 手机上的同账号两步工具请求已验证；资源版本 32 会更新程序，覆盖安装保留账号、会话与配对。AutoClaw 返回的 500 属于另一条供应商请求，不能由此修复保证消除。

## 0.1.29：Android 文件搜索、命令授权与黑鲸鱼图标

打包 Android/Bionic 原生 ripgrep 15.2.0 和 PCRE2，文件搜索从 APK 原生目录启动，不再尝试加载不存在的 Android npm 平台包。支持中文文件名、含空格目录、隐藏文件和内容搜索。新文件发布使用原生 `renameat2(RENAME_NOREPLACE)`，保留并发创建保护，避免 Android 禁止硬链接导致创建失败。

命令执行使用 APK 自带 Bash。新增原生 Landlock 启动器与实际隔离能力探测：支持的系统按会话只读／工作区权限执行，不能隔离的系统拒绝执行，绝不自动切换完整访问。此时 AI 优先使用文件工具；确需命令时，通过现有审批渠道申请单次 Android 应用权限，确认中说明命令可访问 DSH 已获系统权限的目录，授权不改变会话权限。文件工具的只读／工作区限制继续生效。三星 Android 16 测试机的内核未开放 Landlock，这是系统能力限制，不能称为已实现工作区命令隔离。

「服务 → 工具环境」检查实际 Bash、搜索程序和命令沙箱状态。APK 图标改为白底黑色 Harness 鲸鱼，兼容普通、自适应和主题图标。资源版本 33；请覆盖安装，保留账号、对话、技能和电脑配对。

## 0.1.30：修复部分手机模型设置页空白

部分 Android WebView 没有 `Array.prototype.toSorted`，模型设置和模型选择器会在排序时中断，界面只剩标题和 API 密钥说明。兼容层现在补齐排序方法，并补齐聊天历史、用户问题和授权窗口实际使用的 `findLast`、`findLastIndex`、`Promise.withResolvers`；已有原生实现保持不变。本机页面和手机访问电脑的页面在加载客户端之前使用同一兼容层。

资源版本 34；请直接覆盖安装，账号、对话、技能、API 配置和电脑配对继续保留。验证包含缺少浏览器方法时的上游模型加载失败复现，以及修复后的配置列表与自定义 API 添加入口。


## 0.1.31：统一上传入口与 Android 图片处理

输入框「上传」和「＋」打开同一菜单，只列「上传图片」和「上传文件」。从文件入口选择标准技能 ZIP 或 SKILL.md 时自动走技能导入，保留参考文件；普通文本进入待发送草稿。上传、导入都不会自动发送消息。Jet Hub 用量弹窗按可见屏幕定位，内容可独立滚动。

Android 图片处理改用同一应用 UID 下的私有 Unix socket，调用系统 ImageDecoder 和 Bitmap 编码器，取代只能导入的 Sharp 占位桩。支持 PNG、JPEG、WebP、GIF，按 EXIF 调整方向、转为 sRGB、去除附加元数据，保留透明度，并为模型请求生成压缩版本。文件选择器或剪贴板的 MIME 不正确时，先根据图片字节识别标准格式；原有大小、像素和格式校验继续生效，不支持任意格式。

附件保存在应用私有目录，目录同步以 Android 创建的 files 目录为边界；使用原生 renameat2(RENAME_NOREPLACE) 发布，避免访问系统父目录或使用被 SELinux 禁止的硬链接。保持摘要校验、并发去重及拒绝覆盖损坏对象。资源版本 35；覆盖安装保留账号、对话和配对。

电脑调用手机模型网关时，保留上游流式错误码和原因，避免误报为空回复；缓存 token 与输入 token 的统计按各端接口口径转换。供应商自身返回的 500／502 仍需按错误内容排查。

图片实机验证使用独立测试应用、生成图片和临时目录，不接触使用者的账号或对话。需要 Pillow、已连接的 Android arm64 手机，以及构建 APK 所需的环境：

```sh
python3 scripts/build-assets.py
python3 scripts/test-android-images.py --serial YOUR_DEVICE_SERIAL --adb /path/to/adb
```

测试覆盖普通手机分辨率截图、EXIF 旋转 JPEG、透明 WebP、动画 GIF、16 位 PNG、模型请求缩放、重复上传、文件别名、格式不匹配及损坏文件拒绝。测试结束卸载独立测试应用。

## 0.1.32：本机回复同步与页面恢复

Android 浏览器有时会报告互联网离线，即使手机本机服务仍能接收消息。此前这个提示会暂停实时连接的重试，导致消息已发送、AI 已回复，但页面停在旧消息。现在本机回环地址以实际连接结果判断可用性并持续按退避策略重连，其他远程网页仍遵循离线提示。

页面从浏览器缓存恢复时重新建立实时连接；回到前台时恢复已经断开的连接。恢复只读取已有会话，不自动重发用户任务。资源版本 36，覆盖安装保留账号、API 配置、对话和电脑配对。

```sh
node --test scripts/client-connection-recovery.test.mjs
```

## 0.1.33：Agent 主副人设卡

手机与电脑版新增「设置 → Agent 人设」入口，支持新建/编辑主卡、副卡，保存组合并一键切换，JSON 卡库及 Markdown/TXT 正文导入。原手机提示卡迁移到副卡库，正文与启用状态保留；QQ 和子智能体自己的角色保留。手机导出使用系统文件保存器。完整使用说明见 [Agent 人设说明](peer/agent-cards/README.md)。

## Preset 广场与插件管理

设置中新增 7 套工作流和 9 个技能；在新对话中选择 Preset。电脑可预检查固定 NPM 版本后安装/更新、启停和卸载插件；手机安装沿用原生备份试装，增加实际清单管理。飞书可在广场配置，图像/视频依赖缺失时显示限制并支持进入已连接电脑处理。详情见 [工作流与插件说明](peer/workflow-hub/README.md)。

## 云端大脑与手机本地工具集（0.1.42）

手机设置中的「云端工具集」（0.1.44 起名为「手机工具箱」）通过独立加密配对提供15项 MCP 工具。任务在手机批准，写文件与可信脚本逐次批准，App继续原生授权；断线撤销任务。默认关闭，技能/工具按选定范围共享。连接器与中继说明见 [phone-cloud-tools/README.md](phone-cloud-tools/README.md)，运行 `node scripts/build-cloud-tools-package.mjs` 生成通用接入 ZIP。可信脚本拥有 App UID 权限，任务目录不构成操作系统沙箱。

### 0.1.44 通用手机工具箱

「服务」与「设置」提供手机工具箱，原有配对和授权设置保留。通用接入包附带 Codex、桌面 DSH、Hermes 和其他 MCP stdio 客户端配置示例；真实桌面 DSH MCP 插件已在隔离环境执行本地示例、生成文件并通过未批准/重复执行/撤销恢复检查。配置样例与兼容测试不代表已接通使用者的手机或完成真实模型调用。


### 0.1.46 手机工具与设置布局

手机操作复用现有会话的三种权限。完全权限可直接操作 App 和运行已接入的 Termux 命令，无需再开启连续控制或逐步批准；查看与工作区模式保留观察能力。新增界面截图、长按、按 App 读取 Shizuku Logcat 和 Termux 输出、错误及退出码，详见 [手机操作插件](phone-control/README.md)。

手机版设置固定占满可用屏幕，顶部选项横向滚动，内容独立滚动，修复远程 Hermes、手机工具箱和插件市场收缩成空白横条。键盘出现时使用可见视口高度。资源版本 49，覆盖安装保留账号、配置、角色卡、对话和经验库。

### 0.1.47 已安装宠物插件的任务接口适配

`whale-girl@0.1.0` 安装后可能因调用已不存在的 `jobs.onJobDone` 而启动失败，网页无法取得宠物状态和动画资源。启动预检查为已核对源码的这一版本适配当前 `jobs.events` 终态事件，任务列表按会话 ID 查询。完成和失败各记账一次，取消保持中性，关闭页面期间仍可记录。互动菜单按可见视口选择宠物上方或下方并限制位置，避免贴底或贴边时喂食按钮跑到屏幕外。

适配限定 SDK `0.2.1-alpha.1` 与已核对的插件源码哈希；修改前保存原文件，其他版本、个人修改或无法确认的文件保留原样。更新不自动安装宠物。资源版本 50，覆盖安装保留用户数据。上游插件见 [whale-girl](https://github.com/vlln/whale-girl)。

### 0.1.48 Jet Hub 同厂牌多账号轮换

在同一厂牌面板连续点击“添加账号”，完成各账号自己的授权。两个以上可用账号时，每次模型请求按列表顺序循环使用；账号停用、对应模型限流或凭据不可用时跳过。设置页和模型列表的读取不占用轮换顺位；同一次请求的凭据续期保持当前账号，并发请求分别选号。原有永久积分锁定继续限制哪些账号可用，免费模型沿用原有判定。

ChatGPT 会员可添加多个账号或工作区，轮换时只使用已授权且官方目录支持所选模型的连接。已输出内容的流失败后不会换账号重放；请求开始前明确限流或账号失败时可换下一连接。设置页下拉框只切换查看与管理的连接。轮换顺位在进程内维护，重启后从列表起点重新开始；两台设备的账号和顺位各自独立。


## 0.1.54：MCP 调度与独立浏览器

新增「设置 → MCP 服务」和「服务 → 内置浏览器」，接入 DSH 自己的模型探针、自动派单与子代理复用；保留手机操作、文件、Termux、工作流和记忆隔离。与 Operit 的已具备能力和剩余差距见 [功能与使用说明](peer/mcp-manager/README.md)。资源版本57，覆盖更新保留个人数据。


## GitHub 公开版的 Gemini OAuth 配置

本公开版本移除了内置 Google OAuth 客户端 ID 和密钥。使用 Gemini 浏览器授权前，请在启动环境配置自己的 `CMDC_PAK_GOOGLE_CLIENT_ID` 与 `CMDC_PAK_GOOGLE_CLIENT_SECRET`；其他供应商不受此配置影响。不要将实际值提交到仓库。配置方式见 [公开版配置说明](docs/github-public-config.md)。
