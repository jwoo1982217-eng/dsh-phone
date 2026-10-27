# 本增强版的手动在线更新

入口：原生菜单 → **增强版在线更新**（`com.dshphone.update.UpdateActivity`）。进入页面、恢复前台或启动 DSH 都不会检查更新；只有点击按钮才访问网络。检查、下载及安装是三个明确动作，可以取消检查和下载；最终安装始终交给 Android 系统，由用户确认。

## 更新源与发行约定

唯一仓库：[jwoo1982217-eng/dsh-phone](https://github.com/jwoo1982217-eng/dsh-phone)。不连接 `kelai141/dsh-mobile-apk` 的发行包，不使用第三方镜像，也不携带 GitHub 令牌。官方手机端与此增强版应用身份不同，不能作为本应用覆盖升级源。

正式非 draft、非 prerelease 的 GitHub `releases/latest` 元数据需要包含：

- 标签，例如 `v0.2.13`，仅 ASCII 字母、数字、点、下划线或短横线，最长 128 字符。
- 资产 **`dsh-phone-${tag}-arm64-v8a.apk`**，例如 `dsh-phone-v0.2.13-arm64-v8a.apk`；上传状态为 `uploaded`，大小大于零且不超过 512 MiB。
- SHA256：GitHub 资产 `digest` 的 `sha256:<64位十六进制>`；或者同名 **`.apk.sha256`** 资产。校验文件只允许一条 `HASH  APK_BASENAME` 或 `HASH *APK_BASENAME` 记录，不允许缺失、重复或换成其他文件。如果两处都发布，必须一致。
- `browser_download_url` 必须精确属于本仓库此标签及资产的 HTTPS 下载路径。只允许跳转到 HTTPS `release-assets.githubusercontent.com/github-production-release-asset/...`，最多三次；其他主机、非 HTTPS、用户信息、异常端口和镜像均拒绝。

发布前，在维护源码上构建保持相同 `applicationId` 和当前安装签名的 APK，并提高 `versionCode`；仅提高标签或 `versionName` 不算可升级。保管现有签名身份，不能用官方签名或另一台机器新生成的 debug key 代替。此功能支持当前同签名 debug APK，但不会为了安装它而跳过签名比对。正式发布需由维护者实际测试和发布，不会因加入更新入口自动创建 Release。

校验文件生成示例（在 APK 所在目录执行）：

```sh
shasum -a 256 dsh-phone-v0.2.13-arm64-v8a.apk > dsh-phone-v0.2.13-arm64-v8a.apk.sha256
```

GitHub HTTP 404 会显示“尚未发布正式 APK 更新”，不伪称手机已升级或当前就是最新。缺 ABI 资产、未附摘要、网络故障、限流、错误响应等分别如实报错。

## 安装前强制校验

下载先放应用私有 `cache/phone-updates/pending/`，不可由 FileProvider 访问；连通 15 秒、读取 20 秒超时，APK 下载总时限 10 分钟，元数据 1 MiB、校验文件 8 KiB。取消会断开连接并删除临时文件。任何失败不覆盖运行资源、配置或用户目录。

完整下载须与发布大小逐字节相同，SHA256 必须一致。随后检查 ZIP 各条目 CRC、长度、重复条目及总体积上限，必须含 Android manifest 和 arm64 原生库。Android PackageManager 解析包身份及当前签名；拒绝不可解析、无签名、不同包名、不同签名、非更高 `versionCode` 或 Android 版本不兼容的 APK。多签名必须与当前安装 signer 集完全相同，不自动放宽到历史证书轮换。

仅通过全部检查的 APK 才进入私有 `cache/phone-updates/verified/`，设为只读；点击安装时再次校验。用户再次确认后，FileProvider `${applicationId}.phone.updates` 仅授予安装器读取该已验证 APK 的临时权限，不暴露其他缓存、账号、聊天、备份或目录。没有“未知应用安装”授权时打开 Android 设置；返回后必须再次手动点击，不自动续装。系统仍执行自身安装验证；打开安装器不等于安装成功。

覆盖升级保留相同 UID 下的用户数据。本更新器不卸载、不清数据、不改账号/会话/模型设置，不替代[手机升级兼容契约](../phone-upgrade-contract.md)要求的扩展、核心补丁与实际运行验收。缓存由 Android 管理；若离开页面或旋转导致 Activity 销毁，当前下载会取消，不后台续传。

## 验证与仍需真实 Android 验收的范围

- `UpdateArtifactPolicyTest`：可信仓库/HTTPS/CDN/标签/ABI命名、摘要、大小、包名、版本及 signer 集的离线策略。
- `PhoneUpdateClientTest`：本地伪连接，无外网；手动启动、404、限流、异常响应、截断/过大/错误 digest、取消、CDN/恶意重定向、失败文件清理。
- `PhoneUpdateMetadataTest`：真实 Android JSON 解析下的资产、摘要、状态及路径边界。
- `AndroidApkVerifierTest`：真实 ZIP/CRC/截断文件和 PackageManager **夹具**，覆盖身份、签名、versionCode、最低 Android 版本和取消。签名夹具不是实际 APK 密码学验签或覆盖安装证明。
- `UpdateActivityTest`：进入/返回不启动下载或安装，以及 FileProvider 只暴露已验证目录。

```sh
./gradlew :app:testDebugUnitTest --tests 'com.dshphone.update.*'
```

发布闭环必须另在隔离 Android UID/测试设备完成：可信 HTTPS 下载真实同签名更高版本 APK → 原生确认 → 系统覆盖安装 → 实际版本/签名及原扩展、会话等保留核对；另验证不同包、不同签名、旧版本、损坏包的拒绝，以及拒绝授权/取消/网络失败后的恢复。没有已发布的增强版 APK 或尚未实机安装时，不能宣称在线更新闭环已实测通过。

参考：[GitHub Release 资产字段与下载](https://docs.github.com/en/rest/releases/assets)、[Android PackageManager](https://developer.android.com/reference/android/content/pm/PackageManager)、[未知来源安装授权](https://developer.android.com/reference/android/provider/Settings#ACTION_MANAGE_UNKNOWN_APP_SOURCES)。
