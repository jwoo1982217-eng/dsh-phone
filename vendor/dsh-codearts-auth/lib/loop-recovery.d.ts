/**
 * 思考死循环被中止后的**自动续跑**（auto-resume）。
 *
 * ## 真实报障（用户要求，2026-10-04）
 *
 * > 能不能让模型在病态重复后，让会话自己恢复？现在病态重复后要我打个「继续」
 * > 才继续运行，加个自动中断病态重复和自动继续会话的功能吧。
 *
 * 「自动中断」已经由既有的循环守卫完成（`REASONING_LOOP`，见 `sse.ts`）；
 * 缺的是中止之后那一步 —— 现在必须由**人**补一句「继续」。
 *
 * ## 为什么这不是可有可无的便利，而是既有缺陷的收尾
 *
 * 全库取证（219 会话，`scripts/probe-max-tokens-provenance.mjs`，见 `sse.ts`
 * 的 `REASONING_LOOP_CODE` 注释）：守卫命中的 25 步里，**25 步全部**在截断后
 * 被迫由用户手动补一句（11× 「继续」、9× 「继续上面未完成的任务」，其中 2 次
 * 用户自己诊断出「你陷入思考循环了」）。而守卫命中时**额度远没有用满**
 * （实测单次只烧约 2000 字符），也就是说：**这 25 次停顿全是白停的**。
 *
 * ## 为什么不用 harness 的 `retryPolicy`
 *
 * `REASONING_LOOP` 刻意**不在** `DEFAULT_RETRYABLE_CODES` 里，且这是对的：
 * 死循环是**确定性**病理，同一条请求原样重发只会再烧一轮额度（这正是
 * `sse.ts` 里那条注释的结论）。要跳出循环必须**改变输入**，也就是补一条新的
 * user 消息 —— 那是 harness 的 `followup()` 语义，不是重试策略能表达的东西。
 *
 * ## 为什么是 `agent.followup()` 而不是别的通道
 *
 * - `followup()` 是**公开** Agent 接口（`dsh-agent`）：「排队一条普通的下一个
 *   轮次提示词并唤醒驱动器」。harness 自己的目标续跑驱动器
 *   （`dsh-goal-round-driver`）就是用它在 idle 时投递下一轮的，本实现与它同构。
 * - 投出去的是**一条真正的 `user/message`**，会落盘、会在 UI 上显示、可重放 ——
 *   满足 harness 的「模型可见 ⟺ 已落盘」红线（在适配器里偷偷改请求体则违反它，
 *   且**不可见**，用户会以为模型自己会读心）。
 * - 不用 `ctx.schedule`（定时提醒）：那是**持久化任务**，最小粒度是秒级、走
 *   Session 控制器重新激活会话，用来做「本轮刚失败、此刻就续跑」既重又错。
 *
 * ## 三条安全边界（都按「宁可少续跑，不可无限续跑」选）
 *
 * 1. **只在 idle 投递，且投递必须脱离事件派发栈**。错误发生的那一刻驱动器还在
 *    跑，此时 `followup()` 排进 `next-turn` 后**不会**被唤醒（`wakeDriver()`
 *    对 running 相位不 latch），消息会**烂在收件箱里**。故像目标驱动器一样等
 *    `agent/status === 'idle'`。
 *    ⚠️⚠️ **但仅仅「在 idle 分支里投」是不够的**（Issue IKLEOW 根因 1）：`idle`
 *    是由 `setPhase()` **同步派发**的，若在该派发的监听器里同步 `followup()`，
 *    `wakeDriver()` 会立刻把相位改回 `running` 并**再次同步派发**
 *    `agent/status` —— 一次 idle 转换因此产生两个方向相反的信号，客户端采用
 *    哪一个取决于监听器注册顺序（详见 `deliverNow` 的注释与实测数据）。
 *    故投递一律经 {@link LoopResumeScheduler} 挪出当前栈，并在投递时刻**重新
 *    复核** `status === 'idle'` 与收件箱为空。
 * 2. **连续次数上限**（默认 2，见 `LOOP_RESUME_DEFAULT_MAX`）。这是**连续**
 *    计数：**别人真的介入**时把它清零（用户手打的、目标驱动器排的、子代理收尾的）
 *    —— 语义与「用户自己补一句『继续』之后我们又有预算」一致。
 *    ⚠️ **只有真介入才算**（见 {@link isInterventionSource}）：自动注入的上下文
 *    通知（`agent-instructions` / `tool-jobs` / `repeat-tool-reminder` …）不清零，
 *    否则任何每步注入通知的插件都能把这个上限架空。
 * 3. **只在循环中止时续跑**。`REASONING_LOOP` 只在「该步没有任何可见产出」时
 *    才报（见各适配器的 `reasoningLoopIsSoleOutput` 门禁），故续跑不会重复
 *    已经给用户看过的东西；其它错误码（TRANSPORT / QUOTA / AUTH …）一律不碰。
 * 4. **如实署名 source**：投出的消息带 `{ kind: 'loop-resume' }`，**绝不**伪造成
 *    `{ kind: 'user' }`（见 {@link LOOP_RESUME_SOURCE_KIND}）。
 *
 * ⚠️ 续跑次数是**进程内**状态（按 agent id 记）。插件重载即清零 —— 与目标
 * 驱动器的 `activation` 同样是进程内语义，不做持久化（没有格式变更风险）。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { UserMessage } from '@deepseek-ai/dsh-llm';
/**
 * 自动续跑消息的**自有来源标识**。
 *
 * ⚠️⚠️ **绝不能再用 `{ kind: 'user' }`**（Issue IKLEOW 根因 3）。按 harness 的
 * 既有约定，`source.kind === 'user'` 是**宿主对「直接人类输入」的证明**，
 * 不是一个渲染标签：`tool-goal` 的 create / edit / pause / resume 都要求
 * 「当前轮次存在直接人类消息」才放行（见 `packages/goal/tool-goal/README.md`
 * 的「Host attestation of human input」）。伪造成 `user` 会让自动续跑**冒用
 * 人类授权**，模型据此可以创建 / 改写 / 恢复目标；UI 也会把它渲染成用户发言。
 *
 * ⚠️ 0.1.7 之前的 `MessageSourceMap` 只有一个共享的 `plugin` 包装，本插件当时
 * 因此只能借用 `user`；**0.2.0 起 source kind 由**生产者自己**声明**
 * （`MessageSourceMap` 已删除 `plugin`，改为合并扩展），故现在可以如实署名。
 */
