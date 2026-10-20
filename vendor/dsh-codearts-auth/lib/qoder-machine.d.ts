/**
 * Qoder 设备身份：`Cosy-MachineToken` + `Cosy-MachineType`。
 *
 * ## 为什么需要它（真实缺陷，2026-09-25 用抓包 + 消融实验定位）
 *
 * 用户报障：「Qoder 没领过积分却显示『今日已领取』，去 IDE 看还是可领取」。
 *
 * 早期实现认为 `/sash/` 端点**只需 Bearer + `Cosy-ClientType`**（见
 * `qoder-credits.ts` 的旧注释）。该判断**不完整** —— 服务端还要校验
 * 设备身份，**缺少 machine 头族时不下发「可领取」的活动**。
 *
 * ### 证据（2026-09-21 抓包解密 + 逐项消融）
 *
 * 用户提供的 `qoder积分.pcapng` 配 `SSLKEYLOGFILE` 解密后，可见 native 请求
 * `/sash/api/v1/me/campaigns` 时带的头是：
 *
 * ```
 * cosy-clienttype:      10
 * cosy-version:         0.3.4
 * cosy-machineos:       x86_64_win32
 * cosy-machinehostname: DESKTOP-FSEE011
 * cosy-machineid:       8da07a0d-…
 * cosy-machinetoken:    P1gAtkTG…
 * cosy-machinecode:     1a743bcb766a88545c
 * cosy-machinetype:     f4c9a409144dcb6377
 * ```
 *
 * 同一账号当下的对照实验（只改请求头，其它全同）：
 *
 * | 请求头 | `/sash/api/v1/me/campaigns` |
 * |---|---|
 * | 仅 `Cosy-ClientType: 10` | `showCampaign:true, claimable:false`，**1 条** `VIEW_DETAILS` |
 * | ＋ `Cosy-MachineToken` ＋ `Cosy-MachineType` | `claimable:true`，**2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/amount:100` |
 * | 全套 − `Cosy-MachineToken` | 退回 1 条（失效） |
 * | 全套 − `Cosy-MachineType` | 退回 1 条（失效） |
 * | 单独加任一头（不含配对） | 全部无效 |
 *
 * 结论：**`MachineToken` 与 `MachineType` 必须成对出现**，缺一即失效；
 * `Cosy-MachineId` / `Cosy-Version` / `MachineOS` / `MachineHostname` /
 * `MachineCode` 实测**均非必需**（去掉后仍能拿到活动）。
 *
 * 这解释了为什么只把 `Cosy-ClientType` 从 `5` 改成 `10` 仍不够 ——
 * 它是**必要但不充分**条件。
 *
 * ## 值的来源：本机 IDE 的 `machine_token.json`
 *
 * `%APPDATA%\Qoder\SharedClientCache\cache\machine_token.json`：
 *
 * ```json
 * { "token": "P1gA…", "type": "f677427e14abd0f6c1", "updateAt": 1774862945355 }
 * ```
 *
 * 即 `Cosy-MachineToken` = `token`，`Cosy-MachineType` = `type`。
 *
 * ⚠️ **实测该文件即使很旧（`updateAt` 为 179 天前）token 依然有效**，
 * 所以不做时效校验、也不因过期而拒发 —— 发出去最多是服务端忽略，
 * 而漏发会让用户看不到可领取的活动。
 *
 * ⚠️ **读不到时返回 undefined，调用方应照常发请求（只是不带这两个头）**：
 * 这与修复前的行为一致，属**保守降级** —— 用户若未安装 Qoder 桌面端
 * （纯插件登录的账号）就没有该文件，此时不能让整个积分功能报错。
 *
 * 为什么直接读文件而不自己生成 token：官方经 `runtime-info.exe`（UMID 模块）
 * 生成，其内部含设备指纹与签名逻辑，复刻代价高且属重复造轮子；而该文件
 * 就在本机、格式稳定，直接读更可靠（实测有效）。
 */
