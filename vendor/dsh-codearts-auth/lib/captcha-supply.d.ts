/**
 * 供给 param 的可接受年龄上界（毫秒）。⚠ **未实测的保守值**，见文件约束 2。
 *
 * ⚠ 年龄按「server 收到这条贡献的时刻」起算（见 `SupplySlot.atMs`），而真实年龄还要
 * 再加上 client 产出 → 回传的那一跳 ⇒ 这里算出来的年龄被**系统性低估**。
 * ⇒ 这个常量只能往**小**里留余量（≈ 上游真实时效 − 一跳延迟），
 * 不要因为「少算了一段」就把它放大 —— 放大的结果就是把真实超龄的 param 发出去。
 * 真实时效量出来后回填（量法见 `takeFreshParam`）。
 */
export declare const PARAM_MAX_AGE_MS = 20000;
/** 有界等待的默认上限（毫秒）——与 client 的贡献心跳同量级。 */
export declare const DEFAULT_CARRIER_WAIT_MS = 1500;
declare const stats: {
    supplied: number;
    used: number;
    stale: number;
    waitTimeouts: number;
    interactive: number;
};
/**
 * client 回传一个 param 落槽，并**唤醒**队首等待者（唤醒不等于交付）。
 *
 * ⚠ **不合格一律不收**（评审 I1，2026-10-02）：判据直接用
 *   `validateCaptchaParam`（`./zcode-captcha.js`），**与 chromium 腿同一份**。
 *   此前这里只判「非空」，于是 SDK 被降级时那串约 76 字符的垃圾 param 能一路进槽、
 *   被取走、发到上游 —— 领取端点**始终**索要验证（`400/3007`），那发必然失败，
 *   白扣一次设备级验证配额（阿里云同设备每小时 150 次）。
 *   ⚠ 判据只有这一份：本地再写一份长度/字段判据必然与 `zcode-captcha.ts` 漂移
 *   （本仓库反复吃过同型缺陷）。
 *
 * @param arrivedAtMs **server 侧**的到达时刻。调用方（`src/jet-hub-rpc.ts` 的贡献
 *   入口）传 `Date.now()` 即可；⚠ 不要传 client 带回来的时间戳（跨端时钟漂移会弄废
 *   时效闸，见 `SupplySlot.atMs`）。参数存在只为让单测能注入时钟。
 * @param options.interactive 这一发是不是被降级成了交互式验证（评审 I2，见 `SupplySlot`）。
 * @returns 是否被接受（调用方据此决定要不要重试贡献）。
 */
export declare function putSuppliedParam(param: string, arrivedAtMs: number, options?: {
    interactive?: boolean;
}): boolean;
/**
 * 取一个仍在时效内的 param（**取走即清**，一次性）。
 *
 * ⚠ 本函数是**唯一**的时效闸：`waitForFreshParam` 的入口取货与被唤醒取货都走这里，
 * `used` / `stale` 也只在这一处记账。任何「另开一条交付通路」的写法都会绕过时效判定
 * （评审缺陷 1 就是那条直投 `slot.param` 的旁路）。
 *
 * ⚠ 量 param 真实时效的方法（二期第一件事）：等真出现 `3007` 的那次，
 *   故意用「年龄递增」的 param 各发一次，看从第几秒开始被拒，再回填这个常量。
 *
 * ⚠ 边界取 `>=`（age 恰等于上限即作废），与 `src/captcha-requirement.ts` 的
 *   `until <= now` 同一惯例：时效本来就是未实测的保守值，整点这一毫秒不放宽。
 */
export declare function takeFreshParam(nowMs: number): string | undefined;
/** server 置起「现在可能需要 captcha param」，client 的心跳据此决定要不要产。 */
export declare function setCaptchaDemand(active: boolean): void;
export declare function captchaDemand(): boolean;
/**
 * 有界等待一个新鲜 param：先取现成的，没有就等投放，超时/中断一律返回 undefined。
 *
 * ⚠ 三条退出路径都必须存在（挂死过一次的人写的注释）：
 *   ①槽里有 → 直接给；②超时 → 记 `waitTimeouts`；③ abort → 立刻给 undefined。
 *
 * ⚠ 被唤醒后**自己去 `takeFreshParam`**，与入口那条出口共用同一道时效闸：
 * 取到 `undefined`（刚过期被清）就**不出队**，继续等下一次投放直到超时。
 * `used` / `stale` 也只由 `takeFreshParam` 记一处，这里再记一次就是两处真相。
 */
export declare function waitForFreshParam(now: () => number, maxWaitMs?: number, options?: {
    signal?: AbortSignal;
}): Promise<string | undefined>;
/**
 * 只读快照（新对象；面板/日志用，绝不允许反向写）。
 *
 * ⚠ `pendingInteractive` 说的是「**当前槽里那条**是不是交互式产物」——
 * 它随 `takeFreshParam` 一起归零（一次性），所以它是「下一发要不要警惕」的读数，
 * 与累计计数 `interactive` 是两个维度，别混用。
 */
export declare function captchaSupplyStats(): typeof stats & {
    pendingInteractive: boolean;
};
/** 全量复位（单测用；与 `resetCaptchaRequirementMemory` 配套调用）。 */
export declare function resetCaptchaSupply(): void;
export {};
//# sourceMappingURL=captcha-supply.d.ts.map