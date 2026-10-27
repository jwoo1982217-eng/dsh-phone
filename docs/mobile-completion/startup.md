# 启动页管理与本地开屏视频

参照官方 [kelai141/dsh-mobile-apk](https://github.com/kelai141/dsh-mobile-apk/commit/1a8f9fb) 的 `SplashPolicy`、`SplashStore`、`SplashImportController`、`SplashSettingsPage` 和 `SplashOverlay` 做本应用接口内适配。官方 MIT 版权声明及全文继续随 APK 位于 `assets/licenses/dsh-mobile-apk-MIT.txt`；此模块不改变本增强版包名、签名、引擎、账号或用户资料。

## 接入接口

原生设置页：`com.dshphone.startup.StartupSettingsActivity`。Manifest 只需注册非导出的 Activity，不新增存储、网络或其他权限。

```java
boolean shouldStart = StartupPreferences.autoStart(context); // 未设置时 true
StartupSplash splash = StartupSplash.show(activity, rootViewGroup); // 没有视频时返回 null，立即返回
// 引擎独立继续启动；页面准备好、用户停止启动或宿主不再需要遮罩时：
if (splash != null) splash.close();
```

`show` 和宿主 ViewGroup 必须在主线程；不要以 `show` 的返回值或视频回调作为启动引擎的前提。重复开始启动流程前先 `close()` 旧实例。`close()` 可重复调用。Overlay 会自动响应本 Activity 的暂停/恢复和销毁；也提供 `pause()`/`resume()` 供宿主显式调用。

`StartupPreferences.autoStart(context)` 只读取默认 true 的偏好；`setAutoStart` 仅保存偏好，不调用任何 service、停止、重启或模型 API。主 Activity 与 BootReceiver 由宿主接入，关闭开关只影响以后是否自动启动；已经运行的服务必须保持。关闭后用户仍应能手动启动。默认不设置任何视频，原有自动启动体验不变。

## 设置页行为

- “以后自动启动引擎”：默认开启；变更不操作当前引擎。
- “选择本地开屏视频”：系统 `ACTION_OPEN_DOCUMENT`、`CATEGORY_OPENABLE`、`video/*`，只读一次授予；仅接受 `content://`，不接受任意文件路径或 `http(s)` 地址，不申请管理全部存储、写权限或长期 URI 权限。
- “取消导入”：关闭当前源流，尝试通过 Android `CancellationSignal` 取消 provider 请求；不激活部分文件。
- “移除开屏视频”：原生确认后只删除本功能的配置与随机命名视频，不修改开关、运行资源或其他用户文件。

系统 picker 可以展示用户安装的文档 provider；若用户主动选择云盘文档，读取由其 provider 提供。应用自身不获取远程视频 URL、不进行网络预加载，也不会把视频发送到外部。

## 真实媒体校验与保留事务

延续官方 **50 MiB** 限额和 MPEG-TS 拒绝口径：扩展名 `.ts`、声明 MIME 或实际媒体 MIME 为 TS 均拒绝。已声明超限的文件在读取前拒绝；未知/不可信声明大小仍逐块限制实际流量。拒绝空文件、声明为非零但实际大小不符的截断/变化文件。

复制在后台工作线程进行，使用 64 KiB 缓冲和 120 秒操作时限。复制到 `filesDir/startup-videos/pending-*`，绝不在 UI 线程读取 50 MiB 文档。`MediaMetadataRetriever` 从本地暂存文件读取真实 has-video、正时长、视频宽高和 MIME，并实际解码一个最高 320×320 的预览帧；仅容器信息或音频正时长不足以通过。预览位图与 retriever 使用后释放。

验证完毕先把新视频原子移动为独立随机 `video-<UUID>.media`，再 fsync 并原子替换 `current.properties` 指针。原视频与指针在新文件完整验证前不被覆盖；不采用原地覆盖或失败后普通 copy 的降级路径。取消、提供方断连、解码失败、空间/写入问题、原子指针交换失败都清理本次暂存，保留原来的有效视频。只有新指针成功生效后才尝试删除旧文件。

同一应用进程的并发修改使用目录规范路径和修订序号检查：新操作已移除或更换视频时，之前尚未提交的导入不能迟到恢复旧设置；需重新选择后导入。取消在最终原子提交点之前生效，已经提交的成功配置不通过取消逆向回滚。进程被系统直接终止可能留下未引用的私有暂存/视频文件，但不会把它们当作当前视频或覆盖已生效指针；正常失败会清理。

视频独立保存于应用私有 `filesDir`，不在核心/快照覆盖目录、收件临时目录或七日清理目录中；包内资源更新不应替换用户视频。删除只匹配本功能严格的随机文件名，不从显示名称拼接目标路径，中文/空格名称仅供显示。

## 非阻塞原生开屏

只播放已经明确导入的本地文件。TextureView 在宿主 ViewGroup 中显示静音、居中裁切画面；右上角始终有原生“跳过开屏视频”。不申请音频焦点，不改变用户音乐、引擎或当前模型。

相比官方“静音循环到 Web UI 就绪”的实现，本增强版默认播放一次，完成即撤；准备失败/解码错误、宿主销毁或最长 30 秒会立即释放播放器、Surface 和遮罩，避免黑屏无限盖住现有操作入口。宿主应在 Web UI 就绪时更早调用 `close()`。引擎在视频准备及播放期间独立启动，跳过和视频失败不会取消引擎。

## 已执行测试与待实机验收

`StartupPolicyTest`：默认自动启动、TS/大小/媒体元数据规则、显示名称不成为路径。

`StartupVideoStoreTest` 使用真实临时文件和原子文件移动、可控 probe/source：正常替换、中文/空格、空文件与截断、未知大小 50 MiB 流量上限、取消、解码失败、原子指针失败保留旧文件、clear 阻止异步迟到提交、失败后重新导入及仅删除所有权文件。

`StartupNativeTest`：默认偏好和 toggle 不启动 service，系统 content picker 与取消、拒绝远程 URL，overlay 默认不显示、跳过/超时/销毁可重复关闭，真实 Android API 调用面的媒体元数据与缩略帧门槛。Robolectric 的 media 内容/帧为受控夹具，不等于真实硬件解码或系统 DocumentsUI 已实测。

```sh
./gradlew :app:testDebugUnitTest --tests 'com.dshphone.startup.*'
```

本次专项 20 项通过，0 失败。上线前仍需在不触碰正式用户资料的 Android 测试环境核对：系统 picker 读取真实短视频、静音画面/跳过、损坏视频保留上一次视频、取消慢 provider、旋转/进后台释放、开启/关闭自动启动对以后进入和开机行为的作用、当前引擎与原用户扩展/资料不变。源码与单测通过不代表手机已经安装并加载此功能。