export declare const LOOP_RESUME_SOURCE_KIND = "loop-resume";
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        /**
         * 循环中止后由本插件自动投递的续跑指令。
         *
         * ⚠️ 它不是人类输入 —— `tool-goal` 的人类授权判据（`source.kind === 'user'`）
         * 因此**不会**被它命中，这正是本标识存在的意义。
         */
        'loop-resume': {
            readonly kind: 'loop-resume';
        };
    }
}
/**
 * 自动续跑时投递的 user 消息正文。
 *
 * ⚠️ 它是**模型可见且会落盘**的文本（不是日志），故按「给模型的指令」写：
 * 说清三件事 —— ①继续未完成的任务；②为什么上一轮停了（思考重复，**不是**
 * 任务做完）；③这次要换思路。不写 harness 内部词汇（「循环守卫」「去重率」），
 * 那是给用户看的诊断，模型只需要知道「上一轮那样想没用」。
 */
export declare const LOOP_RESUME_PROMPT: string;
/** 连续自动续跑的**默认**上限（次）。 */
export declare const LOOP_RESUME_DEFAULT_MAX = 2;
/**
 * `…_MAX` 的硬上限。
 *
 * 单次循环只烧约 2000 字符（实测），2 次已足够覆盖「换个思路就能继续」的
 * 绝大多数情况；再往上配（比如 999）不是配置而是事故 —— 真要无限跑，
 * 用户该用的是 goal（`create_goal`）而不是这个兜底。
 */
