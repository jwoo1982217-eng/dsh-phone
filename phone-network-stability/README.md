# Android HTTP 连接稳定性适配

Node 26.4.0 自带 undici 8.5.0 在断线后可能反复复用损坏的 HTTP/2 会话，出现 ERR_HTTP2_INVALID_SESSION。此独立 Cordis 插件通过原调度器的 compose 接口，仅给请求设置 allowH2=false，复用原有直连或代理路由、TLS 校验、请求内容和取消信号。

不重放请求、不吞异常、不改系统 VPN、不关闭别的模块拥有的连接池。停用时仅在调度器仍属于本插件的情况下恢复前一个调度器。适用前提是实际调度器支持 compose 和 allowH2，须按目标 Android Node 验证 ALPN 和断线恢复，不能仅凭 Mac 单元测试宣称已修复手机。

手机入口：$DSH_HOME/extensions/phone-network-stability/index.mjs。依赖使用当前 phone profile 自带的 undici，不复制 SDK 或运行时。
