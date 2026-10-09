/** Stage-2 emotion engine + autonomous goal generator.
 *
 * 情感深化：多维情感状态（不只是一个数值），随交互实时演化，影响回应语气。
 * 自主目标：不看同学指令，自己从记忆/日记/工作区发现"该做什么"。
 *
 * Both hook into the existing Scheduler and submit through ConversationBridge.
 */
/** Persona tokens for event notes; set from channel config at startup. */
export declare const EMOTION_PERSONA: {
    master: string;
    self: string;
};
export declare function setEmotionPersona(master: string, self: string): void;
export interface EmotionState {
    /** 对同学的亲密感（原好感度） */
    intimacy: number;
    /** 当前心情基调 */
    mood: '开心' | '得意' | '委屈' | '生气' | '平静' | '兴奋' | '害羞';
    /** 能量水平（影响回复长度和主动性） */
    energy: number;
    /** 最近交互的关键事件摘要 */
    lastEvent: string;
    updated: number;
}
export declare function matchEmotion(text: string): {
    mood: EmotionState['mood'];
    delta: {
        intimacy?: number;
        energy?: number;
    };
    note: string;
} | null;
export declare class EmotionEngine {
    private state;
    private readonly file;
    private readonly log;
    constructor(dshHome: string, log: (line: string) => void);
    load(): Promise<void>;
    save(): Promise<void>;
    get stateValue(): EmotionState;
    /** Book an emotional event; returns a tone hint for the current reply. */
    book(text: string): Promise<string>;
    /** Tone hint for the current state (no new event). */
    toneHint(): string;
}
export interface AutonomousGoal {
    goal: string;
    source: string;
}
/** Scan workspace state and generate a goal without being told. */
export declare function generateGoal(workspace: string, log: (line: string) => void): Promise<AutonomousGoal | null>;
