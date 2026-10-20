/** Scheduler: proactivity, time-of-day awareness, dreams, self-evolution.
 *
 * All four run through the same ConversationBridge.submit() path so everything
 * the model does stays inside the harness (tools, permissions, sessions).
 *
 * - 主动性巡逻 (every ~9 min, only when the group had recent traffic): the
 *   model gets the recent context marked as a patrol and decides itself
 *   whether to start a topic, react, or stay silent.
 * - 时段感知: every packet gets a one-line time-of-day flavor prefix.
 * - 梦境 (04:30 daily): the model writes a dream into workspace
 *   memory/dreams/YYYY-MM-DD.md and may share a fragment in the group.
 * - 自进化 (every 6h): the model reviews its memory diaries and appends
 *   learnings to MEMORY.md — the persona file itself stays read-only.
 */
import type { ConversationBridge } from './bridge.js';
import type { QQChannelConfig } from './config.js';
export interface TimeContext {
    /** 凌晨/清晨/上午/中午/下午/傍晚/晚上/深夜 */
    readonly period: string;
    /** One flavor line for the model. */
    readonly flavor: string;
}
export declare function timeContext(now?: Date): TimeContext;
export declare class Scheduler {
    private readonly bridge;
    private readonly config;
    private readonly log;
    private readonly opts;
    private timers;
    private readonly groupConversationKey;
    constructor(bridge: ConversationBridge, config: QQChannelConfig, log: (line: string) => void, opts?: {
        workspace?: string;
        onExtract?: (source: string, text: string) => Promise<number>;
        generateGoal?: (workspace: string) => Promise<{
            goal: string;
            source: string;
        } | null>;
    });
    start(): void;
    private dmCounter;
    private knowledgeDone;
    /** She visits 主人: report progress / greet / share / tease — her choice. */
    private dmProactive;
    dispose(): void;
    private patrol;
    private dream;
    private readonly dreamDone;
    /** 04:40 daily: extract knowledge entries from today's diary + recent group packets. */
    private morningDone;
    /** 任务一：每日早报（课表+天气+早安） */
    private morningReport;
    /** 任务二三：UUMit 巡航（执行脚本+汇报变化） */
    private runCruise;
    private extractKnowledge;
    private configWorkspace;
    private evolve;
}
