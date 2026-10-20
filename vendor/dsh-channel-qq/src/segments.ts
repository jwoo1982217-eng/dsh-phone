/** OneBot message segment ↔ text conversions for the agent boundary. */

import type { OneBotEvent, OneBotMessage, OneBotMessageSegment } from './types.js'

export interface ParsedInbound {
  text: string
  imageUrls: string[]
  imageSummaries: string[]
  isAtBot: boolean
  replyToMessageId: number | null
  hasAtAll: boolean
  /** Voice-bar segments present (STT candidates). */
  recordCount: number
  /** QQ ids @-ed in the message (excluding the bot and @全体). */
  atIds: number[]
  /** Inbound files: [fileName, url, fileId]. */
  files: Array<{ name: string; url: string; fileId: string }>
}

function log_reply_parse(raw: unknown): void {
  // Non-numeric reply ids (rare gateway variants) are surfaced via console;
  // the bridge logs the failed get_msg anyway.
  console.warn(`[dsh-channel-qq] unparseable reply id: ${JSON.stringify(raw)}`)
}

function segmentsOf(message: OneBotMessage | undefined): OneBotMessageSegment[] {
  if (message === undefined) return []
  if (typeof message === 'string') {
    return message.trim() === '' ? [] : [{ type: 'text', data: { text: message } }]
  }
  return message
}

export function parseInbound(event: OneBotEvent): ParsedInbound {
  const parsed: ParsedInbound = {
    text: '',
    imageUrls: [],
    imageSummaries: [],
    isAtBot: false,
    replyToMessageId: null,
    hasAtAll: false,
    recordCount: 0,
    files: [],
    atIds: [],
  }
  const parts: string[] = []
  for (const seg of segmentsOf(event.message)) {
    switch (seg.type) {
      case 'text': {
        const text = seg.data.text.trim()
        if (text !== '') parts.push(text)
        break
      }
      case 'image': {
        if (seg.data.url) parsed.imageUrls.push(seg.data.url)
        if (seg.data.summary && seg.data.summary !== '[图片]') parsed.imageSummaries.push(seg.data.summary)
        parts.push('[图片]')
        break
      }
      case 'at': {
        if (seg.data.qq === 'all') parsed.hasAtAll = true
        else if (seg.data.qq === String(event.self_id)) parsed.isAtBot = true
        else {
          const id = Number(seg.data.qq)
          if (Number.isSafeInteger(id) && id > 0 && !parsed.atIds.includes(id)) parsed.atIds.push(id)
        }
        break
      }
      case 'reply': {
        const rawId = seg.data.id
        const id = typeof rawId === 'number' ? rawId : Number(String(rawId ?? '').trim())
        if (Number.isSafeInteger(id) && id > 0) parsed.replyToMessageId = id
        else log_reply_parse(rawId)
        break
      }
      case 'face':
        parts.push(`[表情:${seg.data.id}]`)
        break
      case 'record':
        parsed.recordCount += 1
        parts.push('[语音]')
        break
      case 'file': {
        const d = seg.data as { file?: string; url?: string; file_id?: string; file_size?: number | string }
        const name = d.file ?? '文件'
        const sizeNum = typeof d.file_size === 'string' ? Number(d.file_size) : d.file_size
        const sizeStr = typeof sizeNum === 'number' && sizeNum > 0 ? `(${Math.round(sizeNum / 1024)}KB)` : ''
        parts.push(`[文件：${name}${sizeStr}]`)
        parsed.files.push({ name, url: d.url ?? '', fileId: d.file_id ?? '' })
        break
      }
      case 'video':
        parts.push('[视频]')
        break
      default:
        break
    }
  }
  if (event.raw_message) {
    // Keyword triggers run against the raw text so 我-style name calls in
    // plain text match even when the event carries no text segment.
    parsed.text = parts.join(' ')
  } else {
    parsed.text = parts.join(' ')
  }
  return parsed
}

/** Flattened raw text (for trigger matching), tolerating string-only messages. */
export function rawText(event: OneBotEvent): string {
  if (typeof event.message === 'string') return event.message
  return parseInbound(event).text
}

export function textMessage(text: string): OneBotMessageSegment[] {
  return [{ type: 'text', data: { text } }]
}

export function replyAndText(messageId: number, text: string): OneBotMessageSegment[] {
  return [
    { type: 'reply', data: { id: String(messageId) } },
    { type: 'text', data: { text } },
  ]
}
