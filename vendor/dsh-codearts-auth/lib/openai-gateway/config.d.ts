export declare const DEFAULT_GATEWAY_HOST = "127.0.0.1";
export declare const DEFAULT_GATEWAY_PORT = 8326;
export interface OpenAiGatewayConfig {
    host: string;
    port: number;
}
/**
 * 网关开关。只有**显式**的假值才停用，未设置时默认启用（保持既有行为）。
 *
 * ⚠️ 不能写成 `parseInt(raw) || 1` 这类形式：`'0'` 是**合法**的停用值，
 * 而 `0` 是 falsy 会被 `||` 静默换回默认值 —— 开关会「关不掉」。
 * 判定只看归一化后的字符串，与本仓库 Qoder 环境变量的同一教训同源。
 */
export declare function isGatewayEnabled(env?: NodeJS.ProcessEnv): boolean;
/**
 * 交给 `server.listen()` 的地址形态。
 *
 * ⚠️ 与 {@link normalizeHostForCompare} **必须分开**（第二轮审计实测的回归）：
 * 判据需要剥 zone id（`::%eth0` 就是 `::` ⇒ 必须判为通配），但**交给 `listen()`
 * 的串不能剥** —— Linux 上 `fe80::215:5dff:fe1c:fc88%eth0` **带 zone 能 bind**
 * （scope id 生效），剥成裸地址后反而 `EINVAL(22)` 绑不上。把两者合成一个函数
 * 会让「修好判据」与「弄坏 link-local」同时发生。
 *
 * 仍然要剥掉的是：不可见字符（它们绝不会是地址的一部分）、方括号、端口。
 */
export declare function stripHostBrackets(host: string): string;
/**
 * 是否只含合法主机字符（ASCII 字母数字 + `.` `:` `%` `_` `-`）。
 *
 * ⚠️ 空串不算合法（调用方另有回落逻辑）。这是**判据侧**的闸门：不含非法字符
 * 才继续走通配识别，否则直接拒绝（fail-closed）—— 不再依赖「解析失败就放行」。
 */
export declare function isLegalHostText(host: string): boolean;
/**
 * 把裸地址还原成**能放进 URL** 的形态（IPv6 必须加方括号）。
 *
 * ⚠️ 这是本 issue 带出来的连带缺陷：`http://${host}:${port}` 对
 * `::1` 会拼出 `http://::1:8326`，那不是一个合法 URL（端口被解析成 IPv6
 * 的一段）—— 设置页会展示一个抄不走、连不上的地址，而排障方向会跑偏到
 * 「网关没起」。凡是往 URL 里塞 host 的地方都必须过这个函数。
 *
 * ⚠️⚠️ **URL 里必须剥掉 zone id**（第三轮审计实测的回归）：`listen()` 侧要
 * **保留** zone（`fe80::1%eth0` 才绑得上 link-local），但 URL 语法里
 * **没有** zone id 的位置 —— 实测 `new URL('http://[fe80::1%eth0]:8326/v1')`
 * 抛 `ERR_INVALID_URL`。⇒ 面板与日志会给出一个抄走连不上的地址，正是第一轮
 * 修过的同型缺陷。规范做法是把 `%` 转义成 `%25`，但浏览器与多数客户端都
 * 不支持带 zone 的 URL，故这里**直接剥掉**：同一网卡上的地址不带 zone 也
 * 能连（客户端与网关同机时 zone 是冗余的）。
 *
 * ⇒ **两个方向都要保住**：`listen` 串留 zone（{@link stripHostBrackets}），
 * URL 串剥 zone（本函数）。
 */
export declare function formatGatewayHost(host: string): string;
/** 拼网关基地址（含协议与端口）。`suffix` 传 `/v1` 之类的路径。 */
export declare function gatewayHttpUrl(host: string, port: number, suffix?: string): string;
/**
 * 是否等价于「绑定所有网卡」的通配地址。
 *
 * ⚠️⚠️ **判据不得依赖 `new URL()` 的宽容度**（初版就是，被两轮审计实测证伪）：
 * 它对含 `%`（zone id）、不可见字符、`host:port` 的输入会**抛错**，而 `catch`
 * 里 `return false`（放行）会让这些写法静默绑上全部网卡。故这里：
 *
 * 1. 先用 {@link normalizeHostForCompare} 把地址摘干净
 *    （NFKC + Unicode 类别剥不可见字符 + 端口 + **zone id**）；
 * 2. IPv4 走 {@link parseIpv4}（含 `inet_aton` 紧凑写法）判「是否为 0」；
 * 3. IPv6 走 {@link expandIpv6} 展开成 8 组后判「是否全零」，
 *    IPv4-mapped（`::ffff:0.0.0.0`）也据此判为通配（它绑全部 IPv4 网卡）。
 *
 * 解析不出来的形态**一律放行**（交给内核报 `ENOTFOUND` / `EADDRNOTAVAIL`）：
 * 猜成通配会把用户确实想用的主机名（容器服务名等）挡在启动之外，而那种误伤
 * 没有内核报错兜底（用户只会看到「不允许」却不知道自己写错了什么）。
 * ⚠️ 但**「放行」的前提是归一化已经把不可见字符摘干净** —— 否则漏一个 `Cf`
 * 就等于漏一条通往全网卡的路径（第二轮审计实测 25 条）。
 */
export declare function isWildcardHost(host: string): boolean;
/**
 * 是否只绑在本机回环上（供 UI 判断「安全声明该怎么说」）。
 *
 * ⚠️ **与 `isWildcardHost` 同源**：两者都走 {@link normalizeHostForCompare}。
 * 初版客户端自己写了一套字面量正则（`/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/` +
 * `=== '[::1]'`），于是 `127.1` / `0:0:0:0:0:0:0:1` / `::ffff:127.0.0.1` /
 * `localhost` 这些**内核实测只在回环可达**的写法被判成「已对外暴露」——
 * 面板因此输出它自己声称要消除的那种错误陈述（审计实测）。
 *
 * 判据：`127.0.0.0/8` 整个网段 + `::1` + IPv4-mapped 回环 + `localhost`。
 * ⚠️ 主机名只认 `localhost`（不做 DNS）：其余主机名**未知即按「不只回环」**
 * 处理（宁可多提示，不漏暴露风险）。
 */
export declare function isLoopbackHost(host: string): boolean;
/** 解析本机网关配置，地址/端口错误时显式失败，避免静默换端口或静默监听全网卡。 */
export declare function resolveGatewayConfig(env?: NodeJS.ProcessEnv): OpenAiGatewayConfig;
//# sourceMappingURL=config.d.ts.map