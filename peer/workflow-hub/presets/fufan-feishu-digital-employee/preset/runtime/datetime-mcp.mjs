import { resolveDeadline } from './date-parser.mjs'
import { serve } from './mcp-stdio.mjs'

serve({
  name: 'fufan-datetime',
  version: '1.0.0',
  tools: [{
    name: 'resolve_deadline',
    title: '解析截止时间',
    description: '把中文相对日期或明确日期按 Asia/Shanghai 转换为飞书任务所需的毫秒时间戳。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', minLength: 1, description: '例如“明天下午 6 点”或“2026-08-18 18:00”' },
      },
      required: ['text'],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }],
  callTool(name, args) {
    if (name !== 'resolve_deadline') throw new Error(`未知时间工具：${name}`)
    if (typeof args.text !== 'string') throw new Error('截止时间不能为空')
    const result = resolveDeadline(args.text)
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  },
})
