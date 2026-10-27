# SAF 工作区目录桥

此模块把用户在 Android 系统文件夹选择器中明确选择的本地共享目录，交回现有引擎工作区入口；不导入、搬动、同步或复制目录，也不改变会话工具权限。

## 壳层接入

`SafWorkspacePicker(activity, onResult, timeoutMillis = 300_000L)`，所有方法在主线程调用：

- `request(requestId): Boolean`：仅 `true` 表示已启动系统目录选择器；拒绝也会同步给出该 requestId 的结构化结果。
- `onActivityResult(requestCode, resultCode, data): Boolean`：在其他结果处理前分派。模块保留 28000–28999，不复用请求码，超时后的迟到结果不能完成下一次选择。
- `cancel()`：结算当前请求，清超时任务；实例仍可再次选择。
- `close()`：用于 Activity 销毁／不可再接收结果时，恰好一次结算并释放 Activity 选择请求。

`Result`：`requestId`、`status`、`path?`、`uri?`、`persistedGrant`、`message?`。仅 `SELECTED` 给真实文件系统 `path`；`CANCELLED/BUSY/PERMISSION_REQUIRED/UNSUPPORTED/ERROR/TIMEOUT/CLOSED` 均不是成功，不得把其当字符串工作区路径。

接入者只从可信本地页面接受用户选择请求，并保存页面／请求的所有权：页面离开、渲染器替换或 Activity 销毁时取消，不把回调投递给另一个页面。`PERMISSION_REQUIRED` 使用已有 `StorageAccess.show` 的用户点击入口引导，再由用户重试；模块不自动打开设置、不扩大权限。

## 实际语义

1. 使用 `ACTION_OPEN_DOCUMENT_TREE`，请求系统返回可持久化的读写目录授权；成功后核实系统保存了该 URI 的读写授权。
2. SAF 授权不等于 Node／shell 的 POSIX 文件访问权。因此选择前、选择后均检查已有 `StorageAccess.granted`，并对目标目录做只读属性检查（是目录、可读、可写）。不写探针文件。
3. 只接受 `com.android.externalstorage.documents` 的标准 tree URI。`primary` 使用当前 Android 用户的实际卷根；可移除卷通过系统卷 UUID、挂载状态及系统报告的根定位，不拼猜 `/storage/<用户输入>`。
4. 不把云盘、下载 provider 或未知 `content://` 冒充本地文件系统；这些返回 `UNSUPPORTED`，用户可换到“内部存储”或已挂载 SD 卡目录。
5. 拒绝 `..`／绝对路径／控制字符／不明确的分隔结构；实际路径规范化后不得通过符号链接逃出该存储卷。百分号文件名不二次解码，保留中文和空格。
6. 系统未返回完整持久读写能力、保存授权失败、目录不可访问或卷查询异常均可见失败并释放单槽，允许重试；不会谎称会话内临时授权可跨重启使用。

不新增 manifest 权限，不替换原有全文件选择器，不更改账号、会话或工作区配置。Android 10 的实际 scoped-storage 行为仍须真机验证；仅有旧 WRITE 授权但目录 raw 访问不通时会如实拒绝，不触发 ADB／AppOps 特权变更。

## 验收边界

独立 JVM 测试覆盖路径映射、卷 ID／挂载边界、并发单槽、迟到回调、请求码不复用、目录／符号链接访问；Robolectric 测试覆盖真实 Android Intent 边界、结构化结果、持久授权调用、取消、超时、销毁和失败重试。系统 DocumentsUI、持久授权跨进程重启、真实可移除存储和引擎工作区实际读写仍需 Android 设备验收；源码／单测通过不等于手机已加载。
