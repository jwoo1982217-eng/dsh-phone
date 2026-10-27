/**
 * TRAE 1024 抽奖 · **实测参与**（会真的发写请求，用掉当天的一次机会）
 *
 * ⚠️⚠️ 这是一个**写操作**脚本，不是探针：
 * - 只在你明确同意时跑；
 * - **不重试**（客户端对 `checkin_1024` 也是 `retry: 0`）；
 * - 发之前**先只读确认** `grantable === true && granted === false`，
 *   否则直接退出（不白烧机会）。
 *
 * ## 用法
 * ```powershell
 * $env:DSH_TRAE_LOTTERY_E2E='1'; $env:DSH_TRAE_LOTTERY_E2E_CONFIRM='yes'
 * $env:DSH_TRAE_LOTTERY_SEND='yes'          # ← 没有这个就只做「预检 + 打印将要发的请求」
 * pnpm vitest run --config vitest.e2e.config.ts tests/e2e/trae-lottery-probe.e2e.spec.ts -t 实测
 * ```
 * ⚠️ 三个开关缺一不可，避免误触。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { traeCheckinHeaders, type TraeCredential } from '../../src/trae.js'
import { TRAE } from '../../src/trae-product.js'
import {
  decideTraeLottery,
  extractTraeCommercialActivities,
  TRAE_UG_REQ_SOURCE_IDE,
  TRAE_CHECKIN_LOTTERY_ACTIVITY_ID,
} from '../../src/trae-lottery.js'

const GATE = process.env['DSH_TRAE_LOTTERY_E2E'] === '1'
  && process.env['DSH_TRAE_LOTTERY_E2E_CONFIRM'] === 'yes'
const SEND = process.env['DSH_TRAE_LOTTERY_SEND'] === 'yes'
const BASE = 'https://api.trae.cn'

/** 从 DSH 凭据库取第一个 `TRAE_ACCOUNT_*`（不打印、不外传）。 */
function readCred(): TraeCredential | undefined {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s+TRAE_ACCOUNT_[0-9A-Fa-f]+:/.test(l))
  if (start < 0) return undefined
  const block: string[] = []
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && !/^\s{4,}\S/.test(lines[i]!)) break
    block.push(lines[i]!)
  }
  const joined = block.join('\n')
  const from = joined.indexOf('{')
  const to = joined.lastIndexOf('}')
  if (from < 0 || to <= from) return undefined
  try { return JSON.parse(joined.slice(from, to + 1)) as TraeCredential } catch { return undefined }
}

const describeProbe = GATE ? describe : describe.skip

describeProbe('TRAE 1024 抽奖实测', () => {
  it('预检 → （可选）发送一次参与请求 → 打印请求与响应', async () => {
    const cred = readCred()
    expect(cred, '凭据库无 TRAE_ACCOUNT_*').toBeDefined()
    const uid = cred!.uid
    const headers = traeCheckinHeaders(cred!, TRAE, uid) as Record<string, string>

    // ① 预检（只读）：确认今天还能抽
    const infoRes = await fetch(`${BASE}/trae/api/v2/ug/activity/info`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version_code: '3.5.2', req_source: TRAE_UG_REQ_SOURCE_IDE }),
      signal: AbortSignal.timeout(20_000),
    })
    const infoBody = JSON.parse(await infoRes.text()) as unknown
    const acts = extractTraeCommercialActivities(infoBody)
    const decision = decideTraeLottery(acts)
    console.log(`[预检] decideTraeLottery = ${decision.kind}${decision.reason ? ` (${decision.reason})` : ''}`)
    const target = acts?.find((a) => a.activityId === TRAE_CHECKIN_LOTTERY_ACTIVITY_ID)
    console.log(`[预检] checkin_1024 = ${JSON.stringify(target)}`)
    if (decision.kind !== 'participate') {
      console.log('[预检] 今天不该抽 ⇒ 退出（不白烧机会）')
      expect(decision.kind).not.toBe('participate')
      return
    }

    const payload = { activity_id: TRAE_CHECKIN_LOTTERY_ACTIVITY_ID, req_source: TRAE_UG_REQ_SOURCE_IDE }
    console.log(`\n[将发送] POST ${BASE}/trae/api/v2/ug/activity/action`)
    console.log(`[将发送] body = ${JSON.stringify(payload)}`)
    console.log(`[将发送] 头里带着：${Object.keys(headers).filter((h) => h.toLowerCase().startsWith('x-') || h === 'Authorization').join(', ')}`)
    if (!SEND) {
      console.log('\n⚠️ 未设 DSH_TRAE_LOTTERY_SEND=yes ⇒ **只预检不发送**')
      return
    }

    // ② 真发一次（**不重试**）
    const started = Date.now()
    const res = await fetch(`${BASE}/trae/api/v2/ug/activity/action`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    console.log(`\n[响应] HTTP ${res.status}  耗时 ${Date.now() - started}ms  长度 ${text.length}`)
    console.log(`[响应原文] ${text.slice(0, 1200)}`)

    // ③ 复读状态：确认 granted 是否翻转（只读）
    const after = await fetch(`${BASE}/trae/api/v2/ug/activity/info`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ version_code: '3.5.2', req_source: TRAE_UG_REQ_SOURCE_IDE }),
      signal: AbortSignal.timeout(20_000),
    })
    const afterBody = JSON.parse(await after.text()) as unknown
    const afterAct = extractTraeCommercialActivities(afterBody)
      ?.find((a) => a.activityId === TRAE_CHECKIN_LOTTERY_ACTIVITY_ID)
    console.log(`[复读] checkin_1024 = ${JSON.stringify(afterAct)}`)
    expect(res.status).toBe(200)
  }, 180_000)
})