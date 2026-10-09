/** dsh-channel-qq — QQ channel plugin for DeepSeek Harness over OneBot v11.
 *
 * Ported from the OpenClaw `extensions/qq` channel. What moved over:
 *   - OneBot v11 transport (forward/reverse WS, echo API calls, reconnect)
 *   - trigger gate (mention / keyword / talk-value probability)
 *   - keyword reaction hints, smart segmentation, rate limiting, length caps
 *   - a OneBot tool subset for the agent
 *   - lite sticker stealing / auto-send
 * What deliberately did not move: the plugin's own access-control and
 * moderation stack (the harness's permission presets own that), its custom
 * model-caller rotation (the harness's llm seam owns that), and its
 * heartflow/PFC brain (the harness agent loop owns that). Persona comes from
 * the agent preset + workspace instruction files, not from channel config.
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { resolveConfig, type QQChannelConfig } from './config.js'
import { OneBotClient } from './onebot.js'
import { OutboundQueue } from './outbound.js'
import { parseInbound } from './segments.js'
import { ConversationBridge } from './bridge.js'
import { registerQQTools } from './tools.js'
import { EmojiStore } from './emoji.js'
import { Scheduler } from './scheduler.js'
import { SentLog } from './sent-log.js'
import { AffectionStore } from './affection.js'
import { setEmotionPersona } from './emotion.js'
import { KnowledgeStore } from './knowledge.js'
import { EmojiLibrary } from './emoji-library.js'
import type { OneBotEvent } from './types.js'

function defaultDshHome(): string {
  return process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
}

export class ChannelQQ extends Service {
  static inject = [
    'llm',
    'agents',
    'agentPresets',
    'agentDefaultModel',
    'permissionPresets',
    'sessionTitle',
    'workspaceRegistry',
    'tools',
    'attachments',
  ]

  private readonly config: QQChannelConfig
  private client: OneBotClient | null = null
  private bridge: ConversationBridge | null = null
  private emoji: EmojiStore | null = null
  private scheduler: Scheduler | null = null
  private emojiLibrary: EmojiLibrary | null = null
  private readonly log: (line: string) => void

  constructor(ctx: ConstructorParameters<typeof Service>[0], config: unknown) {
    super(ctx, 'channelQQ')
    this.config = resolveConfig(config as Partial<QQChannelConfig>)
    // The harness console logger only surfaces warnings by default; mirror
    // channel activity to a file so connection and reply-capture issues stay
    // debuggable (and the stream-frame shape calibratable) in the field.
    const logFile = path.join(defaultDshHome(), 'channel-qq.log')
    this.log = (line: string) => {
      ctx.logger.info(`channel-qq: ${line}`)
      void fs.appendFile(logFile, `${new Date().toISOString()} ${line}\n`).catch(() => {})
    }
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    const config = this.config
    this.log(`starting (mode=${config.connection.mode}, url=${config.connection.url}, selfId=${config.selfId})`)

    this.client = new OneBotClient(config.connection, config.accessToken, this.log)
    const out = new OutboundQueue(this.client, config, this.log)
    this.bridge = new ConversationBridge(this.ctx, config, this.client, out, this.log)
    this.emojiLibrary = new EmojiLibrary(config.emoji, this.log)
    await this.emojiLibrary.load()
    this.emoji = new EmojiStore(config.emoji, this.client, this.log, this.emojiLibrary)
    setEmotionPersona(config.persona.masterName, config.persona.pronoun)
    await this.emoji.init()

    // Auto-emoji is model-judged now: the persona tells her to list, judge the
    // room, and only send when a sticker genuinely fits. No blind dice roll.
    this.client.on('connect', () => {
      this.log('QQ link ready')
    })
    this.client.on('event', (event: OneBotEvent) => {
      void this.onEvent(event)
    })
    const primarySentLog = new SentLog(defaultDshHome(), config.primaryGroup !== null ? `group-${config.primaryGroup}` : 'group-none', this.log)
    await primarySentLog.load()
    const affection = new AffectionStore(defaultDshHome(), this.log)
    await affection.load()
    affection.configure({ selfName: config.persona.selfName, masterName: config.persona.masterName })
    affection.serve(config.affectionPort, {
      workspacePath: config.workspacePath,
      onSubmit: (prompt: string) => {
        if (this.bridge === null) return
        void this.bridge.adminPrompt(prompt).catch((e: Error) => this.log(`admin prompt failed: ${e.message}`))
      },
    })
    const knowledgeStore = new KnowledgeStore(defaultDshHome(), config.workspacePath, this.log)
    await knowledgeStore.load()
    this.bridge.knowledge = knowledgeStore
    const disposeTools = registerQQTools(this.ctx, config, this.client, out, this.log, this.emojiLibrary ?? undefined, affection, primarySentLog, knowledgeStore, this.bridge)

    yield async () => {
      affection.close()
      disposeTools()
      this.scheduler?.dispose()
      this.scheduler = null
      this.bridge?.dispose()
      this.client?.stop()
      this.client = null
      this.bridge = null
      this.emoji = null
      void this.emojiLibrary?.save()
      this.emojiLibrary = null
    }

    this.client.start()
    void this.bridge.reattachPersistedSessions()
    this.scheduler = new Scheduler(this.bridge, config, this.log, {
      workspace: config.workspacePath ?? undefined,
      onExtract: async (source: string, text: string) => {
        // 2026-09-26 主人令：不调用任何 API——知识提取由主模型自己判断完成
        //（注入任务到主会话，她用 extract_knowledge 工具自查自判入库）
        const clipped = text.slice(0, 4000)
        try {
          await this.bridge?.dmProactive(`【知识提取任务】读今天的日记（${source}），自己判断哪些是值得长期记住的知识，用 extract_knowledge 工具入库。不要调用任何外部 API，全部由你自己判断。\n日记节选：\n${clipped}`)
          this.log(`knowledge: task injected to main session for ${source}`)
        } catch (e) {
          this.log(`knowledge inject failed: ${e instanceof Error ? e.message : String(e)}`)
        }
        return 0
      },
    })
    this.scheduler.start()
  }

  private async onEvent(event: OneBotEvent): Promise<void> {
    if (this.bridge === null || this.emoji === null || this.client === null) return
    try {
      if (event.post_type === 'message'
        && event.message_type === 'group'
        && this.config.groupEnabled !== false
        && this.config.emoji.steal
        && this.config.primaryGroup !== null
        && event.group_id === this.config.primaryGroup
        && parseInbound(event).imageUrls.length > 0) {
        {
          const entry = await this.emoji.steal(event)
          if (entry !== null && this.emojiLibrary !== null && this.client !== null) {
            const refs = parseInbound(event).imageUrls
            void (async () => {
              try {
                const url = refs[0]
                if (url === undefined) return
                const res = await fetch(url)
                if (!res.ok) return
                const buf = Buffer.from(await res.arrayBuffer())
                const mediaType = res.headers.get('content-type')?.split(';')[0] ?? 'image/jpeg'
                await this.emojiLibrary?.tagEntry(this.ctx, entry, buf, mediaType)
                await this.emojiLibrary?.save()
              } catch { /* best-effort */ }
            })()
          }
        }
      }
      if (event.post_type === 'notice') {
        await this.bridge.handleNotice(event)
        return
      }
      if (event.post_type !== 'message') return
      await this.bridge.handleEvent(event)
    } catch (error) {
      this.ctx.logger.error(`channel-qq: event handling failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export default ChannelQQ
