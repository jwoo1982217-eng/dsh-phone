import { serve } from './mcp-stdio.mjs'

const AUTH_URL = 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal'
const TASK_URL = 'https://open.feishu.cn/open-apis/task/v2/tasks'

async function jsonRequest(url, init) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
  const body = await response.json().catch(() => undefined)
  if (!response.ok || body === undefined || body === null || typeof body !== 'object') {
    throw new Error(`飞书接口请求失败：HTTP ${response.status}`)
  }
  return body
}

async function tenantToken() {
  const appId = process.env.FEISHU_APP_ID?.trim()
  const appSecret = process.env.FEISHU_APP_SECRET?.trim()
  if (!appId || !appSecret) throw new Error('请先配置 FEISHU_APP_ID 与 FEISHU_APP_SECRET')
  const body = await jsonRequest(AUTH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  })
  if (body.code !== 0 || typeof body.tenant_access_token !== 'string') {
    throw new Error(`飞书鉴权失败：${typeof body.msg === 'string' ? body.msg : `code ${String(body.code)}`}`)
  }
  return body.tenant_access_token
}

async function createTask(args) {
  const input = args.data
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('data 必须包含飞书任务字段')
  }
  const defaultOpenId = process.env.FEISHU_DEFAULT_OPEN_ID?.trim()
  const data = { ...input }
  if ((!Array.isArray(data.members) || data.members.length === 0) && defaultOpenId) {
    data.members = [{ id: defaultOpenId, type: 'user', role: 'assignee' }]
  }
  const userIdType = args.params?.user_id_type ?? 'open_id'
  if (userIdType !== 'open_id') throw new Error('params.user_id_type 必须为 open_id')
  const token = await tenantToken()
  const url = new URL(TASK_URL)
  url.searchParams.set('user_id_type', 'open_id')
  const body = await jsonRequest(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(data),
  })
  if (body.code !== 0) {
    throw new Error(`飞书创建任务失败：${typeof body.msg === 'string' ? body.msg : `code ${String(body.code)}`}`)
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
  }
}

serve({
  name: 'fufan-feishu-task',
  version: '1.0.0',
  tools: [{
    name: 'task_v2_task_create',
    title: '创建飞书任务',
    description: '使用企业自建应用凭证创建真实飞书任务。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        data: {
          type: 'object',
          description: '飞书 task/v2/tasks 请求体，包含 summary、description、due、members 等任务字段。',
        },
        params: {
          type: 'object',
          additionalProperties: false,
          properties: { user_id_type: { type: 'string', enum: ['open_id'] } },
        },
      },
      required: ['data'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }],
  callTool(name, args) {
    if (name !== 'task_v2_task_create') throw new Error(`未知飞书工具：${name}`)
    return createTask(args)
  },
})
