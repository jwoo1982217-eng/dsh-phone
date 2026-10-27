# 手机和平板 JetHub 同步（0.2.14）

本发行线把电脑版 `dac0802` 的 JetHub `dsh-providers-hub@0.2.1-rc.2` 带到手机与平板，基础上游为 `78dc506cf42bb1821a20cd4378f2b81cd8de8ded`。手机核心保持 `0.2.1-alpha.1`，不包含未完成的 rc2 核心升级。Android 基础为 `6874bc9`，另保留已验证的独立 OFM 插件保护。

## 维护和构建

当前 canonical 还有另一批核心升级 WIP；这批发布使用独立的受控构建入口，不能直接拿当前根目录 assemble 的产物当本次发行包。

先按 `docs/phone-upgrade-contract.md` 盘点、准备恢复点并登记任务目录。以下产物路径都应位于该任务的 `generated/`，依赖继续复用共享缓存：

1. 使用 `scripts/prepare-mobile-jethub-apk.py --base-apk <已验证117兼容APK> --project <任务/generated/android>` 准备必要的 Android 源码切片。脚本固定校验基础提交和 APK 完整 SHA，不接受任意同版本重打包。
2. 编译 `vendor/dsh-codearts-auth` 的 TypeScript、资源和客户端；执行 `scripts/mobile-jethub-release.py --base-apk <同一APK> --hub-source vendor/dsh-codearts-auth --stage <任务/generated/resources> --output <任务/generated/new-assets>`。
3. 把生成的两份 tar 放入隔离 Android 项目的 `app/src/main/assets/`，执行该项目的 `:app:clean :app:assembleDebug`。应用、code、资源版本分别为 `0.2.14`、`119`、`119`。
4. 交付前检查 ZIP/签名/ABI、两份 tar 的共享引用大小与 SHA、空白资料、依赖与新旧名称，以及真实 Android 升级、失败恢复和实际客户端页面。

## 实际更新范围

已安装且资源为 117、核心为 alpha.1 时，`PhoneJetHubUpgrade` 先完整验证准备资源，然后只原子替换 tree 与 phone profile 下的两处 JetHub 程序。其余插件、热补丁、私有 SDK、工作区和资料保留原位。两个名称在各自模块目录内解析到同一实体；独立同名包或其他链接会在改文件前被拒绝。

升级记录位于应用 `files/jethub-upgrades/<UUID>/`，原来的两处程序通过重命名保留。未完成的发布在下次启动先校验并恢复；用户并发修改程序时停止自动回退，避免覆盖新编辑。恢复只处理这两个程序目录和资源版本，不回写旧账号、聊天或配置。此机制针对进程中断，不把单元测试当成任意断电情况下的文件系统耐久证明。

新安装走原有完整资源准备流程。对其他旧核心或资源代际须另做盘点和兼容验证，不能据117→119的验证结论扩展。

## 手机专用签名传输

Android 下 CodeArts 继续使用独占的包内 undici 传输，保留代理选择，避免宿主包装全局 fetch 后改变签名头。其它环境维持桌面默认行为。独占传输不借用 OpenCode 代理缓存；实际签名字节、被污染的全局 fetch/dispatcher、取消、释放和出口边界由 `scripts/codearts-signed-transport.test.mjs` 验证。

## 验证边界

实际私有配置在隔离 Android UID 中进行117→119升级，包含同名冲突拒绝、重试、凭据和账号顺序、原工具代码保留与RPC失败恢复；未导出的QQ旧提示文件和外部安全运行入口只记录隔离夹具缺件，不冒称这些外部功能已在夹具执行。正式安装后还须分别核实际版本、账号、会话、MCP和界面。

模型目录和只读RPC成功不代表已向所有云端供应商完成真实推理、登录或签到；本次不为验收自动发送这些请求。

## 2026-10-21 正式设备验收

三星与联想均已同签名覆盖安装0.2.14/code119/assets119；实装base.apk SHA256均为 `fb91dee13a0268766db8b56cbe7a4bfefdb17bb47f31428165cd0f611be3be50`。Android WebView实际加载新模块，JetHub页面、ChatGPT会员、OrcaTerm以及两个国际版入口均可见。两端原有52/44会话ID全在，各12个账户顺序、引用、开关、禁用模型和供应商顺序保持；227/191份凭据、人设与记忆逐字节相同。联想一份会话日志只在原压缩字节之后追加83B `session/end-seed`，旧前缀SHA不变。

非JetHub程序分别31743/32388项保留，仅原有PhoneRuntime启动增强改写Bash超时字段一次（60000000→600000000、600000→6000000），反向去掉末尾一个零即精确还原升级前SHA；对应runtime.js本次未变。该既有非幂等问题未纳入JetHub发布修复。三星r2local、平板MT保持升级前已有的error/0工具状态，其余已有MCP工具发现保持。未实发云端模型推理、登录或签到。

设备的原两处JetHub程序恢复点分别为 `files/jethub-upgrades/e431f609-e658-41f0-b3fb-109afa3e70ce/`、`files/jethub-upgrades/0d3c493b-c744-49f2-aa4e-361ed3bccca6/`。恢复程序须按journal与当前SHA核对，不回滚当前用户资料。完整验收与构建/回退输入指纹保存在 `/Users/example/.codex/work/dsh-mobile-jethub-sync-20261021/`。
