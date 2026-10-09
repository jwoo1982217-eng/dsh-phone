/** OneBot v11 wire types (subset used by the channel), ported from the OpenClaw qq extension. */

export type OneBotMessageSegment =
  | { type: 'text'; data: { text: string } }
  | { type: 'image'; data: { file: string; url?: string; subtype?: number; summary?: string } }
  | { type: 'at'; data: { qq: string } }
  | { type: 'reply'; data: { id: string } }
  | { type: 'face'; data: { id: number } }
  | { type: 'record'; data: { file: string } }
  | { type: 'file'; data: { file: string; url?: string; file_id?: string; file_size?: number | string } }
  | { type: 'video'; data: { file: string } }
  | { type: 'tts'; data: { text: string } }

export type OneBotMessage = OneBotMessageSegment[] | string

export interface OneBotSender {
  user_id: number
  nickname: string
  card?: string
  /** owner / admin / member */
  role?: string
  /** 群头衔 (NapCat) */
  title?: string
  /** 等级 (NapCat) */
  level?: string
}

export interface OneBotEvent {
  time: number
  self_id: number
  post_type: string
  meta_event_type?: string
  message_type?: 'private' | 'group'
  sub_type?: string
  message_id?: number
  user_id?: number
  group_id?: number
  message?: OneBotMessage
  raw_message?: string
  sender?: OneBotSender
  target_id?: number
  operator_id?: number
  notice_type?: string
  sub_type_alt?: string
}

export interface OneBotActionPayload {
  action: string
  params: Record<string, unknown>
  echo?: string
}

export interface OneBotApiResponse {
  status: 'ok' | 'async' | 'failed'
  retcode: number
  data?: unknown
  msg?: string
  wording?: string
  echo?: string
}
