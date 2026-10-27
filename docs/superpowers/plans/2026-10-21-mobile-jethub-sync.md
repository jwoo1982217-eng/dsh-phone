# 手机和平板 JetHub 同步实施计划

> **For agentic workers:** 使用 executing-plans 逐项执行；vendor 项目 AGENTS 明确要求 inline，故本任务在当前会话顺序实施，不派子代理。

**Goal:** 将三星和联想已可用的 alpha.1 手机核心中的 JetHub 更新到电脑现用 dsh-providers-hub 0.2.1-rc.2，保留资料和自改工具。

**Architecture:** 以提交6874bc9的Android源码和完整校验的117资源为隔离输入，仅替换JetHub并重新生成两份配套资源，维持alpha.1。维护源码同步电脑的JetHub源码、加入独立资源构建与名称兼容工具；不混入canonical尚未完成的rc2核心升级。保留新旧包名解析到同一实体，防止OFM重复注册。

**Tech Stack:** Android Gradle/Java17、Node26、Cordis、TypeScript、Python tar/ZIP与SHA256。

## Task 1: 冻结与盘点
- [x] 保存canonical源文件SHA、Git状态与语义索引；读取桌面模块dac0802、上游固定78dc506。
- [x] 两台设备记录APK/核心/私有SDK/账号引用及顺序/会话ID/MCP清单；确认无运行任务后才能部署。

## Task 2: 名称与资源构建
- [x] 独立Android源码切片仅使用6874bc9，native和基础资源严格引用已恢复117APK。
- [x] 在scripts/mobile-jethub-release.py实现共享清单hydrate→两处JetHub替换→兼容别名→deduplicate重建，单独输出新tar与JSON校验回执。
- [x] 用真实117及本次坏包案例验证拒绝错清单；相邻边界验证等长损坏/同名冲突，失败不改输入，重试可恢复。
- [x] 升为0.2.14/code119/assets119，完整clean Debug构建；所有非目标资源与native逐SHA相同。

## Task 3: 兼容验证
- [x] 在实际alpha.1依赖上执行JetHub测试与真实插件图启动；私有副本禁止外网与模型推理。
- [x] 使用一个隔离Android UID执行117→119实际覆盖升级，确认启动、两个名称同一模块、账号顺序/开关保留、RPC坏请求恢复、已有工具发现。
- [x] 在隔离UID进行相关失败恢复，不用正式数据试错。

## Task 4: 部署与维护
- [x] 正式设备重新取空闲状态；复用现有完整恢复点，按指纹只备份本次需变动的代码/配置，禁止用旧资料全量覆盖。
- [x] 依次三星、联想覆盖安装；逐设备确认实际119/alpha.1/JetHubrc2、账号/会话保留、页面可见与无副作用代表调用。
- [x] 将任务所需改动精确合入维护源码；原rc2 WIP保留，不提交、不推送。
- [x] 交付源码/应用/实际加载/工具调用分阶段回执；保留恢复材料并按本任务登记回收生成物。

实际验收：两台正式119/alpha.1/JetHubrc2、Android隔离升级、UI、账号和会话保留均通过。详见本任务 verification.json。全部共享引用2473条逐大小和SHA通过。原源码5611输入及暂存索引已核对；未提交推送。
