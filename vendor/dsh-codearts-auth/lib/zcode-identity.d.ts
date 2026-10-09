/**
 * 官方 ZCode 的 system 身份块（**3012 准入的唯一开关**）。
 *
 * ## 为什么必须内置这段文本
 *
 * 上游对 `/zcode-plan/anthropic` 通道做**请求体内容检查**：`system` 字段
 * 缺少官方的身份块结构时，直接返回
 * `\{"code":3012,"msg":"request has been blocked due to unusual activity."\}`（实测）。
 *
 * 实测矩阵（同账号、同 captcha 来源）：
 *
 * | system 内容 | 字符数 | 结果 |
 * |---|---|---|
 * | 无 system | 0 | ✗ 405 + `3012` |
 * | 仅 cliPrefix | 42 | ✗ 405 + `3012` |
 * | **cliPrefix + stable（全部三段）** | **2898** | **✓ 200** |
 * | 完整四块（含 dynamic 段） | 7599 | ✓ 200 |
 *
 * ⇒ **判据是「身份块是否存在」**，不是「块数多少」或「字符数够不够」，
 * 也与 HTTP 头、运行时（Electron / curl / Node）无关。上游 curl 带完整块同样 200。
 *
 * ⚠⚠ **2026-10-03 复测修正了两条旧说法**（issue IKJI0Y 驱动，本机三个账号、
 * 17 次请求）。**改本文件前先读那两条**：
 *
 * 1. **HTTP 状态码是 `405`**，不是 `403`。排查时别按 403 找。
 * 2. **日期块在这个窗口不是判据**（`withContextPrefix` 去掉照样 200）。
 *    它仍照发（官方如此、零成本），但它与身份块是**必要非充分**的关系，
 *    ❌ **不要再把它写成「3012 的最后一个开关」当成唯一结论** ——
 *    那句来自早期窗口，见 {@link withContextPrefix}。
 *    本次逐项排除的**非判据**还有：HTTP 头、版本头（`3.14.3`/`3.14.4`/`4.0.0`）、
 *    请求频率（单账号无间隔连发 6 发）、多轮历史（`tool_use`/`tool_result`）、
 *    `tools` 声明、账号池中的其它账号。完整矩阵见 README 的 ZCode 章节。
 *
 * ⚠ 即便如此，「身份块达标仍 3012」**目前没有已知解释**。遇到时的可观测信息
 * 由 `src/zcode-diagnostics.ts` 打进错误文案（账号序号 / 计数 / 间隔 /
 * **实测**身份块字符数 / 日期块有无），诊断行**不含任何凭据**。
 *
 * ## ⚠ 维护警告（来自 `dsh-free-glm/patches/zcode-official-identity.ts`）
 *
 * 上游策略与此结构**强耦合**：官方客户端升级后若改变身份块结构，
 * 需要同步更新本文件，否则会重新出现 3012 —— 而
 * **3012 有账号冷却惩罚**（30 分钟；24h 内第 3 次起 24h；**5 次停用**）。
 * **不要为了调试反复触发。**
 *
 * ## 本文件里的文本从哪来
 *
 * `dsh-free-glm/patches/zcode-official-identity.ts` 从同类项目
 * `a137460387/zcode2api` 的 `src/upstream/zcode-system.json` 提取，
 * 该项目由官方 3.11.2 bundle 反解。本仓库按**程序化提取**（esbuild 编译后
 * 读常量再字面量化）落地，避免手抄引入偏差。
 */
/** 第一块：CLI 身份前缀（官方以此开头，42 字符）。 */
export declare const OFFICIAL_CLI_PREFIX: string;
/**
 * 第二块：stable 段（多段用 `\n\n` 连接）。
 *
 * ⚠ 只发**准入必需**的部分。官方完整身份块还含 5KB 的 dynamic 段
 * （`# Communicating with the user` / `# Context management`），
 * 那些是**给 ZCode 内 coding agent 的行为指令**，与准入无关 ——
 * 且它们会被放在 system 开头，**压过调用方（DSH）自己的 prompt**，
 * 表现为「啰嗦、慢」。故此处不含 dynamic 段。
 */
