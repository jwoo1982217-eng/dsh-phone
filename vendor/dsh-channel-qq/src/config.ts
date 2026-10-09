/** Channel configuration. One row, one account. Values live in the profile's user patch layer. */

export interface ConnectionConfig {
  /** forward = the plugin dials NapCat's WS server; reverse = the plugin hosts a WS server NapCat dials into. */
  mode: 'forward' | 'reverse'
  /** forward: NapCat WS URL. reverse: listen URL, e.g. ws://127.0.0.1:8082 (port is the bind port). */
  url: string
}

export interface SegmentationConfig {
  enabled: boolean
  /** natural = 跟句号走; conservative = 太短的相邻句合并; active = 每句一条. */
  style: 'natural' | 'conservative' | 'active'
  /** Only gates texts with NO sentence enders; 句号说了算 otherwise. */
  minLength: number
  maxSegments: number
  removeTrailingPeriod: boolean
}

export interface PokeConfig {
  enabled: boolean
  /** Pokes within the window before 我 reacts (the patience). */
  patience: number
  windowSec: number
  /** Poke the sender back when patience runs out. */
  pokeBack: boolean
}

export interface ImageConfig {
  /** Download inbound images and attach them to the model prompt (vision). */
  enabled: boolean
  /** Max images attached per message (extras stay noted as [图片]). */
  maxPerMessage: number
}

export interface GroupModelConfig {
  /** Group conversations run on this route; null = same as the default route. */
  provider: string | null
  model: string | null
}

export interface STTConfig {
  enabled: boolean
  /** OpenAI-compatible /audio/transcriptions base, e.g. https://host/v1 */
  baseUrl: string | null
  /** API key (plain, or $ENV to read from environment). */
  apiKey: string | null
  model: string
}

export interface BatchingConfig {
  /** Quiet-window: analyze the intake queue this long after the last message. */
  windowMs: number
  /** Flush early once this many lines accumulated. */
  maxMessages: number
  /** Flush early once this many characters accumulated. */
  maxChars: number
}

export interface InjectModeConfig {
  /** Bypass batching: every group message is injected into the agent context as it arrives. */
  enabled: boolean
  /** When the agent is idle, deliver immediately and wake it (steer) instead of parking it (inject). */
  wakeIdle: boolean
}

export interface EmojiConfig {
  /** Steal sticker images seen in the primary group into `dir`. */
  steal: boolean
  /** With `autoSendProbability`, attach a random registered sticker after a reply. */
  autoSend: boolean
  autoSendProbability: number
  /** Stolen/raw sticker directory (defaults to <dshHome>/channel-qq/emoji). */
  dir: string | null
  /** Registered sticker directory (defaults to <dshHome>/channel-qq/emoji-registered). */
  registeredDir: string | null
}

export interface KeywordReaction {
  keywords: string[]
  reaction: string
}

export interface SchedulerConfig {
  /** Master switch: false disables every periodic model call (cheapest). */
  enabled: boolean
  /** Group patrol interval in minutes; 0 disables. */
  patrolMin: number
  /** Proactive DM interval in minutes; 0 disables. */
  dmProactiveMin: number
  /** The author's uumit cruise scripts; off unless the skills exist. */
  cruises: boolean
  /** 06:00 morning report. */
  morningReport: boolean
  /** Night self-talk / knowledge extract / evolve. */
  nightTasks: boolean
}

export interface PersonaConfig {
  /** The bot's persona name (how it calls itself in logs/UI, e.g. 我). */
  selfName: string
  /** How the bot addresses its master (e.g. 主人). */
  masterName: string
  /** How the bot addresses other group members (e.g. 朋友). */
  peerName: string
  /** The bot's self-pronoun in speech (e.g. 咱). */
  pronoun: string
}

