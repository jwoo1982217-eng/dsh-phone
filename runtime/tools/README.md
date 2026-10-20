# 手机插件安装工具

`pnpm/` 是 pnpm 10.34.6 的官方 npm 发布文件。下载来源、版本和完整性校验见 `pnpm/SOURCE.json`，MIT 许可证见 `pnpm/LICENSE`；其依赖许可证保留在发布文件中。

APK 内置该固定版本，通过内置 Node 执行 `dist/pnpm.cjs`，不依赖用户安装 Termux 或电脑 pnpm。试装由原生服务先停止本机 DSH、备份环境后运行。安装使用独立目录、固定发布包、禁用生命周期脚本和 pnpmfile，核心 SDK 复用 APK 已提供的模块。可运行的 JavaScript 插件支持试装；需要桌面程序、其他架构或额外构建环境的插件会给出安装失败原因，并恢复备份。
