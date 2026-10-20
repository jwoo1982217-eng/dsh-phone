---
name: vscreen-phone
description: 虚拟屏（createVirtualDisplay）在副屏安装/启动/操作/测试 App 并截图，主屏零打扰。服务经 adb shell 以 shell uid 启动（app_process + CLASSPATH 本目录 jar），HTTP API 走 127.0.0.1:8998 + X-DSH-Token。设备端 DSH 可直接调 API（tap/see/close）；起服务由 Mac 侧驱动或 rish 通道完成。来源：ZhaoHua v181lite8 吸收，2026-10-13 真机全链路验证。
---

# 虚拟屏 vscreen（设备端卡）

jar 在本目录 `vscreen_shizuku.jar`（com.deepseek.harness.vscreen.Main，vs114）。

## 起服务（Mac 侧 adb，已验证流程）
```bash
ADB=平台工具adb路径
$ADB push <jar路径> /data/local/tmp/vscreen_shizuku.jar
$ADB shell "CLASSPATH=/data/local/tmp/vscreen_shizuku.jar /system/bin/app_process /system/bin com.deepseek.harness.vscreen.Main --port 8998 --dir /data/local/tmp/vs --token <自选token>"
$ADB forward tcp:8998 tcp:8998
```

## 设备端 DSH 直调（服务已在跑时，loopback 即可）
```
GET  http://127.0.0.1:8998/vscreen/status                    头 X-DSH-Token
GET  http://127.0.0.1:8998/vscreen/create?w=720&h=1280&dpi=160
GET  http://127.0.0.1:8998/vscreen/launch?pkg=com.android.settings
GET  http://127.0.0.1:8998/vscreen/see          → {path} PNG（截图在 /data/local/tmp/vs）
GET  http://127.0.0.1:8998/vscreen/tap?x=360&y=640
GET  http://127.0.0.1:8998/vscreen/swipe?x1=&y1=&x2=&y2=&dur=200
GET  http://127.0.0.1:8998/vscreen/key?keycode=4
GET  http://127.0.0.1:8998/vscreen/close
```
判断依据：tap 后必须再 see 对比哈希才算生效；launch 失败先 pm list packages 查包名。
