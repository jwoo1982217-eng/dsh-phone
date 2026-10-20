# OpenCode 本机运行组件

JetHub 的 OpenCode 使用原生 serve API，由 DSH 启动本机服务。模型目录读取 `/provider`，推理经 `/session` 与 `/session/{id}/message`；不会把本机地址当 OpenAI 的 `/v1` 地址。

OpenCode 官方版本固定为 1.19.2。原生二进制与 Alpine musl/GCC 运行库的来源、归档哈希、成员和最终字节哈希见 `opencode-runtime.json`。构建只提取指定普通文件，不执行 npm 或 Alpine 安装脚本。许可证原文及来源保留在 `opencode-licenses` 并随安装包交付。

Mac arm64：

```sh
python3 scripts/prepare-opencode-native.py --target darwin-arm64
```

Android arm64：

```sh
python3 scripts/prepare-opencode-native.py --target android-arm64
```

手机的 Linux musl 程序通过随包 musl 加载器运行，不能直接把 Linux 程序当 Bionic 程序执行。APK 保留原始字节并由系统解压到 nativeLibraryDir。动态库别名只在 DSH 自有私有目录创建符号链接。

托管服务仅监听 loopback，访问密码由 DSH 凭据服务保存，运行状态位于 DSH_HOME/opencode-local；服务重连不会杀死其他应用启动的 OpenCode。每次请求使用独立临时配置并落实模型输出上限。DSH 工具通过仅本次请求有效的本地 MCP 连接生成调用，交回 DSH 权限与执行管线；OpenCode 的内置 bash/read 不能绕过这条管线。

仅目录中明确输入/输出价格均为零的模型列入免费清单。模型可见不代表服务商保证当前地区和额度可调用，失败保留上游原因。
