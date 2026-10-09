const DAY_MS = 86_400_000
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000

function shanghaiDateParts(nowMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(nowMs))
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  }
}

function relativeDate(base, offsetDays) {
  const shifted = new Date(Date.UTC(base.year, base.month - 1, base.day) + offsetDays * DAY_MS)
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  }
}

function parseDate(text, nowMs) {
  const absolute = text.match(/(20\d{2})\s*[年\/-]\s*(\d{1,2})\s*[月\/-]\s*(\d{1,2})\s*日?/)
  if (absolute) {
    return { year: Number(absolute[1]), month: Number(absolute[2]), day: Number(absolute[3]) }
  }

  const base = shanghaiDateParts(nowMs)
  if (text.includes('后天')) return relativeDate(base, 2)
  if (text.includes('明天')) return relativeDate(base, 1)
  if (text.includes('今天')) return base
  throw new Error('无法识别截止日期，请使用“明天”“后天”或 YYYY-MM-DD 格式')
}

function parseTime(text) {
  const match = text.match(/(凌晨|早上|上午|中午|下午|傍晚|晚上)\s*(\d{1,2})(?:\s*[:：点时]\s*(\d{1,2})?)?\s*(?:分)?/)
    || text.match(/(?:今天|明天|后天|日|\s)\s*(\d{1,2})\s*[:：]\s*(\d{1,2})/)
    || text.match(/(?:今天|明天|后天|日|\s)\s*(\d{1,2})\s*[点时]\s*(\d{1,2})?\s*(?:分)?/)
  if (!match) return { hour: 0, minute: 0, isAllDay: true }

  const hasPeriod = /^(凌晨|早上|上午|中午|下午|傍晚|晚上)$/.test(match[1])
  const period = hasPeriod ? match[1] : undefined
  let hour = Number(hasPeriod ? match[2] : match[1])
  const minute = Number((hasPeriod ? match[3] : match[2]) || 0)
  if (['中午', '下午', '傍晚', '晚上'].includes(period) && hour < 12) hour += 12
  if (['凌晨', '早上', '上午'].includes(period) && hour === 12) hour = 0
  if (hour > 23 || minute > 59) throw new Error('截止时间超出有效范围')
  return { hour, minute, isAllDay: false }
}

export function resolveDeadline(text, nowMs = Date.now()) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('截止时间不能为空')
  const date = parseDate(text.trim(), nowMs)
  const time = parseTime(text.trim())
  const timestamp = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute) - SHANGHAI_OFFSET_MS
  const verified = new Date(timestamp + SHANGHAI_OFFSET_MS)
  if (
    verified.getUTCFullYear() !== date.year ||
    verified.getUTCMonth() + 1 !== date.month ||
    verified.getUTCDate() !== date.day
  ) throw new Error('截止日期无效')

  const pad = value => String(value).padStart(2, '0')
  return {
    timestamp: String(timestamp),
    timezone: 'Asia/Shanghai',
    display: `${date.year}-${pad(date.month)}-${pad(date.day)} ${pad(time.hour)}:${pad(time.minute)}`,
    is_all_day: time.isAllDay,
  }
}
