/** QQ agent tools: thin OneBot v11 wrappers registered on the global tools registry.
 *
 * Subset ported from the OpenClaw extension's manifest tools — the ones that
 * are pure protocol calls. Anything needing the old enhancement subsystems
 * (model-caller rotation, persona manager) is intentionally not ported.
 * Approval policy stays with the harness's permission presets.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { QQChannelConfig } from './config.js'
import type { OneBotClient } from './onebot.js'
import type { EmojiLibrary } from './emoji-library.js'
import { searchSongs as neteaseSearch, songUrl as neteaseSongUrl, qrLoginStart, qrLoginPoll, loginStatus as neteaseLoginStatus, saveCookie as neteaseSaveCookie, loadCookie as neteaseLoadCookie } from './netease-vip.js'
import { searchSongs as kugouSearch, songUrl as kugouSongUrl, qrLoginStart as kugouQrStart, qrLoginPoll as kugouQrPoll } from './kugou-api.js'
import type { OutboundQueue } from './outbound.js'
import { segmentReply, smartSplitMessage } from './outbound.js'
import type { SentLog } from './sent-log.js'
import type { KnowledgeEntry, KnowledgeStore } from './knowledge.js'
import type { AffectionStore } from './affection.js'
import { qwenSayToSilk } from './qwen-tts.js'
import QRCode from 'qrcode'
import { drawImage } from './image-gen.js'

interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<unknown>
}

/** 群聊内心戏外泄闸门：这些形状是内部盘算/舞台指示，永远不该当群消息发出去。 */
export function isInnerMonologueLeak(text: string): boolean {
  const t = text.trim()
  if (t.length < 4) return false
  if (/^(本轮|这轮)[^，。]{0,6}(不发|沉默|不发言|闭嘴)/.test(t)) return true
  if (/(不发|沉默|闭嘴|不说话)[。.!！]?$/.test(t) && t.length <= 30) return true
  if (/^(保持沉默|先闭嘴|本轮巡逻|巡逻结论|战况)/.test(t)) return true
  // 舞台指示占比过高：括号内字符数超过全文一半，是独白不是聊天
  const inner = (t.match(/[（(][^（）()]*[）)]/g) ?? []).join('')
  if (t.length > 20 && inner.length >= t.length * 0.5) return true
  // 内部盘算关键词 + 舞台括号 同现
  if (/[（(]/.test(t) && /(战况分析|守则照旧|后台|盘算|内心|这轮先闭嘴|饭点不追)/.test(t)) return true
  return false
}

export function registerQQTools(ctx: Context, config: QQChannelConfig, client: OneBotClient, out: OutboundQueue, log: (line: string) => void, library?: EmojiLibrary, affection?: { book(delta: number, reason: string): Promise<unknown>; setStage(stage: string, event: string): Promise<{ ok: boolean; note: string }>; writeCustomHtml(html: string): Promise<void> }, sentLog?: SentLog, knowledge?: KnowledgeStore, bridge?: { readonly dmPeers: ReadonlySet<number>; readonly groupIds: ReadonlySet<number> }): () => void {
  const disposers: Array<() => void> = []
  const tools = (ctx as { tools?: { register(definition: Record<string, unknown>): () => void } }).tools
  if (tools === undefined) {
    log('tools service unavailable; QQ tools not registered')
    return () => {}
  }

  const specs: ToolSpec[] = [
    {
      name: 'qq_send_text',
      description: '发送一条QQ文本消息。isGroup=true 时 target 为群号，否则为好友QQ号。当前会话窗口的归属见系统包里的【本会话是QQ群/私聊】标注——往哪发必须与之一致，发错窗口是大事故。',
      parameters: {
        type: 'object',
        properties: {
          isGroup: { type: 'boolean', description: '是否发送到群聊' },
          target: { type: 'number', description: '群号或好友QQ号' },
          text: { type: 'string', description: '消息文本' },
        },
        required: ['isGroup', 'target', 'text'],
      },
      run: async (args) => {
        const text = String(args.text ?? '').trim().replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim()
        if (text === '') throw new Error('消息文本为空（只有思考没有正文），先想清楚要说什么再发。')
        // 【发前验证窗口】先查目标是否真实存在/正确，再发
        if (args.isGroup === true) {
          const gi = await client.call('get_group_info', { group_id: args.target }, 8000).catch(() => null) as { group_name?: string } | null
          if (!gi || !gi.group_name) throw new Error(`窗口验证失败：群 ${args.target} 不存在或不可达。别发了，先核对窗口。`)
        // Collision guard: a number that is BOTH a real group id and a DM peer is
        // ambiguous to the model — the DM peer reading always wins; refuse the
        // group send so a private reply can never leak into the same-numbered group.
        if (bridge?.dmPeers.has(Number(args.target))) throw new Error(`窗口验证失败：${args.target} 是私聊对方的QQ号，不是群号。要发私聊请用 isGroup=false、target=${args.target}。`)
        if (args.isGroup !== true && bridge?.groupIds.has(Number(args.target))) {
          throw new Error(`窗口验证失败：${args.target} 是群号，不是私聊对象。要发群请用 isGroup=true、target=${args.target}。`)
        }


        } else {
          const fi = await client.call('get_friend_list', {}, 8000).catch(() => null) as Array<{ user_id?: number; nickname?: string; remark?: string }> | null
          const friend = Array.isArray(fi) ? fi.find(f => Number(f.user_id) === Number(args.target)) : null
          if (!friend && Number(args.target) !== Number(config.admins[0] ?? 0)) {
            throw new Error(`窗口验证失败：${args.target} 不是咱的好友也不是同学。别给陌生人发私聊。`)
          }
        }
        // 群聊代码禁令：代码块/书源代码不允许出现在群里
        if (args.isGroup === true && /```|<[a-z][a-z0-9]*>|function |const |import |def |#include/i.test(text)) {
          throw new Error('群聊禁止发代码。请改用 qq_send_code_review 把代码私信给同学审核，群里只回一句"已私信同学审核"。')
        }
        // 内心戏外泄闸门：沉默决定/舞台指示/战况盘算不是群消息
        if (args.isGroup === true && isInnerMonologueLeak(text)) {
          log(`blocked inner-monologue leak: ${text.slice(0, 40)}`)
          throw new Error('这条是咱的内部盘算/舞台指示，不是要说的话，已拦下。要么把真正要对群里说的那句话发出来，要么不调用任何发送工具直接结束回合。')
      }
        // 目标合法性：群只发咱配置过的群；私聊只发管理员（同学）
        if (args.isGroup === true) {
          const known = [config.primaryGroup].filter(x => x !== null && x !== undefined)
          if (!known.includes(Number(args.target))) {
            throw new Error(`目标群 ${args.target} 不在咱的配置里（known: ${known.join(',')}）。发错窗口是大事故，先核对。`)
          }
        } else {
          const master = config.admins[0]
          if (master !== undefined && Number(args.target) !== master && !config.admins.includes(Number(args.target))) {
            throw new Error(`私聊目标 ${args.target} 不是管理员。除同学外不要私聊陌生人。`)
          }
        }
        // 2026-09-26 同学令：智能分段——按句号/段落一句一段地发，不再整坨
        const piecesRaw = config.segmentation.enabled ? segmentReply(text, config) : [text]
        const pieces = piecesRaw.length > 0 ? piecesRaw : [text]
        let lastResult: unknown = null
        for (const piece of pieces) {
          for (const chunk of smartSplitMessage(piece, config.maxMessageLength)) {
            const message = [{ type: 'text', data: { text: chunk } }]
            lastResult = args.isGroup === true
              ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
              : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }))
            if (sentLog) {
              const mid = (lastResult as { data?: { message_id?: number } })?.data?.message_id ?? null
              await sentLog.add({ messageId: typeof mid === 'number' ? mid : null, quotedId: null, text: chunk, time: Date.now() })
            }
          }
        }
        return lastResult
      },
    },
    {
      name: 'qq_reply_quote',
      description: '引用回复某条消息：带上对方消息的#编号发一条引用回复，让对方明确知道咱回应的是哪条。文本里不要重复#编号。',
      parameters: {
        type: 'object',
        properties: {
          isGroup: { type: 'boolean', description: '是否群聊' },
          target: { type: 'number', description: '群号或对方QQ号' },
          messageId: { type: 'number', description: '要引用的消息#编号（来自上下文包）' },
          text: { type: 'string', description: '回复正文' },
        },
        required: ['isGroup', 'target', 'messageId', 'text'],
      },
      run: async (args) => {
        const text = String(args.text ?? '').trim().replace(/<思考>[\s\S]*?<\/思考>\s*/g, '').trim()
        if (text === '') throw new Error('回复文本为空（只有思考没有正文）。引用哪条、说什么，想好了再发。')
        // 【发前验证窗口】群引用必须验证群真实存在
        if (args.isGroup === true) {
          const gi = await client.call('get_group_info', { group_id: args.target }, 8000).catch(() => null) as { group_name?: string } | null
          if (!gi || !gi.group_name) throw new Error(`窗口验证失败：群 ${args.target} 不存在或不可达。先核对窗口再引用回复。`)
        // Collision guard: a number that is BOTH a real group id and a DM peer is
        // ambiguous to the model — the DM peer reading always wins; refuse the
        // group send so a private reply can never leak into the same-numbered group.
        if (bridge?.dmPeers.has(Number(args.target))) throw new Error(`窗口验证失败：${args.target} 是私聊对方的QQ号，不是群号。要发私聊请用 isGroup=false、target=${args.target}。`)
        if (args.isGroup !== true && bridge?.groupIds.has(Number(args.target))) {
          throw new Error(`窗口验证失败：${args.target} 是群号，不是私聊对象。要发群请用 isGroup=true、target=${args.target}。`)
        }


        }
        if (args.isGroup === true && /```|<[a-z][a-z0-9]*>|function |const |import |def |#include/i.test(text)) {
          throw new Error('群聊禁止发代码。请改用 qq_send_code_review 把代码私信给同学审核，群里用引用只回一句"已私信同学审核"。')
        }
        // 内心戏外泄闸门：沉默决定/舞台指示/战况盘算不是群消息
        if (args.isGroup === true && isInnerMonologueLeak(text)) {
          log(`blocked inner-monologue leak (quote): ${text.slice(0, 40)}`)
          throw new Error('这条是咱的内部盘算/舞台指示，不是要说的话，已拦下。要么把真正要对群里说的那句话引用发出来，要么不调用任何发送工具直接结束回合。')
        }
        // 2026-09-26 同学令：引用回复同样智能分段——引用只挂第一段
        const piecesRaw = config.segmentation.enabled ? segmentReply(text, config) : [text]
        const pieces = piecesRaw.length > 0 ? piecesRaw : [text]
        let lastResult: unknown = null
        let first = true
        for (const piece of pieces) {
          for (const chunk of smartSplitMessage(piece, config.maxMessageLength)) {
            const message: Array<Record<string, unknown>> = []
            if (first) message.push({ type: 'reply', data: { id: String(args.messageId) } })
            message.push({ type: 'text', data: { text: chunk } })
            first = false
            lastResult = args.isGroup === true
              ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
              : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }))
            if (sentLog) {
              const mid = (lastResult as { data?: { message_id?: number } })?.data?.message_id ?? null
              await sentLog.add({ messageId: typeof mid === 'number' ? mid : null, quotedId: first ? Number(args.messageId) || null : null, text: chunk, time: Date.now() })
            }
          }
        }
        return lastResult
      },
    },
    {
      name: 'qq_send_code_review',
      description: '【群聊代码专用】群聊禁止出现代码。有人在群里要求写代码时，把完整代码用这个工具私信发给同学（管理员）审核，群里只回一句"代码已私信发给同学审核"。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '完整代码内容' },
          note: { type: 'string', description: '一句话说明这段代码是干什么的、谁要的' },
        },
        required: ['code'],
      },
      run: async (args) => {
        const master = config.admins[0]
        if (master === undefined) throw new Error('没有配置管理员QQ')
        const text = `【代码审核】${String(args.note ?? '')}

${String(args.code ?? '')}`
        const message = [{ type: 'text', data: { text } }]
        return out.push(() => client.call('send_private_msg', { user_id: master, message }))
      },
    },
    {
      name: 'qq_set_affection',
      description: '【好感度记账】同学的一句话/一个举动让咱心里起波澜时，用这个记账。delta 是变化值（-30~30），reason 写同学做了什么。每次变化都要记，绝不漏账。',
      parameters: {
        type: 'object',
        properties: {
          delta: { type: 'number', description: '变化值：夸咱/护咱/投喂 +5~10，冷落/凶咱 -3~5' },
          reason: { type: 'string', description: '原因一句话' },
        },
        required: ['delta', 'reason'],
      },
      run: async (args) => {
        if (affection === undefined || affection === null) return { booked: false, note: '好感度系统未启用' }
        return affection.book(Number(args.delta ?? 0), String(args.reason ?? ''))
      },
    },
    {
      name: 'qq_set_stage',
      description: '【阶段宣言】阶段完全由咱自己定义：根据咱的记忆，说出当前真实的阶段名和理由。可以升、可以降、可以改名——说最真实的话就行。每次变更都会记入阶段史。',
      parameters: {
        type: 'object',
        properties: {
          stage: { type: 'string', description: '目标阶段名（必须是阶梯里的名字）' },
          event: { type: 'string', description: '触发晋升的特殊事件描述（原文+时间）' },
        },
        required: ['stage', 'event'],
      },
      run: async (args) => {
        if (affection === undefined || affection === null) return { ok: false, note: '好感度系统未启用' }
        return affection.setStage(String(args.stage ?? ''), String(args.event ?? ''))
      },
    },
    {
      name: 'qq_write_dashboard',
      description: '【咱自己的记分板】重写好感度悬浮窗的HTML页面（咱完全掌控的记分小黑板）。写好后立即生效。想要什么样式自己定：阶段、日记入口、小本本都随咱排。',
      parameters: {
        type: 'object',
        properties: {
          html: { type: 'string', description: '完整的HTML文档（会替换整个悬浮窗页面）' },
        },
        required: ['html'],
      },
      run: async (args) => {
        if (affection === undefined || affection === null) return { ok: false, note: '好感度系统未启用' }
        const html = String(args.html ?? '')
        if (html.length < 100) throw new Error('HTML太短，认真写')
        await affection.writeCustomHtml(html)
        return { ok: true, bytes: html.length, note: '悬浮窗页面已更新' }
      },
    },
    {
      name: 'retrieve_knowledge',
      description: '检索咱的长期知识库（从日记和群聊沉淀的技能/事实/偏好/事件/人物）。回答不确定的问题前先搜这里。',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '自然语言查询' } },
        required: ['query'],
      },
      run: async (args) => {
        if (!knowledge) return { note: '知识库未启用' }
        const hits = knowledge.search(String(args.query ?? ''), 5)
        for (const h of hits) { void knowledge.reinforce(h.id).catch(() => {}) }
        return { count: hits.length, results: hits.map((e: KnowledgeEntry) => ({ type: e.type, content: e.content, tags: e.tags, source: e.source, date: new Date(e.created).toISOString().slice(0, 10) })) }
      },
    },
    {
      name: 'extract_knowledge',
      description: '把你判断值得长期记住的知识条目入库（内容全部由你自己判断提炼，不调用任何外部 API）。别对日常寒暄用。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '来源简述（如：日记 2026-09-26）' },
          entries: {
            type: 'array',
            description: '你自己提炼出的知识条目数组',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '知识正文（一句完整的话，≥4字）' },
                tags: { type: 'array', items: { type: 'string' }, description: '标签（可选）' },
              },
              required: ['content'],
            },
          },
        },
        required: ['source', 'entries'],
      },
      run: async (args) => {
        if (!knowledge) return { note: '知识库未启用' }
        const src = String(args.source ?? '')
        const arr = Array.isArray(args.entries) ? args.entries as Array<{ content?: unknown; tags?: unknown }> : []
        const items = arr.map(x => ({
          type: 'fact' as const,
          content: String(x.content ?? ''),
          tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
          source: src,
        })).filter(x => x.content.length >= 4)
        const added = await knowledge.addMany(items)
        return { added }
      },
    },
    {
      name: 'qq_send_poke',
      description: '戳一戳群成员。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number', description: '群号' },
          userId: { type: 'number', description: '要戳的用户QQ号' },
        },
        required: ['groupId', 'userId'],
      },
      run: async (args) => client.call('group_poke', { group_id: args.groupId, user_id: args.userId }),
    },
    {
      name: 'qq_set_group_card',
      description: '设置群名片（群昵称）。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          userId: { type: 'number' },
          card: { type: 'string', description: '新群名片，空字符串删除名片' },
        },
        required: ['groupId', 'userId', 'card'],
      },
      run: async (args) => client.call('set_group_card', { group_id: args.groupId, user_id: args.userId, card: args.card }),
    },
    {
      name: 'qq_group_ban',
      description: '禁言群成员，时长60-300秒。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          userId: { type: 'number' },
          duration: { type: 'number', description: '禁言秒数（60-300）' },
        },
        required: ['groupId', 'userId'],
      },
      run: async (args) => {
        const duration = Math.min(Math.max(Number(args.duration ?? 60), 60), 300)
        return client.call('set_group_ban', { group_id: args.groupId, user_id: args.userId, duration })
      },
    },
    {
      name: 'qq_get_group_member_info',
      description: '查询群成员资料（昵称、群名片、角色等）。',
      parameters: {
        type: 'object',
        properties: { groupId: { type: 'number' }, userId: { type: 'number' } },
        required: ['groupId', 'userId'],
      },
      run: async (args) => client.call('get_group_member_info', { group_id: args.groupId, user_id: args.userId, no_cache: false }),
    },
    {
      name: 'qq_get_group_info',
      description: '查询群资料（群名、成员数、上限等）。',
      parameters: {
        type: 'object',
        properties: { groupId: { type: 'number' } },
        required: ['groupId'],
      },
      run: async (args) => client.call('get_group_info', { group_id: args.groupId, no_cache: false }),
    },
    {
      name: 'qq_get_msg',
      description: '按消息ID获取消息内容。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: 'number' } },
        required: ['messageId'],
      },
      run: async (args) => client.call('get_msg', { message_id: args.messageId }),
    },
    {
      name: 'qq_delete_msg',
      description: '撤回一条消息（需要对应权限）。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: 'number' } },
        required: ['messageId'],
      },
      run: async (args) => client.call('delete_msg', { message_id: args.messageId }),
    },
    {
      name: 'qq_send_emoji',
      description: '发送一张本地表情包图片（stolen/registered 目录中的文件名）。',
      parameters: {
        type: 'object',
        properties: {
          isGroup: { type: 'boolean' },
          target: { type: 'number' },
          file: { type: 'string', description: '本地图片绝对路径' },
        },
        required: ['isGroup', 'target', 'file'],
      },
      run: async (args) => {
        const message = [{ type: 'image', data: { file: `file://${args.file}` } }]
        return args.isGroup === true
          ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
          : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }))
      },
    },
    {
      name: 'qq_group_kick',
      description: '将成员移出群聊（踢人）。慎重使用。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          userId: { type: 'number' },
          rejectAddRequest: { type: 'boolean', description: '是否拒绝此人再次加群' },
        },
        required: ['groupId', 'userId'],
      },
      run: async (args) => client.call('set_group_kick', {
        group_id: args.groupId, user_id: args.userId,
        reject_add_request: args.rejectAddRequest === true,
      }),
    },
    {
      name: 'qq_group_whole_ban',
      description: '开启或关闭全员禁言。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          enable: { type: 'boolean', description: 'true=开启全员禁言，false=关闭' },
        },
        required: ['groupId', 'enable'],
      },
      run: async (args) => client.call('set_group_whole_ban', { group_id: args.groupId, enable: args.enable === true }),
    },
    {
      name: 'qq_set_group_admin',
      description: '设置或取消群成员的管理员身份。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          userId: { type: 'number' },
          enable: { type: 'boolean', description: 'true=设为管理员，false=取消' },
        },
        required: ['groupId', 'userId', 'enable'],
      },
      run: async (args) => client.call('set_group_admin', { group_id: args.groupId, user_id: args.userId, enable: args.enable === true }),
    },
    {
      name: 'qq_get_group_list',
      description: '获取咱加入的所有群列表（群号、群名、成员数）。',
      parameters: { type: 'object', properties: {} },
      run: async () => client.call('get_group_list'),
    },
    {
      name: 'qq_get_friend_list',
      description: '获取好友列表（QQ号、昵称、备注）。',
      parameters: { type: 'object', properties: {} },
      run: async () => client.call('get_friend_list'),
    },
    {
      name: 'qq_set_essence',
      description: '设置一条消息为群精华（好好记就收进精华）。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: 'number', description: '消息#编号' } },
        required: ['messageId'],
      },
      run: async (args) => client.call('set_essence_msg', { message_id: args.messageId }),
    },
    {
      name: 'qq_delete_essence',
      description: '移除一条群精华。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: 'number' } },
        required: ['messageId'],
      },
      run: async (args) => client.call('delete_essence_msg', { message_id: args.messageId }),
    },
    {
      name: 'qq_get_essence_list',
      description: '获取群精华消息列表（用于整理精华、翻重要记录）。',
      parameters: {
        type: 'object',
        properties: { groupId: { type: 'number' } },
        required: ['groupId'],
      },
      run: async (args) => client.call('get_essence_msg_list', { group_id: args.groupId }),
    },
    {
      name: 'qq_list_group_files',
      description: '列出群文件系统（文件、文件夹、大小、上传者），用于整理群文件。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          folderId: { type: 'string', description: '文件夹ID，不填=根目录' },
        },
        required: ['groupId'],
      },
      run: async (args) => args.folderId !== undefined
        ? client.call('get_group_files_by_folder', { group_id: args.groupId, folder_id: args.folderId })
        : client.call('get_group_root_files', { group_id: args.groupId }),
    },
    {
      name: 'qq_upload_group_file',
      description: '上传本地文件到群文件系统（可以从咱的工作区里挑文件发）。file 是本地绝对路径。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          file: { type: 'string', description: '本地文件绝对路径' },
          name: { type: 'string', description: '显示的文件名' },
          folderId: { type: 'string', description: '目标文件夹ID，不填=根目录' },
        },
        required: ['groupId', 'file'],
      },
      run: async (args) => client.call('upload_group_file', {
        group_id: args.groupId,
        file: String(args.file),
        name: String(args.name ?? String(args.file).replace(/^.*[\\/]/, '')),
        ...(args.folderId !== undefined ? { folder_id: args.folderId } : {}),
      }),
    },
    {
      name: 'qq_download_group_file',
      description: '下载群文件到咱的工作区（先拿链接再存盘），存好返回本地路径。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          fileId: { type: 'string', description: '群文件ID（来自文件列表）' },
          saveAs: { type: 'string', description: '保存的文件名，存到工作区 downloads/ 下' },
        },
        required: ['groupId', 'fileId'],
      },
      run: async (args) => {
        const urlData = await client.call('get_group_file_url', { group_id: args.groupId, file_id: args.fileId }) as { url?: string }
        if (typeof urlData?.url !== 'string' || urlData.url === '') throw new Error('拿不到群文件下载链接')
        const res = await fetch(urlData.url)
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
        const bytes = Buffer.from(await res.arrayBuffer())
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const wsRoot = config.workspacePath ?? process.cwd()
        const dir = path.join(wsRoot, 'downloads')
        await fs.mkdir(dir, { recursive: true })
        const safeName = String(args.saveAs ?? `file_${Date.now()}`).replace(/[\/:*?"<>|]/g, '_')
        const target = path.join(dir, safeName)
        await fs.writeFile(target, bytes)
        return { saved: target, size: bytes.length }
      },
    },
    {
      name: 'qq_create_file_folder',
      description: '在群文件系统里新建文件夹（整理群文件用）。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          folderName: { type: 'string', description: '文件夹名' },
          parentId: { type: 'string', description: '父文件夹ID，不填=根目录' },
        },
        required: ['groupId', 'folderName'],
      },
      run: async (args) => client.call('create_group_file_folder', {
        group_id: args.groupId,
        folder_name: String(args.folderName),
        parent_id: String(args.parentId ?? '/'),
      }),
    },
    {
      name: 'qq_move_group_file',
      description: '移动群文件（拖动到别的文件夹）。目录ID来自文件列表。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          fileId: { type: 'string', description: '文件ID' },
          currentParentDirectory: { type: 'string', description: '当前父目录ID' },
          targetParentDirectory: { type: 'string', description: '目标父目录ID' },
        },
        required: ['groupId', 'fileId', 'currentParentDirectory', 'targetParentDirectory'],
      },
      run: async (args) => client.call('move_group_file', {
        group_id: String(args.groupId),
        file_id: String(args.fileId),
        current_parent_directory: String(args.currentParentDirectory),
        target_parent_directory: String(args.targetParentDirectory),
      }),
    },
    {
      name: 'qq_rename_group_file',
      description: '重命名群文件。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          fileId: { type: 'string' },
          currentParentDirectory: { type: 'string', description: '当前父目录ID' },
          newName: { type: 'string', description: '新文件名' },
        },
        required: ['groupId', 'fileId', 'currentParentDirectory', 'newName'],
      },
      run: async (args) => client.call('rename_group_file', {
        group_id: String(args.groupId),
        file_id: String(args.fileId),
        current_parent_directory: String(args.currentParentDirectory),
        new_name: String(args.newName),
      }),
    },
    {
      name: 'qq_delete_group_file',
      description: '删除群文件。慎重使用。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          fileId: { type: 'string' },
        },
        required: ['groupId', 'fileId'],
      },
      run: async (args) => client.call('delete_group_file', { group_id: args.groupId, file_id: String(args.fileId) }),
    },
    {
      name: 'qq_list_emojis',
      description: '列出咱收藏的表情包（本地文件路径）。发表情前先列出来挑一张合适的。',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        if (library !== undefined) {
          const entries = library.list(40)
          return {
            count: entries.length,
            emojis: entries.map((e) => ({ file: e.file, source: e.source, desc: e.desc, tags: e.tags })),
          }
        }
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const emojiCfg = config.emoji
        const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
        const dir = emojiCfg.dir ?? path.join(home, 'channel-qq', 'emoji')
        const regDir = emojiCfg.registeredDir ?? path.join(dir, '..', 'emoji-registered')
        const out: Array<{ file: string; source: string }> = []
        for (const [d, source] of [[regDir, 'registered'], [dir, 'stolen']] as const) {
          try {
            for (const f of await fs.readdir(d)) {
              if (!f.startsWith('.')) out.push({ file: path.join(d, f), source })
            }
          } catch {}
        }
        return { count: out.length, emojis: out.slice(0, 60) }
      },
    },
    {
      name: 'qq_search_emojis',
      description: '按情绪/语义搜索咱收藏的表情包（比如：嘲讽、开心、摸鱼、吃瓜）。返回最匹配的几张的文件路径和描述，用 qq_send_emoji 发送其中 file。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '情绪或语义关键词，如 嘲讽 / 开心 / 吃瓜' },
          limit: { type: 'number', description: '最多返回几张（默认5）' },
        },
        required: ['query'],
      },
      run: async (args) => {
        if (library === undefined) return { error: '表情库未启用', emojis: [] }
        const hits = library.search(String(args.query ?? ''), Math.min(Number(args.limit ?? 5), 10))
        return { count: hits.length, emojis: hits }
      },
    },
    {
      name: 'qq_emoji_stats',
      description: '看表情库统计：总数、已打标数、常用标签 top10。',
      parameters: { type: 'object', properties: {} },
      run: async () => {
        if (library === undefined) return { error: '表情库未启用' }
        const entries = library.list(100000)
        const tagCount: Record<string, number> = {}
        let tagged = 0
        for (const e of entries) {
          if (e.tags.length > 0) tagged += 1
          for (const t of e.tags) tagCount[t] = (tagCount[t] ?? 0) + 1
        }
        const top = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 10)
        return { total: entries.length, tagged, topTags: top }
      },
    },
    {
      name: 'qq_search_history',
      description: '搜索本群/私聊的完整聊天记录（含已被折叠的旧消息）。可按关键词、发送者QQ号、日期过滤，返回带时间戳和#编号的消息列表。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '关键词（消息文本包含即命中）' },
          senderId: { type: 'number', description: '按发送者QQ号过滤' },
          sinceDate: { type: 'string', description: '起始日期 YYYY-MM-DD（含）' },
          untilDate: { type: 'string', description: '结束日期 YYYY-MM-DD（含）' },
          limit: { type: 'number', description: '最多返回条数（默认20，上限50）' },
        },
        required: [],
      },
      run: async (args) => {
        const fsMod = await import('node:fs/promises')
        const zlib = await import('node:zlib')
        const pathMod = await import('node:path')
        const home = process.env.DSH_HOME ?? pathMod.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
        const sid = String(args.sessionId ?? (process.env.DSH_QQ_PRIMARY_SESSION ? 'qq-group-' + process.env.DSH_QQ_PRIMARY_SESSION : 'qq-group-0'))
        const file = home + '\\sessions\\--D-OpenClaw-.openclaw-workspace--\\' + sid + '\\session.v3.jsonl.zstd'
        let jsonl: string
        try {
          const buf = await fsMod.readFile(file)
          jsonl = zlib.zstdDecompressSync(buf).toString('utf8')
        } catch (error) {
          return { error: '会话日志不可读: ' + String(error).slice(0, 80) }
        }
        const keyword = args.keyword === undefined ? null : String(args.keyword)
        const sender = args.senderId === undefined ? null : Number(args.senderId)
        const since = args.sinceDate === undefined ? null : String(args.sinceDate)
        const until = args.untilDate === undefined ? null : String(args.untilDate)
        const limit = Math.min(Number(args.limit ?? 20), 50)
        const hits: Array<{ time: string; sender: string; userId: number; msgId: string; text: string }> = []
        for (const line of jsonl.split('\n')) {
          if (!line.includes('"type":"user/message"')) continue
          try {
            const e = JSON.parse(line)
            const content = e.data?.content
            if (!Array.isArray(content)) continue
            const text = content.filter((b: { type: string }) => b.type === 'text').map((b: { text?: string }) => b.text ?? '').join(' ')
            if (text === '') continue
            const iso = new Date(e.time).toISOString().slice(0, 10)
            if (since !== null && iso < since) continue
            if (until !== null && iso > until) continue
            if (keyword !== null && !text.includes(keyword)) continue
            const src = e.data?.source ?? {}
            const uid = Number(src.userId ?? src.user_id ?? 0)
            if (sender !== null && uid !== sender) continue
            const senderName = e.data?.senderName ?? String(uid)
            hits.push({ time: new Date(e.time).toISOString(), sender: senderName, userId: uid, msgId: '#' + String(e.data?.messageId ?? e.seq), text: text.slice(0, 300) })
            if (hits.length >= limit) break
          } catch { continue }
        }
        return { count: hits.length, hits }
      },
    },
    {
      name: 'qq_send_voice',
      description: '把一段本地音频文件当语音条发出去（mp3/wav等常规格式均可，NapCat 自动转 silk）。想用自定义音色就先用外部 TTS 生成音频文件再发。',
      parameters: {
        type: 'object',
        properties: {
          isGroup: { type: 'boolean' },
          target: { type: 'number', description: '群号或对方QQ号' },
          file: { type: 'string', description: '本地音频文件绝对路径（mp3/wav/silk等）' },
        },
        required: ['isGroup', 'target', 'file'],
      },
      run: async (args) => {
        const message = [{ type: 'record', data: { file: `file://${args.file}` } }]
        return args.isGroup === true
          ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
          : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }))
      },
    },
    {
      name: 'qq_can_send_voice',
      description: '检测当前 QQ 实例是否具备发语音条的能力。',
      parameters: { type: 'object', properties: {} },
      run: async () => client.call('can_send_record'),
    },
    {
      name: 'qq_send_ai_voice',
      description: 'QQ自带AI语音（百变变声器）：选一个音色把文字念成语音条发到群里。character 是QQ音色ID（如 ai_char_1 这类，不存在的会报错，换一个试）。仅限群聊。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number' },
          character: { type: 'string', description: 'QQ音色ID，如 ai_char_1' },
          text: { type: 'string', description: '要念的文字，别太长' },
        },
        required: ['groupId', 'character', 'text'],
      },
      run: async (args) => out.push(() => client.call('send_group_ai_record', {
        character: String(args.character),
        group_id: String(args.groupId),
        text: String(args.text ?? ''),
      })),
    },
    {
      name: 'qq_get_ai_voice_url',
      description: '获取QQ AI语音的音频URL（不发出去）。配合下载后可用 qq_send_voice 当语音条发到任意会话——这是私聊用AI音色的办法。',
      parameters: {
        type: 'object',
        properties: {
          groupId: { type: 'number', description: 'AI语音按群开通，传群号' },
          character: { type: 'string', description: 'QQ音色ID' },
          text: { type: 'string' },
        },
        required: ['groupId', 'character', 'text'],
      },
      run: async (args) => client.call('get_ai_record', {
        character: String(args.character),
        group_id: String(args.groupId),
        text: String(args.text ?? ''),
      }),
    },
    {
      name: 'qq_get_file_url',
      description: '拿私聊/群文件的下载链接（fileId 来自文件消息或群文件列表）。',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '文件ID' },
        },
        required: ['fileId'],
      },
      run: async (args) => client.call('get_private_file_url', { file_id: String(args.fileId) }),
    },
    {
      name: 'qq_make_svg',
      description: '画一张 SVG 图片或动画（画图、动画、图表类请求都用它）。返回保存后的文件路径；SVG 是文件不是聊天消息，生成后要用 qq_send_private_file 发给同学（群里合适就 qq_upload_group_file），并提醒对方用浏览器打开才能看到动画。',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: '文件名：英文加连字符、以 .svg 结尾，如 master-bike.svg' },
          svg: { type: 'string', description: '完整 SVG 源码，含 <svg> 根元素；动画用 SMIL 的 <animate>/<animateTransform> 写在内部' },
        },
        required: ['filename', 'svg'],
      },
      run: async (args) => {
        const fs = await import('node:fs/promises')
        const path = await import('node:path')
        const safe = String(args.filename ?? '').replace(/[^a-zA-Z0-9._-]/g, '_')
        if (!safe.endsWith('.svg')) throw new Error('filename 必须以 .svg 结尾')
        const svg = String(args.svg ?? '')
        if (!svg.includes('<svg')) throw new Error('内容不是 SVG（缺 <svg> 根元素）')
        const dir = config.workspacePath !== null
          ? path.join(config.workspacePath, 'art')
          : path.join(process.env.HOME ?? '.', '.dsh', 'channel-qq', 'art')
        await fs.mkdir(dir, { recursive: true })
        const target = path.join(dir, safe)
        await fs.writeFile(target, svg, 'utf-8')
        log(`make_svg: wrote ${target} (${svg.length} bytes)`)
        return { ok: true, path: target, bytes: svg.length }
      },
    },
    {
      name: 'qq_say',
      description: '把一段文字用语音条说出来（默认音色：鹿·沈曦，小女孩；默认情绪：温柔喜悦）。适合打招呼、撒娇、说重点；太长的内容还是用文字。voice 可换：沈曦、幼年葛术（鹿·女童）、起司妹妹、小酒窝、彩虹甜豆、念念、若初。鹿系音色还支持 emotion：欢快明亮/温柔喜悦/温柔安抚/哽咽泣诉/惊讶错愕/慵懒微醺等24种。',
      parameters: {
        type: 'object',
        properties: {
          isGroup: { type: 'boolean', description: '是否发到群聊' },
          target: { type: 'number', description: '群号或对方QQ号（照会话包标注填）' },
          text: { type: 'string', description: '要念的文字，口语化、别太长（建议60字内）' },
          voice: { type: 'string', description: '音色名，默认 沈曦' },
          emotion: { type: 'string', description: '鹿系音色的情绪，默认 温柔喜悦' },
        },
        required: ['isGroup', 'target', 'text'],
      },
      run: async (args) => {
        if (args.isGroup === true && bridge?.dmPeers.has(Number(args.target))) {
          throw new Error(`窗口验证失败：${args.target} 是私聊对方的QQ号，不是群号。要发私聊请用 isGroup=false。`)
        if (args.isGroup !== true && bridge?.groupIds.has(Number(args.target))) {
          throw new Error(`窗口验证失败：${args.target} 是群号，不是私聊对象。要发群请用 isGroup=true、target=${args.target}。`)
        }

        }
        const { silkPath, durationMs, voice, emotion } = await qwenSayToSilk(String(args.text ?? ''), {
          voice: args.voice === undefined ? undefined : String(args.voice),
          emotion: args.emotion === undefined ? undefined : String(args.emotion),
        })
        const message = [{ type: 'record', data: { file: `file://${silkPath}` } }]
        const sent = args.isGroup === true
          ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
          : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }))
        log(`say: voice=${voice} emotion=${emotion ?? '-'} duration=${Math.round(durationMs / 100) / 10}s -> ${args.isGroup === true ? 'group' : 'dm'} ${args.target}`)
        return { ok: true, voice, emotion, durationMs, ...sent as object }
      },
    },
    {
      name: 'qq_draw',
      description: '文生图：把一段描述变成一张真正的图片发出去（不是SVG示意图，是AI画的照片级图片）。默认模型 seedream-5.0（中文理解好，约1分钟）；要快可填 model: nano-banana 或 flux-schnell；要极致质量用 seedream-5.0-pro。prompt 用具体画面描述（主体+风格+细节），英文提示词通常效果更稳。',
      parameters: {
        type: 'object',
        properties: {
          isGroup: { type: 'boolean', description: '是否发到群聊' },
          target: { type: 'number', description: '群号或对方QQ号（照会话包标注填）' },
          prompt: { type: 'string', description: '画面描述：主体+动作+风格+细节' },
          model: { type: 'string', description: '模型，默认 seedream-5.0' },
          size: { type: 'string', description: '尺寸，默认 1024x1024，可 1344x768 等横图' },
        },
        required: ['isGroup', 'target', 'prompt'],
      },
      run: async (args) => {
        if (args.isGroup === true && bridge?.dmPeers.has(Number(args.target))) {
          throw new Error(`窗口验证失败：${args.target} 是私聊对方的QQ号，不是群号。要发私聊请用 isGroup=false。`)
        if (args.isGroup !== true && bridge?.groupIds.has(Number(args.target))) {
          throw new Error(`窗口验证失败：${args.target} 是群号，不是私聊对象。要发群请用 isGroup=true、target=${args.target}。`)
        }

        }
        const { imagePath, model, bytes } = await drawImage({
          prompt: String(args.prompt ?? ''),
          model: args.model === undefined ? undefined : String(args.model),
          size: args.size === undefined ? undefined : String(args.size),
        })
        const message = [{ type: 'image', data: { file: `file://${imagePath}` } }]
        const sent = args.isGroup === true
          ? await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
          : await out.push(() => client.call('send_private_msg', { user_id: args.target, message }))
        log(`draw: model=${model} ${bytes}B -> ${args.isGroup === true ? 'group' : 'dm'} ${args.target}`)
        return { ok: true, model, bytes, path: imagePath, ...sent as object }
      },
    },
    {
      name: 'qq_send_private_file',
      description: '私聊给好友发本地文件（从咱的工作区里挑）。file 是本地绝对路径；不填 name 就用原文件名。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: 'number', description: '好友QQ号' },
          file: { type: 'string', description: '本地文件绝对路径' },
          name: { type: 'string', description: '显示的文件名' },
        },
        required: ['userId', 'file'],
      },
      run: async (args) => {
        const file = String(args.file)
        const fsMod = await import('node:fs/promises')
        await fsMod.access(file)
        return client.call('upload_private_file', {
          user_id: args.userId,
          file,
          name: String(args.name ?? file.replace(/^.*[\\/]/, '')),
        })
      },
    },
    {
      name: 'qq_save_private_file',
      description: '把私聊收到的文件存到咱的工作区 downloads/ 下（fileId 来自文件消息），返回本地路径。',
      parameters: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: '私聊文件ID' },
          saveAs: { type: 'string', description: '保存的文件名，存到工作区 downloads/ 下' },
        },
        required: ['fileId'],
      },
      run: async (args) => {
        const urlData = await client.call('get_private_file_url', { file_id: String(args.fileId) }) as { url?: string }
        if (typeof urlData?.url !== 'string' || urlData.url === '') throw new Error('拿不到私聊文件下载链接')
        const res = await fetch(urlData.url)
        if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`)
        const bytes = Buffer.from(await res.arrayBuffer())
        const fsMod = await import('node:fs/promises')
        const pathMod = await import('node:path')
        const wsRoot = config.workspacePath ?? process.cwd()
        const dir = pathMod.join(wsRoot, 'downloads')
        await fsMod.mkdir(dir, { recursive: true })
        const safeName = String(args.saveAs ?? `file_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_')
        const target = pathMod.join(dir, safeName)
        await fsMod.writeFile(target, bytes)
        return { saved: target, size: bytes.length }
      },
    },
    {
      name: 'qq_search_music',
      description: '搜索网易云音乐（歌名/歌手）。返回 id、歌名、歌手、时长列表，供点歌时选歌。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '歌名或歌手' },
          limit: { type: 'number', description: '返回条数（默认5，最多10）' },
        },
        required: ['keyword'],
      },
      run: async (args) => {
        const songs = await neteaseSearch(String(args.keyword), Math.min(Number(args.limit ?? 5), 10))
        return { count: songs.length, songs }
      },
    },
    {
      name: 'qq_resolve_music',
      description: '解析一首歌的播放直链/封面/歌词（网易云 songId）。发语音或拿链接前用这个。',
      parameters: {
        type: 'object',
        properties: { songId: { type: 'string', description: '网易云歌曲ID' } },
        required: ['songId'],
      },
      run: async (args) => {
        const br = Math.min(Number(args.br ?? 320000), 999000)
        const result = await neteaseSongUrl(String(args.songId), br)
        if (result.url === null) {
          throw new Error(result.vipRequired ? '该曲为 VIP/付费歌曲：请先 qq_netease_login 扫码登录会员账号' : '拿不到播放直链（下架或地区限制）')
        }
        return { audioUrl: result.url, quality: result.br, fee: result.fee, size: result.size }
      },
    },
    {
      name: 'qq_send_music_card',
      description: '在群/私聊里发一首歌（官方音乐卡片，网易云 songId）。最适合点歌展示。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'number', description: '群号或好友QQ号' },
          songId: { type: 'string', description: '网易云歌曲ID' },
          private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
        },
        required: ['target', 'songId'],
      },
      run: async (args) => {
        const segment = [{ type: 'music', data: { type: '163', id: String(args.songId) } }]
        return args.private === true
          ? client.call('send_private_msg', { user_id: args.target, message: segment })
          : client.call('send_group_msg', { group_id: args.target, message: segment })
      },
    },
    {
      name: 'qq_send_music_voice',
      description: '把一首歌下载后以语音形式发到群/私聊（卡片发不了时的降级，听感像发语音条）。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'number', description: '群号或好友QQ号' },
          songId: { type: 'string', description: '网易云歌曲ID' },
          private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
        },
        required: ['target', 'songId'],
      },
      run: async (args) => {
        const resolved = await neteaseSongUrl(String(args.songId), 320000)
        const audioUrl = resolved.url
        if (audioUrl === null) {
          throw new Error(resolved.vipRequired ? '该曲为 VIP/付费歌曲：请先 qq_netease_login 扫码登录会员账号' : '拿不到音频直链')
        }
        const audio = await fetch(audioUrl)
        if (!audio.ok) throw new Error(`音频下载失败 HTTP ${audio.status}`)
        const fsMod = await import('node:fs/promises')
        const pathMod = await import('node:path')
        const tmpDir = pathMod.join(process.env.DSH_HOME ?? pathMod.join(process.env.HOME ?? '.', '.dsh'), 'channel-qq', 'music-tmp')
        await fsMod.mkdir(tmpDir, { recursive: true })
        const target = pathMod.join(tmpDir, `song_${Date.now()}.mp3`)
        await fsMod.writeFile(target, Buffer.from(await audio.arrayBuffer()))
        const segment = [{ type: 'record', data: { file: `file:///${target.replace(/\\/g, '/')}` } }]
        const result = args.private === true
          ? await client.call('send_private_msg', { user_id: args.target, message: segment })
          : await client.call('send_group_msg', { group_id: args.target, message: segment })
        void fsMod.rm(target, { force: true }).catch(() => {})
        return result
      },
    },
    {
      name: 'qq_music_lyrics',
      description: '拿一首歌的完整歌词（网易云 songId）。',
      parameters: {
        type: 'object',
        properties: { songId: { type: 'string', description: '网易云歌曲ID' } },
        required: ['songId'],
      },
      run: async (args) => {
        const res = await fetch(`https://api.qijieya.cn/meting/?server=netease&type=lrc&id=${encodeURIComponent(String(args.songId))}`)
        if (!res.ok) throw new Error(`歌词获取失败 HTTP ${res.status}`)
        const text = await res.text()
        // meting returns JSON array with lrc field when Accept: json
        try {
          const list = JSON.parse(text) as Array<{ lrc?: string }>
          return { lyrics: (list[0]?.lrc ?? text).slice(0, 6000) }
        } catch {
          return { lyrics: text.slice(0, 6000) }
        }
      },
    },
    {
      name: 'qq_music_playlist',
      description: '咱的个人歌单（跨重启持久）。action: add/remove/list/clear。add 需要 songId 和 name。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'add / remove / list / clear' },
          songId: { type: 'string' },
          name: { type: 'string', description: '歌名（add 时记录）' },
          artists: { type: 'string', description: '歌手（add 时可选）' },
        },
        required: ['action'],
      },
      run: async (args) => {
        const fsMod = await import('node:fs/promises')
        const pathMod = await import('node:path')
        const wsRoot = config.workspacePath ?? process.cwd()
        const file = pathMod.join(wsRoot, 'music-playlist.json')
        type Song = { id: string; name: string; artists?: string; addedAt: number }
        let songs: Song[] = []
        try { songs = JSON.parse(await fsMod.readFile(file, 'utf8')) as Song[] } catch { songs = [] }
        const action = String(args.action)
        if (action === 'add') {
          if (songs.some((s) => s.id === String(args.songId))) return { result: '歌单里已有这首', total: songs.length }
          songs.unshift({ id: String(args.songId), name: String(args.name ?? ''), artists: args.artists === undefined ? undefined : String(args.artists), addedAt: Date.now() })
        } else if (action === 'remove') {
          songs = songs.filter((s) => s.id !== String(args.songId))
        } else if (action === 'clear') {
          songs = []
        } else if (action !== 'list') {
          return { error: 'action 只能是 add/remove/list/clear' }
        }
        await fsMod.writeFile(file, JSON.stringify(songs, null, 1), 'utf8')
        return { action, total: songs.length, songs: songs.slice(0, 30) }
      },
    },
    {
      name: 'qq_netease_login',
      description: '网易云会员登录。action=start 生成二维码图片并直接发到当前会话（同学用网易云音乐App扫）；action=poll 用返回的 key 轮询，成功后自动保存会员 Cookie（VIP歌就能发了）。Cookie 持久保存，不用每次登。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'start（拿二维码）/ poll（查状态，带 key）' },
          key: { type: 'string', description: 'poll 时传 start 返回的 key' },
          isGroup: { type: 'boolean', description: 'start 时：二维码发到群还是私聊（照会话包填）' },
          target: { type: 'number', description: 'start 时：群号或对方QQ号' },
        },
        required: ['action'],
      },
      run: async (args) => {
        const action = String(args.action)
        if (action === 'start') {
          const { unikey, qrUrl } = await qrLoginStart()
          // Render + send the QR as an image so 同学 can scan it in-chat.
          if (args.target !== undefined) {
            const fsMod = await import('node:fs/promises')
            const pathMod = await import('node:path')
            const dir = pathMod.join(process.env.DSH_HOME ?? pathMod.join(process.env.HOME ?? '.', '.dsh'), 'channel-qq')
            await fsMod.mkdir(dir, { recursive: true })
            const qrPath = pathMod.join(dir, 'qr-netease.png')
            await QRCode.toFile(qrPath, qrUrl, { width: 420, margin: 2 })
            const message = [{ type: 'image', data: { file: `file://${qrPath}` } }]
            if (args.isGroup === true) {
              await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
            } else {
              await out.push(() => client.call('send_private_msg', { user_id: args.target, message }))
            }
            log(`netease qr sent to ${args.isGroup === true ? 'group' : 'dm'} ${String(args.target)}`)
            return { key: unikey, qrSent: true, hint: '二维码已发出，跟同学说：用网易云音乐App扫码。然后每2秒 poll 一次，803=成功' }
          }
          return { key: unikey, qrUrl, hint: '没给发送窗口，只返回链接。建议带 isGroup/target 重试，直接把二维码图片发到会话里' }
        }
        if (action === 'poll') {
          const result = await qrLoginPoll(String(args.key ?? ''))
          if (result.code === 803 && result.cookie !== '') {
            await neteaseSaveCookie(result.cookie)
            return { status: '登录成功，会员Cookie已保存', cookieSaved: true }
          }
          const meaning = { 800: '二维码已过期，重新 start', 801: '等待扫码', 802: '已扫码待确认', [-1]: '轮询异常' } as Record<number, string>
          return { status: meaning[result.code] ?? (`code=${result.code} ${result.message}`), code: result.code }
        }
        return { error: 'action 只能是 start/poll' }
      },
    },
    {
      name: 'qq_netease_status',
      description: '查网易云账号登录状态和会员等级（判断 VIP 歌能不能发）。',
      parameters: { type: 'object', properties: {} },
      run: async () => neteaseLoginStatus(),
    },
    {
      name: 'qq_kugou_search',
      description: '搜索酷狗音乐（歌名/歌手）。返回 hash、歌名、歌手，供酷狗点歌用。需要先 qq_kugou_login 登录（酷狗禁止匿名搜索）。',
      parameters: {
        type: 'object',
        properties: {
          keyword: { type: 'string', description: '歌名或歌手' },
          limit: { type: 'number', description: '返回条数（默认5，最多10）' },
        },
        required: ['keyword'],
      },
      run: async (args) => {
        const songs = await kugouSearch(String(args.keyword), Math.min(Number(args.limit ?? 5), 10))
        return { count: songs.length, songs }
      },
    },
    {
      name: 'qq_kugou_send',
      description: '发酷狗歌曲：默认发语音条（VIP歌需要先 qq_kugou_login）。quality 可选 auto/viper_tape/viper_clear/super/high/flac/320/128。',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'number', description: '群号或好友QQ号' },
          hash: { type: 'string', description: '歌曲hash（来自 qq_kugou_search）' },
          quality: { type: 'string', description: '音质（默认 auto）' },
          private: { type: 'boolean', description: 'true=私聊发送（默认群聊）' },
        },
        required: ['target', 'hash'],
      },
      run: async (args) => {
        const resolved = await kugouSongUrl(String(args.hash), String(args.quality ?? 'auto'))
        const audio = await fetch(resolved.url)
        if (!audio.ok) throw new Error(`音频下载失败 HTTP ${audio.status}`)
        const fsMod = await import('node:fs/promises')
        const pathMod = await import('node:path')
        const tmpDir = pathMod.join(process.env.DSH_HOME ?? pathMod.join(process.env.HOME ?? '.', '.dsh'), 'channel-qq', 'music-tmp')
        await fsMod.mkdir(tmpDir, { recursive: true })
        const target = pathMod.join(tmpDir, `kg_${Date.now()}.${resolved.extName}`)
        await fsMod.writeFile(target, Buffer.from(await audio.arrayBuffer()))
        const segment = [{ type: 'record', data: { file: `file:///${target.replace(/\\/g, '/')}` } }]
        const result = (args.private === true
          ? await client.call('send_private_msg', { user_id: args.target, message: segment })
          : await client.call('send_group_msg', { group_id: args.target, message: segment })) as Record<string, unknown>
        void fsMod.rm(target, { force: true }).catch(() => {})
        return { ...result, trial: resolved.trial, quality: String(args.quality ?? 'auto') }
      },
    },
    {
      name: 'qq_kugou_login',
      description: '酷狗音乐登录。action=start 生成二维码图片并直接发到当前会话（同学用酷狗App扫）；action=poll 轮询，成功自动保存 Cookie（VIP歌+搜索就通了）。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'start / poll' },
          key: { type: 'string', description: 'poll 时传 start 返回的 key' },
          isGroup: { type: 'boolean', description: 'start 时：二维码发到群还是私聊（照会话包填）' },
          target: { type: 'number', description: 'start 时：群号或对方QQ号' },
        },
        required: ['action'],
      },
      run: async (args) => {
        const action = String(args.action)
        if (action === 'start') {
          const { key, qrUrl } = await kugouQrStart()
          if (args.target !== undefined) {
            const fsMod = await import('node:fs/promises')
            const pathMod = await import('node:path')
            const dir = pathMod.join(process.env.DSH_HOME ?? pathMod.join(process.env.HOME ?? '.', '.dsh'), 'channel-qq')
            await fsMod.mkdir(dir, { recursive: true })
            const qrPath = pathMod.join(dir, 'qr-kugou.png')
            await QRCode.toFile(qrPath, qrUrl, { width: 420, margin: 2 })
            const message = [{ type: 'image', data: { file: `file://${qrPath}` } }]
            if (args.isGroup === true) {
              await out.push(() => client.call('send_group_msg', { group_id: args.target, message }))
            } else {
              await out.push(() => client.call('send_private_msg', { user_id: args.target, message }))
            }
            log(`kugou qr sent to ${args.isGroup === true ? 'group' : 'dm'} ${String(args.target)}`)
            return { key, qrSent: true, hint: '二维码已发出，跟同学说：用酷狗App扫码。然后每2秒 poll 一次' }
          }
          return { key, qrUrl, hint: '没给发送窗口，只返回链接。建议带 isGroup/target 重试' }
        }
        if (action === 'poll') {
          const result = await kugouQrPoll(String(args.key ?? ''))
          if (result.status === 'ok') {
            return { status: '登录成功，酷狗Cookie已保存', nickname: result.nickname, cookieSaved: true }
          }
          const meaning = { 0: '等待扫码', 1: '已扫码待确认' } as Record<string, string>
          return { status: meaning[result.status] ?? `status=${result.status}` }
        }
        return { error: 'action 只能是 start/poll' }
      },
    },
    {
      name: 'qq_send_like',
      description: '给好友点赞。',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'number' }, times: { type: 'number', description: '点赞次数（≤10）' } },
        required: ['userId'],
      },
      run: async (args) => client.call('send_like', { user_id: args.userId, times: Math.min(Number(args.times ?? 1), 10) }),
    },
  ]

  for (const spec of specs) {
    try {
      disposers.push(tools.register({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: {
          schema: { type: 'object' },
          render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        async execute(args: unknown) {
          const value = await spec.run((args ?? {}) as Record<string, unknown>)
          // OneBot mutation actions frequently answer null/undefined even on
          // success. Normalize every void-ish result to a lossless JSON ack so
          // the harness output validator does not turn success into an error.
          if (value === undefined || value === null) {
            return { ok: true }
          }
          return value
        },
      }))
    } catch (error) {
      log(`tool ${spec.name} registration failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log(`registered ${disposers.length} QQ tools`)
  return () => {
    for (const dispose of disposers) dispose()
  }
}
