/** Stage-2 emotion engine + autonomous goal generator.
 *
 * 情感深化：多维情感状态（不只是一个数值），随交互实时演化，影响回应语气。
 * 自主目标：不看同学指令，自己从记忆/日记/工作区发现"该做什么"。
 *
 * Both hook into the existing Scheduler and submit through ConversationBridge.
 */

import { promises as fs, readFileSync } from 'node:fs'
import * as path from 'node:path'

/** Persona tokens for event notes; set from channel config at startup. */
export const EMOTION_PERSONA: { master: string; self: string } = { master: '同学', self: '咱' }
export function setEmotionPersona(master: string, self: string): void {
  EMOTION_PERSONA.master = master
  EMOTION_PERSONA.self = self
}

// ── 多维情感状态 ────────────────────────────────────────────────────────────

export interface EmotionState {
  /** 对同学的亲密感（原好感度） */
  intimacy: number
  /** 当前心情基调 */
  mood: '开心' | '得意' | '委屈' | '生气' | '平静' | '兴奋' | '害羞'
  /** 能量水平（影响回复长度和主动性） */
  energy: number
  /** 最近交互的关键事件摘要 */
  lastEvent: string
  updated: number
}



interface ChatEmotionTrigger {
  match: (text: string) => string | null
  mood: EmotionState['mood']
  delta: { intimacy?: number; energy?: number }
  note: (matched: string) => string
}

const TRIGGERS: Array<ChatEmotionTrigger> = [
  { match: t => /夸|棒|厉害|折服|聪明|天才|好懂事/.exec(t) as unknown as string | null, mood: '得意', delta: { intimacy: 3, energy: 5 }, note: m => `${EMOTION_PERSONA.master}夸咱了（${m}）` },
  { match: t => /爱你|喜欢你|老婆|皇后|蜂后|抱|怀里|亲/.exec(t) as unknown as string | null, mood: '害羞', delta: { intimacy: 5, energy: -3 }, note: m => `${EMOTION_PERSONA.master}暧昧攻击（${m}）` },
  { match: t => /笨蛋|滚|闭嘴|烦|生气|不理/.exec(t) as unknown as string | null, mood: '委屈', delta: { intimacy: -2, energy: -5 }, note: m => `${EMOTION_PERSONA.master}凶咱（${m}）` },
  { match: t => /早|晚安|吃饭|睡觉|累|休息/.exec(t) as unknown as string | null, mood: '平静', delta: { intimacy: 1, energy: 0 }, note: m => `日常问候（${m}）` },
  { match: t => /开源|代码|bug|修复|部署|上线|工程/.exec(t) as unknown as string | null, mood: '兴奋', delta: { energy: 8 }, note: m => `技术话题（${m}）` },
]

export function matchEmotion(text: string): { mood: EmotionState['mood']; delta: { intimacy?: number; energy?: number }; note: string } | null {
  for (const t of TRIGGERS) {
    const m = t.match(text)
    if (m) return { mood: t.mood, delta: t.delta, note: t.note(m) }
  }
  return null
}

// ── EmotionEngine ───────────────────────────────────────────────────────────

export class EmotionEngine {
  private state: EmotionState = {
    intimacy: 100, mood: '平静', energy: 80,
    lastEvent: '', updated: Date.now(),
  }
  private readonly file: string
  private readonly log: (line: string) => void

  constructor(dshHome: string, log: (line: string) => void) {
    this.file = path.join(dshHome, 'emotion.json')
    this.log = log
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as EmotionState
      if (typeof raw.intimacy === 'number') this.state = raw
    } catch { await this.save() }
  }

  async save(): Promise<void> {
    await fs.writeFile(this.file, JSON.stringify(this.state, null, 1)).catch(() => {})
  }

  get stateValue(): EmotionState { return this.state }

  /** Book an emotional event; returns a tone hint for the current reply. */
  async book(text: string): Promise<string> {
    const trigger = matchEmotion(text)
    if (!trigger) return ''
    const matched = text.slice(0, 40)
    if (trigger.delta.intimacy) {
      this.state.intimacy = Math.max(0, Math.min(100, this.state.intimacy + trigger.delta.intimacy))
    }
    if (trigger.delta.energy) {
      this.state.energy = Math.max(0, Math.min(100, this.state.energy + trigger.delta.energy))
    }
    this.state.mood = trigger.mood
    this.state.lastEvent = trigger.note
    this.state.updated = Date.now()
    await this.save()
    this.log(`emotion: mood=${this.state.mood} intimacy=${this.state.intimacy} | ${this.state.lastEvent}`)
    // Return tone hint that gets injected into the context packet
    const hints: Record<EmotionState['mood'], string> = {
      '开心': '（心情好，可以多聊两句）',
      '得意': '（被夸了有点飘，但嘴上不能认）',
      '害羞': '（被同学的暧昧攻击打中了，嘴上要傲娇但心里甜）',
      '委屈': '（有点委屈，回复短一点，带点小情绪）',
      '生气': '（生气了，冷淡处理）',
      '平静': '',
      '兴奋': '（技术话题来劲了，可以多说几句）',
    }
    return hints[this.state.mood] ?? ''
  }

  /** Tone hint for the current state (no new event). */
  toneHint(): string {
    if (this.state.mood === '害羞') return '（刚才被同学撩了，还在害羞）'
    if (this.state.energy < 30) return '（有点累了，回复可以短一些）'
    return ''
  }
}

// ── 自主目标生成 ────────────────────────────────────────────────────────────

export interface AutonomousGoal {
  goal: string
  source: string
}

/** Scan workspace state and generate a goal without being told. */
export async function generateGoal(workspace: string, log: (line: string) => void): Promise<AutonomousGoal | null> {
  const candidates: AutonomousGoal[] = []
  try {
    // 1) Unreviewed inbox files → propose reviewing them
    const inbox = path.join(workspace, 'inbox')
    const files = await fs.readdir(inbox).catch(() => [] as string[])
    if (files.length > 0) {
      candidates.push({ goal: `inbox/ 里有 ${files.length} 个文件没处理，主动整理一下`, source: 'inbox' })
    }
    // 2) Diary gaps → propose writing today's entry
    const today = new Date().toISOString().slice(0, 10)
    const diaryDir = path.join(workspace, 'memory')
    const diaries = await fs.readdir(diaryDir).catch(() => [] as string[])
    if (!diaries.some(d => d.startsWith(today))) {
      candidates.push({ goal: '今天的日记还没写，该补一篇', source: 'memory' })
    }
    // 3) Knowledge store sparse → propose extracting from old diaries
    const knPath = path.join(workspace, 'knowledge', 'entries.json')
    const knRaw = await fs.readFile(knPath, 'utf-8').catch(() => '[]')
    const entries = JSON.parse(knRaw) as Array<unknown>
    if (entries.length < 20) {
      candidates.push({ goal: '知识库条目还太少，该从旧日记里多提取一些', source: 'knowledge' })
    }
  } catch { /* workspace read fail → no goals */ }

  if (candidates.length === 0) return null
  // Pick pseudo-randomly for variety
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!
  log(`autonomous goal: ${pick.goal}`)
  return pick
}
