# rc.2 私有运行功能与旧 native recipe 的边界

本地社区包的 `package.json` 和 `lib/`（57 文件）改前与手机已装包逐 SHA256 相同，不仅仅版本号相同。原作者/社区版本、署名和许可证未改。

- 已迁移的私有人设/设置/rewind 等能力继续由当前适配后的 SDK 运行。本补丁不重新套旧 alpha 规则，不删除社区插件，也不改用户的启用配置。
- 正常 `apply()` 在 `initializeCommunityProfile` 后强制关闭三种自动宿主改写，仅安装运行 hooks 就返回。后面的旧启动 `restoreMissingOriginalsAllHosts`、`patchWatchedClientBundlesSync`、settle 均不可达。`reapplyInstalled()` 本来就直接拒绝 native self-reapply。此边界保留。
- 旧 recipe #78 会把缺失 overlay 的 `.dshpurge.bak` 当成补丁内容读取；`restoreMissingOriginalsFromBak` 会补回缺失/空文件；`revertAll` 会覆盖现文件。它们不能跨 SDK 代际使用。
- 显式 Apply/Revert 现在先核 launcher SDK；Recover 同时核 launcher 和目标私有树。所有直接 native apply/backup/revert/restore/watch 入口也独立核目标私有包，只有已审阅 `0.2.1-alpha.1` 才继续旧行为。rc.2、混合/未知版本、缺 manifest、链接包均拒绝 `DSH_PURGE_CORE_VERSION_UNSUPPORTED`，在宿主写入前停止。原文件、原 `.bak` 和元数据保留。
- rc.2 上的显式重新 Apply、旧备份 Revert/Recover **尚未适配**。必须提供该 SDK 版本对应的新 recipe/备份迁移，不能通过修改 manifest 版本、关闭 guard 或拷入旧 `.bak` 绕过。版本检查本身也不证明同版本任意代码签名都受支持；原规则仍须逐匹配报告，未知签名不算成功。

受控验证：真实文件树中的 rc.2 缺源/现源、匹配旧规则、backup/watch、显式 profile Apply/Revert、standalone Recover、alpha 目标+rc.2 launcher、未知/混版本/缺 manifest/link、旧 alpha 原有恢复均覆盖，拒绝路径前后全树逐 SHA 不变。正常启动无 native 写入的结论包括源码可达性检查；完整组合冷启动由发行流水线另验，不代称真机升级已完成。

## 运行 hooks 的 bundle 门禁

原手机 manifest 的四个 SDK peer 仅精确允许 alpha.1，rc.2 会在导入插件前直接跳过它。现在四个 peer 明确声明 `=0.2.1-alpha.1 || =0.2.1-rc.2`；不扩大到 rc.3 或其他未知版本，不加入 allow-version 豁免。新增 `dsh.communityAdaptation.runtimeCompatibility.localRevision` 标记本地内容适配；保留上游/社区版本字符串与署名，部署按内容 SHA 而非仅版本识别。运行 hooks 的声明与旧 native recipe 的支持是两条独立门禁，rc.2 显式 native Apply/Revert/Recover 仍拒绝。

`tests/runtime-manifest.test.mjs` 以真实 rc.2 app-boot 的 `evaluatePluginCompatibility` 和 `loadProfileDirectory` 验证：原 manifest 两项 RED；双精确 peer 后层被加载、原 enabled 覆盖保持、无豁免写入且未知版本继续拒绝。测试可通过 `DSH_PURGE_TEST_APP_BOOT` 指向隔离已审阅 rc.2 模块，不读取或修改真实用户 profile。
