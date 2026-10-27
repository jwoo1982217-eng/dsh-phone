/**
 * TRAE「1024 每日打卡抽奖」活动 · **只读探针**（零构建，不碰 dsh web）
 *
 * ## 背景（TRAE CN 客户端逆向取证，2026-10-20）
 *
 * 用户要求把 TRAE IDE 的「1024 程序员节每日打卡抽奖」集成进每日签到。客户端取证结论：
 * - 活动是**服务端动态配置**驱动的：`iCubeApp.commercialActivities.checkin_1024`
 *   ⇒ 含 `enabled` + `presentation`（`renderer: 'checkin_lottery'`、`assets.{intro,win,luck}`、
 *   `popupA/popupB`、`entry`）⇒ **文案与图都不在 bundle 里**（故中文检索零命中）；
 * - 签到与抽奖是**两套通道**：签到 `checkin_credits/{status,claim}`（我们已接），
 *   抽奖走 **通用商业活动接口**：
 *   - `queryCommercialActivityInfo()` → `/trae/api/v2/ug/activity/info`
 *   - `handleCommercialActivity(...)` → `/trae/api/v2/ug/activity/action`（写，**抽奖在这**）
 * - 客户端的抽奖入口判据：`presentation 存在 && snapshot.userId 相符 &&
 *   state.kind === 'ready' && state.eligible && isIdeCheckinAvailable()` ⇒ **必须先签到**；
 * - ⚠️ 客户端的 `participate(windowId, source)` 只接受
 *   `account_menu` / `banner_popup` / `sidebar_banner`，否则回 `{status:'disabled'}`。
 *
 * ## 本探针只做**只读**的一件事
 *
 * 调 `/trae/api/v2/ug/activity/info`，打印响应**结构**（键名 + 类型 + 长度，不含账号值），
 * 从而看清 `checkin_1024` 的**状态字段**（资格 / 今日是否已抽 / 还剩几次）。
 * **绝不**调 `activity/action`（那是写操作，可能消耗用户的抽奖机会）。
 *
 * ⚠️ 顺带调一次 `checkin_credits/status` 作为**对照**：确认凭据本身有效
 *   （否则 activity 的失败会被误读成"活动接口有问题"）。
 *
 * ## 用法
 *
 * ```powershell
 * $env:DSH_TRAE_LOTTERY_E2E='1'; $env:DSH_TRAE_LOTTERY_E2E_CONFIRM='yes'
 * pnpm vitest run --config vitest.e2e.config.ts tests/e2e/trae-lottery-probe.e2e.spec.ts
 * ```
 *
 * ⚠️ 凭据从 DSH 凭据库（明文 YAML `~/.dsh/.credentials.yaml`）**本进程内**读取，
 *    **不打印、不外传**；只打印长度与结构。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { traeCheckinHeaders, type TraeCredential } from '../../src/trae.js'

const GATE = process.env['DSH_TRAE_LOTTERY_E2E'] === '1'
  && process.env['DSH_TRAE_LOTTERY_E2E_CONFIRM'] === 'yes'

/** 可直出值的键（**不含账号标识**；正是本次要看的字段）。 */
const SAFE_KEYS = new Set([
  'code', 'message', 'msg', 'status', 'data',
  'activity_id', 'activityId', 'activity_name', 'activityName',
  'eligible', 'enabled', 'Enabled', 'kind', 'state', 'reason',
  // ⚠️ 真实响应里 `grantable` / `granted` / `auto_grant` 是**字符串** `"true"` / `"false"`
  //    （长度 4 / 5 就是它们）—— 它们不含账号标识，且正是"今天还能不能抽"的判据 ⇒ 直出。
  'grantable', 'granted', 'auto_grant', 'activity_type',
  'credits', 'general_credits', 'work_credits',
  'checked_in', 'checkedIn', 'remaining', 'left', 'count', 'chance', 'times', 'draw_count',
  'bonus', 'prize', 'prize_text',
])

/** 把任意 JSON 压成**结构描述**；`SAFE_KEYS` 上的标量直出值。 */
function shapeOf(value: unknown, depth = 0, key = ''): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) {
    return value.length === 0 ? 'array(0)' : `array(${value.length})[${shapeOf(value[0], depth + 1, key)}]`
  }
  if (typeof value === 'object') {
    if (depth >= 4) return 'object(…)'
    const o = value as Record<string, unknown>
    return `{ ${Object.keys(o).map((k) => `${k}: ${shapeOf(o[k], depth + 1, k)}`).join(', ')} }`
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return SAFE_KEYS.has(key)
      ? `${typeof value}(${JSON.stringify(value)})`
      : `${typeof value}(len=${String(value).length})`
  }
  return typeof value
}

/**
 * 从 DSH 凭据库取第一个 `TRAE_ACCOUNT_*` 的凭据。
 *
 * ⚠️ **不引入 yaml 依赖**（本仓库没装 `yaml` / `js-yaml`）⇒ 逐行扫描 + 花括号配对。
 *    ⚠️ 值可能是**多行**（凭据库里有跨行的 JSON）⇒ 必须把缩进续行拼回来。
 */
