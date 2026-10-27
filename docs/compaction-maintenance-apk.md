# 0.2.15 压缩修复维护包

应用/资源版本：120；SDK 保持 0.2.1-alpha.1。以已验收的 0.2.14/119 APK（SHA256 `fb91dee13a0268766db8b56cbe7a4bfefdb17bb47f31428165cd0f611be3be50`）为资源输入，Android 源码固定在 `6874bc9aee6b3a767c85dbe5cea4af474ac37ddb` 并沿用 119 的 JetHub 保留升级代码。不将规范工程内尚未验收的 rc.2 迁移及其他暂存工作混入此发行线。

`scripts/prepare-compaction-apk.py` 在已登记任务的 generated 目录准备必要 Android 构建输入，共享 Gradle 缓存。原生库和非目标随包程序复用 119 的已验证字节；只替换压缩 runner，并维护共享资源清单中的对应校验。输出可从维护源码重新生成，不能直接对 APK ZIP 打热补丁。

`PhoneCompactionUpgrade` 在 `NodeRunner.ensureExtracted` 的完整解压之前处理已安装 119：

- 校验 alpha.1、全部目标文件 SHA，再定向更新 tree、存在的 profile 副本和 Purge 当前 installed generation 中的 runner。
- 保留私有 SDK 的其他补丁、组合包、全部配置和数据；历史 generation 与 Purge 的原始 copiedFiles 审计基线保持。
- 遇到未识别代码或独立链接时停止，不退回完整资源覆盖；旧版文件保持。
- 文件替换前保存小型原文件与事务日志；异常或下次启动恢复未提交事务。并发改动导致拒绝自动回退，保留日志和原文件，避免覆盖新改动。
- 全部文件完成才写资源版 120；同版本再次启动不重复执行。小型原文件保留在应用 files/compaction-upgrades 内。

正常首次安装仍使用带修复的完整资源。119 以外的已有资源版沿用原 NodeRunner 完整更新规则，本次交付的增量保留验收只覆盖已安装的 119。

`scripts/test-android-compaction-upgrade.py` 在随机独立包名和 UID 中真实安装 119→120 两个 APK，运行生产 NodeRunner 与迁移器；检查当前私有 SDK、中文空格扩展路径、配置/技能/会话标记保留、未知补丁和链接拒绝、事务失败恢复、并发写保护及重复启动。测试 APK 不启动 DSH 核心，不调用外部模型，不安装或停止正式 com.dshphone。正式手机安装和加载仍按当次授权分别验收。

构建顺序：prepare → 隔离 Android 升级测试 → 恢复正式构建输入 → clean assembleDebug → 签名、ABI、ZIP、资源及 SHA 检查 → 复制 Download。测试脚本的输出目录是私有回执目录，APK 生成物仍限已登记 generated 内。
