# 浏览器重复视口设置保留页面

电脑版对应修复：`4900b5a3f944ab83b0187c7a387d16415e709b98`。电脑版在视口更新时保留最后有效画面，防止静态网页不再产生新帧后面板一直空白。

Android 独立浏览器使用原生 WebView。同步的保留规则是：`profile` 请求的宽、高、网页身份与当前配置相同，且渲染进程仍有效时，返回当前状态，保留同一个 WebView 和文档，不重新加载，不丢失网页表单。参数省略时沿用当前值。

真正改变视口或身份时仍按原流程重建；用户点击刷新时仍刷新。渲染进程已退出时，即使配置相同也继续重建恢复。标签归属、网址限制、登录资料及主 DSH 会话权限保持原规则。

验证入口：

- `app/src/test/java/com/dshphone/browser/BrowserServiceProfileTest.kt`：重复配置、立即返回、缺省参数、非法尺寸、手动刷新和真实配置切换。
- `scripts/test-android-browser-retention.py`：只准备浏览器必要源码和资源，在一个全新测试包中依次覆盖安装旧版、修复版、回退版、重新应用版；检查真实 WebView 的文档及中文草稿、Cookie、归属边界、手动刷新、配置切换，以及模拟渲染退出后的恢复。

示例（输出和项目目录应放在本任务已登记的目录）：

```sh
python3 -B scripts/test-android-browser-retention.py \
  --serial DEVICE_SERIAL --adb /absolute/path/to/adb \
  --output /absolute/task/receipts \
  --project /absolute/task/generated/browser-check \
  --before-service /absolute/task/original/BrowserService.kt
```

验证脚本只允许其新建的 `com.dshphone.browserretentionverification.t…` 测试包；不安装、停止、清除或卸载正式 DSH。测试包使用同一 UID 覆盖升级，并在结束时移除。

本次同步为维护源码修改。隔离 Android WebView 验证通过不表示正式 APK 已构建或安装；后续正式交付仍执行手机升级与兼容契约。