export interface QQChannelConfig {
  connection: ConnectionConfig
  accessToken?: string
  /** The bot's own QQ number, from NapCat lifecycle events or configured explicitly. */
  selfId: number
  /** QQ numbers allowed to use admin-flavoured tools. */
  admins: number[]
  /** Master switch for group-chat handling (DMs unaffected). */
  /** Loopback port of the master-only affection dashboard; 0 disables. */
  affectionPort: number
  groupEnabled: boolean
  /** The core group; talkValue/emoji/steal semantics key off it. */
  primaryGroup: number | null
  requireMention: boolean
  /** Base reply probability in groups; the primary group may override via primaryTalkValue. */
  talkValue: number
  primaryTalkValue?: number
  /** Workspace the QQ agents run in (main knowledge workspace). */
  workspacePath: string | null
  agentPreset: string
  permissionPreset: string
  rateLimitMs: number
  maxMessageLength: number
  segmentation: SegmentationConfig
  batching: BatchingConfig
  injectMode: InjectModeConfig
  imageRecognition: ImageConfig
  poke: PokeConfig
  stt: STTConfig
  groupModel: GroupModelConfig
  /** Additional group-level or user-level name triggers. */
  keywordTriggers: string[]
  keywordReactions: KeywordReaction[]
  emoji: EmojiConfig
  persona: PersonaConfig
  scheduler: SchedulerConfig
  debug: boolean
}

export const DEFAULT_CONFIG: QQChannelConfig = {
  connection: { mode: 'forward', url: 'ws://127.0.0.1:3001' },
  selfId: 10000,
  admins: [],
  primaryGroup: null,
  groupEnabled: true,
  affectionPort: 8789,
  requireMention: true,
  talkValue: 0.6,
  rateLimitMs: 300,
  maxMessageLength: 4000,
  segmentation: { enabled: true, style: 'natural', minLength: 20, maxSegments: 8, removeTrailingPeriod: true },
  batching: { windowMs: 20_000, maxMessages: 20, maxChars: 4000 },
  injectMode: { enabled: false, wakeIdle: true },
  imageRecognition: { enabled: true, maxPerMessage: 2 },
  poke: { enabled: true, patience: 3, windowSec: 300, pokeBack: true },
  stt: { enabled: true, baseUrl: null, apiKey: null, model: 'whisper-1' },
  groupModel: { provider: null, model: null },
  keywordTriggers: [],
  keywordReactions: [],
  workspacePath: null,
  agentPreset: 'standard',
  permissionPreset: 'workspace-write',
  emoji: {
    steal: true,
    autoSend: false,
    autoSendProbability: 0.3,
    dir: null,
    registeredDir: null,
  },
  persona: { selfName: 'Assistant', masterName: 'Boss', peerName: 'Friend', pronoun: 'I' },
  scheduler: { enabled: true, patrolMin: 9, dmProactiveMin: 22, cruises: true, morningReport: true, nightTasks: true },
  debug: false,
}

/** Deep-merge a partial patch (from the cordis row config) over the defaults. */
export function resolveConfig(patch: Partial<QQChannelConfig> | undefined): QQChannelConfig {
  const raw = { ...DEFAULT_CONFIG, ...(patch ?? {}) } as QQChannelConfig
  raw.connection = { ...DEFAULT_CONFIG.connection, ...(patch?.connection ?? {}) }
  raw.segmentation = { ...DEFAULT_CONFIG.segmentation, ...(patch?.segmentation ?? {}) } as SegmentationConfig
  raw.batching = { ...DEFAULT_CONFIG.batching, ...(patch?.batching ?? {}) }
  raw.injectMode = { ...DEFAULT_CONFIG.injectMode, ...(patch?.injectMode ?? {}) }
  raw.imageRecognition = { ...DEFAULT_CONFIG.imageRecognition, ...(patch?.imageRecognition ?? {}) }
  raw.poke = { ...DEFAULT_CONFIG.poke, ...(patch?.poke ?? {}) }
  raw.groupEnabled = patch?.groupEnabled ?? true
  raw.stt = { ...DEFAULT_CONFIG.stt, ...(patch?.stt ?? {}) }
  raw.groupModel = { ...DEFAULT_CONFIG.groupModel, ...(patch?.groupModel ?? {}) }
  raw.emoji = { ...DEFAULT_CONFIG.emoji, ...(patch?.emoji ?? {}) }
  raw.persona = { ...DEFAULT_CONFIG.persona, ...(patch?.persona ?? {}) }
  raw.scheduler = { ...DEFAULT_CONFIG.scheduler, ...(patch?.scheduler ?? {}) } as SchedulerConfig
  return raw
}