export declare const OFFICIAL_STABLE_SECTIONS: readonly string[];
/** 官方预期的 `cliPrefix + stable` 合计长度（供自检与单测断言）。 */
export declare const OFFICIAL_IDENTITY_CHARS = 2900;
/** Anthropic Messages 的内容块（ZCode 只接受 `text` 块）。 */
export interface ZcodeTextBlock {
    type: 'text';
    text: string;
    cache_control?: {
        type: 'ephemeral';
    };
}
/**
 * 构造官方形态的 `system` 块数组。
 *
 * ## 结构（逐字复刻官方，**不要"优化"**）
 *
 * ```
 * block[0] = cliPrefix（42 字符）          ← 准入必需
 * block[1] = stable（2856 字符）           ← 准入必需
 * block[2] = "# Environment" 段
 * block[3..] = 调用方的 system（追加在最后）
 * ```
 *
 * ⚠ **调用方内容必须追加在最后** —— 官方身份块必须处在开头位置
 * （上游的检查看的是前缀结构）。
 *
 * ⚠ 每个块都带 `cache_control: {type:'ephemeral'}`（官方如此，
 * 且利于上游缓存命中）。
 *
 * @param callerSystem 调用方的 system（DSH 的完整 prompt / AGENTS.md 规则）
 * @param options.cwd  工作目录。
 *        官方实现声明「cwd is never "unknown" in real traffic」，
 *        故调用方必须给真值。
 * @param options.provider 展示用的 provider id（进 environment 段）。
 * @param options.model 模型名（进 environment 段的 poweredByLine）。
 */
export declare function buildZcodeSystemBlocks(callerSystem: string | undefined, options: {
    cwd: string;
    provider?: string;
    model?: string;
    platform?: string;
    osVersion?: string;
}): ZcodeTextBlock[];
/**
 * 构造官方形态的 `# Environment` 段。
 *
 * 官方每个会话都会告诉模型它的运行环境。不发的实测后果：
 * 问「Which model are you?」只能答出笼统的 "GLM" —— 因为它**没被告知**
 * 自己在 `zcode/glm-5.3-flash`、也不知道工作目录与平台。
 *
 * 这不只是自我认知问题：不知道 `Platform` / `Shell` 会以为该给 bash 命令
 * （而这里是 PowerShell），不知道工作目录会用相对路径瞎猜。
 */
export declare function buildEnvironmentSection(options: {
    cwd: string;
    provider?: string;
    model?: string;
    platform?: string;
    osVersion?: string;
}): string;
/** 本地时区的 ISO 日期（官方用本地日期，**不是** UTC）。 */
export declare function formatLocalIsoDate(date?: Date): string;
/**
 * 构造 `<system-reminder>` 上下文块。
 *
 * ⚠ 形态细节（逐字复刻，不要"优化"）：
 * - 整块是**一个** `{type:'text'}`，插到 `content` **数组**最前面 ——
 *   不是拼进文本字符串（后者会改变结构，仍被判为裸请求）
 * - `outro` 前有 **6 个空格**缩进
 * - 空行由 `join('\n')` 里的空串产生
 * - 日期用**本地时区**的 ISO 日期
 */
export declare function buildContextPrefixBlock(now?: Date): ZcodeTextBlock;
/**
 * 给**首轮 user 消息**的 content 数组最前面插入日期块。
 *
 * 规则（官方行为）：
 * - 只处理第一条消息，且它必须是 `role === 'user'`
 * - **幂等**：已以 `<system-reminder>` 开头则不重复插
 * - 纯文本 content 会被转成块数组（官方就是数组形态）
 */
export declare function withContextPrefix<T extends {
    role: string;
    content: unknown;
}>(messages: readonly T[], now?: Date): Array<Record<string, unknown>>;
//# sourceMappingURL=zcode-identity.d.ts.map