export declare const LOOP_RESUME_MAX_LIMIT = 10;
/** 总开关环境变量；**默认开启**，与 `DSH_REASONING_LOOP_GUARD` 同族。 */
export declare const LOOP_RESUME_FLAG_ENV = "DSH_REASONING_LOOP_AUTO_RESUME";
/** 连续次数上限环境变量；`0` 是**合法**值（= 一次都不续跑）。 */
export declare const LOOP_RESUME_MAX_ENV = "DSH_REASONING_LOOP_AUTO_RESUME_MAX";
/** 自动续跑策略。 */
export interface LoopResumePolicy {
    /** 是否启用（`false` 时 `installLoopResume` 不注册任何监听）。 */
    readonly enabled: boolean;
    /** 连续续跑上限；落在 `0..{@link LOOP_RESUME_MAX_LIMIT}`。 */
    readonly maxResumes: number;
}
/**
 * 归一化 `…_MAX`。
 *
 * ⚠️ **非法值回默认值，而不是回 0**：`0` 是「绝不自动续跑」的**合法**配置，
 * 若把 `=abc` 也变成 0，用户拼错一次就会以为「功能没生效」却查不出原因
 * （与本仓库既有教训同型：`parseInt(…) || 默认值` 会把合法的 `0` 静默吞掉）。
 *
 * @param raw - 环境变量原文；`undefined` / 空白视为未设置。
 * @returns 归一化后的上限（整数、非负、≤ {@link LOOP_RESUME_MAX_LIMIT}）。
 */
export declare function resolveLoopResumeMax(raw: string | undefined): number;
/**
 * 读取自动续跑策略。
 * @param env - 环境变量来源，默认 `process.env`（单测注入用）。
 * @returns 归一化后的策略。
 */
export declare function resolveLoopResumePolicy(env?: NodeJS.ProcessEnv): LoopResumePolicy;
/**
 * 判断一个错误是不是「思考死循环中止」。
 *
 * ⚠️ **不能只靠 `instanceof LlmError`**：`@deepseek-ai/dsh-llm` 在宿主与插件里
 * 可能解析成**两份模块实例**（宿主自带副本 + profile 里另一份），此时
 * `instanceof` 恒为 `false`，表现是「功能完全没反应而且没有任何报错」——
 * 极难定位。故这里再按**错误码**认一次：`REASONING_LOOP` 是本插件自己定义的
 * 常量（`sse.ts`），误判风险为零。
 *
 * @param error - `agent/error` 载荷里的原样错误。
 * @returns 是否为循环中止。
 */
export declare function isReasoningLoopFailure(error: unknown): boolean;
/**
 * 本模块真正用到的 Agent 面（结构化类型）。
 *
 * 刻意只声明这四项：自动续跑的判据是「idle + 没人在排队 + 投一条 followup」，
 * 别的能力一律不碰。单测据此可以直接给假对象，无需伪造整个 Agent。
 */
export interface LoopResumeAgent {
    /** 会话 id（同一会话跨 resume 稳定，故用它作状态键）。 */
    readonly id: string;
    /** 当前生命周期状态；只有 `'idle'` 允许投递。 */
    readonly status: string;
    /** 收件箱只读面；`hasPending` 为真说明已经有人在排队，不抢。 */
    readonly inbox: {
        readonly hasPending?: boolean;
        readonly nextTurn?: readonly unknown[];
        readonly nextStep?: readonly unknown[];
    };
    /** 排队一条下一个轮次的 user 消息。 */
    followup(message: UserMessage): void;
}
/** 日志面（`ctx.logger` 天然满足）。 */
export interface LoopResumeLog {
    info(message: string): void;
    warn(message: string): void;
}
/**
 * 把一个任务挪出**当前事件派发栈**的调度器。
 *
 * ⚠️ 默认是 `queueMicrotask`（不是定时器）：本需求是「本轮刚失败、此刻就续跑」，
 * 微任务只需让出当前同步栈即可，不会引入额外延迟，也不像 `ctx.schedule` 那样
 * 变成持久化任务。harness 自己的 `goal-round-driver` 用 promise 链达到同一目的
 * （`requested` + `run` 串行），二者都是「脱离派发栈」的实现。
 */
