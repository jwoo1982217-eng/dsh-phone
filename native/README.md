# 原生引擎来源

Node/Bionic 按主 README 单独准备。本仓库不存放原生二进制。

- Bash 5.3.20、Readline 8.3.6、libiconv 1.19、ncurses 与 libandroid-support：来自官方 Termux 软件仓库。固定版本和完整 SHA256 位于 `termux-packages.json`。`python3 scripts/prepare-native.py` 校验软件包后提取二进制，再将依赖名称改成 Android 可提取的 `.so` 名称。不会运行 deb 的安装脚本。
- ripgrep 15.2.0 与 PCRE2 10.49：同样来自官方 Termux 软件仓库，包 SHA256 固定在 `termux-packages.json`，分别安装为 `libdshrg.so` 和 `libpcre2-8.so`。对应源码为 [ripgrep 15.2.0](https://github.com/BurntSushi/ripgrep/tree/15.2.0) 与 [PCRE2 10.49](https://github.com/PCRE2Project/pcre2/tree/pcre2-10.49)，APK 保留 MIT／BSD 许可。
- Landlock：`landlock-run.c` 源自自带 `@deepseek-ai/node-addon-system@0.1.2/src/main.c`；源包的许可文件保留于 `landlock-LICENSE.txt` 并打包。Android 版本要求至少 ABI 3，不能阻止截断的旧 ABI 不执行命令。使用 NDK r28c / API 28 编译；没有 Root、没有关掉系统保护，未开放 Landlock 的内核会返回不可用。
- 对应 Termux 构建源码：commit `27da60be397a6e9eb898bba8d03bcd648782ccd5`，https://github.com/termux/termux-packages/tree/27da60be397a6e9eb898bba8d03bcd648782ccd5 。各包的 `packages/<name>/build.sh` 保留原始源码地址、校验值、补丁和构建参数。APK 内保留 GPL、LGPL 和 MIT/Apache 许可；再分发 Bash 时应随包提供对应源码及这些修改脚本。
- Noema MCP：MIT，https://github.com/ZSeven-W/noema ，固定 commit `3db09452958dedf25aaeed3b445f40ac7054d8be`。Rust target `aarch64-linux-android`，NDK r28c / API 28。设置 `ANDROID_NDK_HOME` 后运行 `python3 scripts/build-noema-android.py`。Android 版本关闭 noema-core 的可选 S3 默认功能，本地记忆功能保留。
- Noema DSH 插件：MIT，`@zseven-w/dsh-noema@0.1.0-rc.1`，https://github.com/ZSeven-W/dsh-noema ，源码及编译 JS 位于 `vendor/dsh-noema`。手机分支使用 `DSH_PHONE_NOEMA` 指定 APK 原生目录的引擎；移除了桌面平台的可选二进制依赖。

NapCat 不随 APK 捆绑。手机安装向导调用其官方安装脚本，使用者在自己的手机授权 Termux、登录自己的 QQ。相关入口：https://napneko.github.io/guide/boot/Shell 。