/** 设备身份的两个必需值。 */
export interface QoderMachineIdentity {
    /** 发送为 `Cosy-MachineToken`。 */
    token: string;
    /** 发送为 `Cosy-MachineType`。 */
    type: string;
}
/**
 * 解析本机 Qoder 设备身份；拿不到返回 `undefined`。
 *
 * ## 主路径：**实时**调 `runtime-info.exe` 生成
 *
 * ⚠️ **真实缺陷（用户报障，2026-09-26）**：新注册/新登录的 Qoder 账号，
 * 一键领取报「当前没有可领取的活动」，而 IDE 里该账号**可以领**。
 *
 * 根因有**两层**，第二层才是真正的：
 *
 * **① 初版读磁盘缓存**（`machine_token.json`）—— 那是 `runtime-info.exe` 的
 * 一份**陈旧缓存**（实测停在 179 天前，且**跑 exe 也不会更新它**）。
 * 改为实时 spawn 后**部分**账号恢复，但新账号仍失败。
 *
 * **② 实时 spawn 时漏了 `environment` 位置参数**（真正的根因）。
 * 必须调 `runtime-info.exe <environment> --account-stdin`；漏掉第一个参数会
 * 拿到**另一套身份**，服务端因而只回 1 条 `VIEW_DETAILS`：
 *
 * | 调用 | machineType | 服务端下发的活动 |
 * |---|---|---|
 * | 只传 `--account-stdin`（漏 env） | `15e6683914666dab9f` | 仅 1 条 `VIEW_DETAILS` |
 * | **`3 --account-stdin`（IDE 实际）** | **`3582ddfb14d9bf289a`** | **`CLAIM_BENEFIT/CLAIMABLE/100`** |
 *
 * 后者与 IDE 实时抓包（`qoder-live.pcapng`）**逐字节一致**。取值与理由见
 * {@link RUNTIME_INFO_ENVIRONMENT}。
 *
 * ⚠️ **曾因此得出错误结论**：漏参数时对**任何**账号都返回同一套 fallback
 * 身份，看起来「identity 是设备级、与账号无关」。该推断是**错的** ——
 * 身份随 `environment` 变化，必须与 IDE 用同一值。
 *
 * 不过「**进程内缓存**」这一点仍然成立且必需：单次 spawn 实测约 **3.8 秒**，
 * 每次请求都跑会让积分查询慢到不可用；且同一进程内 identity 不会变。
 *
 * ## 退路：实时拿不到时才读磁盘缓存
 *
 * 未安装 Qoder 桌面端（无 exe）时退回读 `machine_token.json`；
 * 两者都拿不到则返回 `undefined`，调用方**不带这两个头**（保守降级）。
 *
 * 结果被缓存（含「拿不到」这一结果）。
 *
 * @param forceExecutable 仅供测试注入（跳过真实 spawn）
 */
export declare function resolveQoderMachineIdentity(forceExecutable?: string): QoderMachineIdentity | undefined;
/**
 * 异步版：语义与 {@link resolveQoderMachineIdentity} 相同，但**不阻塞事件循环**。
 *
 * ⚠️ 积分端点在 Cordis 里是 async 上下文，而 spawn 要 ~3.8 秒 —— 用同步
 * `execFileSync` 会把整个事件循环卡住（连带 Web GUI 的其他请求），
 * 故生产路径用本函数。
 */
export declare function resolveQoderMachineIdentityAsync(forceExecutable?: string): Promise<QoderMachineIdentity | undefined>;
/**
 * 在给定 home 下按 `dataDirNames` 顺序定位 `runtime-info.exe`。
 *
 * 路径形态：`<home>/<dataDir>/.bin/umid-<platform>-<hash>/runtime-info(.exe)`
 * —— **目录名带哈希**（随版本变），故必须枚举而不能写死。
 *
 * ⚠️ 必须遍历**多个**数据目录（真实缺陷）：原先只认国际版的 `.qoder`，于是
 * 「只装了中国版」的用户找不到 exe → 退到陈旧磁盘缓存 → 拿不到 machine 头 →
 * `/sash/api/v1/me/campaigns` 只回 `VIEW_DETAILS` → 插件误报「今天已领」。
 * 那正是 2026-09-25 那次修复的复发路径。
 *
 * ⚠️ 某个目录存在但 exe 缺失时**继续试下一个**，不能就此返回 undefined ——
 * 半安装/清理残留会留下 `.bin/umid-*` 空目录。
 *
 * 导出是为了让单测能传入临时 home；生产路径由 {@link locateRuntimeInfo} 调。
 */
export declare function findRuntimeInfoExecutable(home: string, dataDirNames?: readonly string[]): string | undefined;
/**
 * 构造 `runtime-info.exe` 的参数。
 *
 * 顺序**必须**是 `[environment, '--account-stdin']` —— 与 asar 源码一致。
 *
 * ⚠️ **导出仅供测试**：`runtime-info-args` 的回归用例直接断言这个数组，
 * 因为单测路径刻意禁用了真实 spawn（见 `vitest.config.ts`），
 * 若不可导出就**无法用单测锁住参数形态** —— 而漏参数正是本函数出过的缺陷。
 */
export declare function runtimeInfoArgs(): readonly string[];
/** 仅供测试：清空缓存（生产代码不需要）。 */
export declare function resetQoderMachineIdentityCache(): void;
/**
 * 把设备身份并入请求头。
 *
 * 拿不到身份时**原样返回**，不写空串 —— 发空头会让服务端可能按非法设备处理，
 * 漏发才是安全的降级（与修复前行为一致）。
 *
 * 同步版：只在身份**已缓存**时才会命中；否则请用
 * {@link withQoderMachineHeadersAsync}。
 */
export declare function withQoderMachineHeaders(headers: Record<string, string>): Record<string, string>;
/** 异步版：生产路径用（首次会真实 spawn，约 3.8 秒，之后走缓存）。 */
export declare function withQoderMachineHeadersAsync(headers: Record<string, string>, forceExecutable?: string): Promise<Record<string, string>>;
//# sourceMappingURL=qoder-machine.d.ts.map