export type LoopResumeScheduler = (task: () => void) => void;
/** {@link createLoopResumeController} 的构造参数。 */
export interface LoopResumeControllerOptions {
    /** 策略（开关 + 上限）。 */
    readonly policy: LoopResumePolicy;
    /** 日志出口。 */
    readonly log: LoopResumeLog;
    /**
     * 实际投递动作；默认 `agent.followup(message)`。
     *
     * 接线侧会传一个包了 `withoutInitiator()` 的版本（见 `installLoopResume`），
     * 单测侧直接传 spy。
     */
    readonly deliver?: (agent: LoopResumeAgent, message: UserMessage) => void;
    /**
     * 投递的调度方式；默认 {@link defaultSchedule}（`queueMicrotask`）。
     *
     * 单测注入 `task => task()` 即可恢复同步语义（便于断言），而**真实组合测试
     * 必须用默认值** —— 本参数存在的唯一理由是让「脱离派发栈」这件事可测。
     */
    readonly schedule?: LoopResumeScheduler;
}
/** 自动续跑控制器（纯逻辑，不依赖 cordis）。 */
export interface LoopResumeController {
    /** 记录一次 `agent/error`。 */
    observeFailure(agent: LoopResumeAgent, error: unknown): void;
    /**
     * 记录一次 `agent/status`。
     *
     * @returns 是否（将）投出一次续跑。⚠️ 语义随调度器而变，**调用方不得据此做
     *   业务判断**（`installLoopResume` 的监听器忽略它，只用于测试与诊断）：
     *   同步调度器下是**投递结果**；默认的 `queueMicrotask` 下投递尚未发生，
     *   故只能如实返回「**已排定**」。
     */
    observeIdle(agent: LoopResumeAgent): boolean;
    /** 记录一条进入收件箱的消息（用于区分「我们投的」与「别人投的」）。 */
    observeInput(agent: LoopResumeAgent, message: {
        readonly id: string;
        readonly source?: unknown;
    }): void;
    /** 丢弃某个 agent 的状态（`agent/disposed`）。 */
    forget(agent: LoopResumeAgent): void;
    /** 当前**连续**续跑计数（诊断/单测用）。 */
    attemptsOf(agentId: string): number;
}
/**
 * 判断一条消息是否由本插件的自动续跑投出。
 *
 * ⚠️ 按 **`source.kind`** 认，而不是按 message id：id 只在单进程内有效，
 * 而 source 会随消息落盘，重放 / 重启后仍可辨认。
 *
 * @param source - 消息的 `source` 字段（未知形状按「不是」处理）。
 * @returns 是否为自动续跑消息。
 */
export declare function isLoopResumeSource(source: unknown): boolean;
/**
 * 判断一条收件箱插入是否代表「别人真的介入了」。
 *
 * @param source - 消息的 `source` 字段。
 * @returns 是否清零连续续跑预算。
 */
export declare function isInterventionSource(source: unknown): boolean;
/**
 * 创建自动续跑控制器。
 * @param options - 策略、日志出口与投递动作。
 * @returns 控制器；内部状态按 `agent.id` 记，`forget()` 清理。
 */
export declare function createLoopResumeController(options: LoopResumeControllerOptions): LoopResumeController;
/**
 * 装上自动续跑（在插件 `apply()` 里调用一次）。
 *
 * ⚠️ `agents` 用 `ctx.inject([...])` 而**不**写进静态 `inject`：宿主侧 agent-loop
 * 缺席的 profile（纯 `ctx.llm` 的脚本、部分 headless 场景）里静态 inject 会让
 * 本插件**永久 pending**，整个 profile 启动失败（与 `connection` 同理，见
 * `index.ts` 的 `inject` 注释）。缺席时本功能整体不生效，其余 provider 照常。
 *
 * @param ctx - 插件上下文。
 */
export declare function installLoopResume(ctx: Context): void;
//# sourceMappingURL=loop-recovery.d.ts.map