function readFirstTraeCredential(): TraeCredential | undefined {
  const text = readFileSync(join(homedir(), '.dsh', '.credentials.yaml'), 'utf8')
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s+TRAE_ACCOUNT_[0-9A-Fa-f]+:/.test(l))
  if (start < 0) return undefined
  const block: string[] = []
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i]!
    if (i > start && !/^\s{4,}\S/.test(line)) break   // 缩进更浅 ⇒ 下一条目了
    block.push(line)
  }
  const joined = block.join('\n')
  const from = joined.indexOf('{')
  const to = joined.lastIndexOf('}')
  if (from < 0 || to <= from) return undefined
  try {
    return JSON.parse(joined.slice(from, to + 1)) as TraeCredential
  } catch {
    return undefined
  }
}

const describeProbe = GATE ? describe : describe.skip

describeProbe('TRAE 1024 活动探针（**只读**：只调 status + activity/info）', () => {
  it('打印活动信息与签到状态的结构', async () => {
    const credential = readFirstTraeCredential()
    expect(credential, '凭据库里没有可用的 TRAE_ACCOUNT_* 条目').toBeDefined()
    const uid = credential!.uid
    console.log(`[探针] 凭据已读出：access_token 长度=${credential!.access_token.length}`
      + ` uid 长度=${String(uid ?? '').length}`)
    expect(String(uid ?? '').length, '凭据缺 uid ⇒ traeCheckinHeaders 派生不出设备头').toBeGreaterThan(0)

    const base = 'https://api.trae.cn'
    const headers = traeCheckinHeaders(credential!, {} as never, uid) as Record<string, string>
    console.log(`[探针] 请求头键：${Object.keys(headers).join(', ')}`)

    // ⚠️ **`req_source` 不是"来源字符串"，而是一个数字**（2026-10-20 客户端取证，
    //    `out/main.js` 的 `OGe(t,e,i)`）：`t ? 2 : 1`，其中 `t = isLite`（Trae Work/Lite）
    //    ⇒ **IDE 传 1、Lite 传 2**。我们是 IDE 侧行为 ⇒ 1。
    //    `_requestCommercialActivity` 的真实 body：
    //      `{ ...(activity_handle ? 额外字段 : {}), ...(activity_id ? {activity_id} : {}),
    //        ...(activity_info ? {version_code} : {}), req_source }`
    //    ⇒ `activity/info` 必须带 `version_code` + `req_source`，**空 body 拿到的可能不是全集**。
    const requests = [
      { label: '对照·签到状态', path: '/trae/api/v2/ug/checkin_credits/status', body: {} },
      { label: '★ 活动信息（空 body，第一轮）', path: '/trae/api/v2/ug/activity/info', body: {} },
      {
        label: '★ 活动信息（客户端真实 body）',
        path: '/trae/api/v2/ug/activity/info',
        body: { version_code: '3.5.2', req_source: 1 },
      },
    ]
    for (const { label, path, body: payload } of requests) {
      console.log(`\n========== [${label}] POST ${base}${path} ==========`)
      console.log(`  body=${JSON.stringify(payload)}`)
      try {
        const res = await fetch(`${base}${path}`, {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        })
        const text = await res.text()
        console.log(`  HTTP ${res.status}  响应长度 ${text.length}`)
        let body: unknown
        try {
          body = JSON.parse(text) as unknown
        } catch {
          console.log(`  ⚠️ 非 JSON，前 200 字符：${text.slice(0, 200)}`)
          continue
        }
        console.log(`  结构：${shapeOf(body)}`)
        // ⚠️ **必须逐项列出**：上面的结构行受 `shapeOf` 的 depth 限制，只展开数组**第一项**，
        //    而我们要找的是 `checkin_1024`（第一项是 `checkin_credits`）⇒ 得把 6 个活动都列出来。
        const acts = (body as { commercial_activities?: unknown }).commercial_activities
        if (Array.isArray(acts)) {
          console.log(`  —— ${acts.length} 个活动逐项 ——`)
          acts.forEach((a, i) => {
            const o = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>
            const fmt = (v: unknown): string => {
              const ms = Number(v)
              return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : String(v)
            }
            const shown = new Set(['activity_id', 'Enabled', 'activity_type', 'start_time_ms', 'end_time_ms'])
            console.log(`    [${i}] activity_id=${JSON.stringify(o['activity_id'])}`
              + ` Enabled=${String(o['Enabled'])} type=${String(o['activity_type'])}`
              + ` 窗口=${fmt(o['start_time_ms'])} → ${fmt(o['end_time_ms'])}`)
            // ⚠️ **`work_extra` 是资格/领取判据**（客户端 `_transformCommercialActivityInfo`
            //    读 `workExtra.{grantable, granted}`）⇒ 对我们重点关注的 `checkin_1024`
            //    必须把整块打出来（它不含账号标识，只有布尔与配额）。
            const extra = o['work_extra']
            if (extra !== undefined) {
              console.log(`         work_extra = ${shapeOf(extra)}`)
            }
          })
        }
      } catch (error) {
        console.log(`  ❌ 网络异常：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }, 120_000)
})