/**
 * AStudio 微信扫码 · 真实上游**交互式探针**（会弹浏览器窗口，需人工扫码）
 *
 * ## 为什么需要它（2026-10-20 用户要求）
 *
 * 报障：**第一次**扫码成功、**第二次**扫码报「已扫码，但上游未下发账号标识」
 * （= `pollAstudioWechatScan` 的 `accounts` 解析为空 ⇒ unbound）。
 * 这条路径在生产里**没有任何留痕**，而每验证一次都要重构建 + 重启 dsh web（很贵）。
 *
 * ⇒ 本探针**直接 import `src/`**（零构建、不依赖 dsh web），弹出真实二维码，
 *    并把**每一轮上游响应的结构**（键名 + 值类型 + 数组长度，**不含任何账号值**）
 *    打印到终端。用它跑两轮（同一个微信号）即可对照出「第二次到底少了什么」。
 *
 * ## 用法
 *
 * ```powershell
 * $env:DSH_ASTUDIO_SCAN_E2E='1'; $env:DSH_ASTUDIO_SCAN_E2E_CONFIRM='yes'
 * $env:DSH_ASTUDIO_SCAN_ROUNDS='2'          # 想扫几轮（默认 2）
 * pnpm test:e2e:astudio-scan
 * ```
 *
 * 终端会打印二维码 URL 并**自动用系统默认程序打开二维码** ⇒ 用微信扫。
 * 每轮的 `[上游原始结构]` 那行就是证据；把两轮的输出贴回来即可定位差异。
 *
 * ## ⚠️ 闸门默认关闭
 *
 * `DSH_ASTUDIO_SCAN_E2E=1` **且** `DSH_ASTUDIO_SCAN_E2E_CONFIRM=yes` 才跑。
 * ⇒ 它属于**交互式**探针，绝不会在 `pnpm test` / CI 里自动打开用户桌面上的窗口
 * （本仓库有「单测弹出真实浏览器窗口」的事故先例，故必须双向闸门）。
 *
 * ⚠️ 只打印**结构**：值一律换成类型名（`string(12)` / `number` / `array(3)` / `null`），
 *    不打印账号标识本身。
 */
import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import {
  createAstudioWechatQrCode,
  pollAstudioWechatScan,
} from '../../src/astudio-oauth.js'

const GATE = process.env['DSH_ASTUDIO_SCAN_E2E'] === '1'
  && process.env['DSH_ASTUDIO_SCAN_E2E_CONFIRM'] === 'yes'
const ROUNDS = Math.max(1, Number(process.env['DSH_ASTUDIO_SCAN_ROUNDS'] ?? '2') || 2)
const WAIT_MS = Math.max(10_000, Number(process.env['DSH_ASTUDIO_SCAN_WAIT_MS'] ?? '300000') || 300_000)

/** 把任意 JSON 值压成**结构描述**（键名 + 类型 + 长度，**不含值**）。 */
function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (Array.isArray(value)) {
    return value.length === 0
      ? 'array(0)'
      : `array(${value.length})[${shapeOf(value[0], depth + 1)}]`
  }
  if (typeof value === 'object') {
    if (depth >= 3) return 'object(…)'
    const o = value as Record<string, unknown>
    return `{ ${Object.keys(o).map((k) => `${k}: ${shapeOf(o[k], depth + 1)}`).join(', ')} }`
  }
  if (typeof value === 'string') return `string(${value.length})`
  return typeof value
}

/**
 * 用系统默认程序打开 URL。
 *
 * ⚠️ **不用 `cmd /c start`**：它把 `&` 当命令分隔符，会在第一个 `&` 处截断 URL
 * （本仓库 accio 踩过：症状是弹出文件管理器 + 回调永不到达）。
 */
function openUrl(url: string): void {
  execFile('rundll32', ['url.dll,FileProtocolHandler', url], () => { /* 打不开就算了，终端还有 URL */ })
}

const describeProbe = GATE ? describe : describe.skip

describeProbe('AStudio 扫码探针（**交互式**：会弹浏览器窗口，需人工扫码）', () => {
  it(
    `连续扫码 ${ROUNDS} 轮并打印每轮上游响应的**结构**`,
    async () => {
      console.log(`\n[探针] ${ROUNDS} 轮；每轮等待人工扫码最长 ${Math.round(WAIT_MS / 1000)}s`)
      for (let round = 1; round <= ROUNDS; round += 1) {
        const qr = await createAstudioWechatQrCode({})
        console.log(`\n========== 第 ${round} 轮 ==========`)
        console.log(`[探针] fd = ${qr.fd}`)
        console.log(`[探针] 二维码 = ${qr.qrUrl}`)
        openUrl(qr.qrUrl)
        console.log('[探针] 已用系统默认程序打开二维码 ⇒ 请用微信扫（同一个微信号，模拟报障场景）')

        const deadline = Date.now() + WAIT_MS
        let sawRaw = false
        let lastStatus = ''
        let finished = false
        while (Date.now() < deadline && !finished) {
          const res = await pollAstudioWechatScan(qr.fd, {
            onRaw: (raw) => {
              sawRaw = true
              console.log(`[第 ${round} 轮 · 上游原始结构] ${shapeOf(raw)}`)
              // ⚠️ **信封状态字段直出值**：`flag` / `code` / `desc` 是**信封层**的
              //    状态描述（不是账号标识），直出才能看清上游到底说「成功」还是别的。
              //    ⚠️ 账号相关字段（`uid` / `ssoSessionId` / `token`）**一律只打类型与长度**。
              const rec = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
              console.log(`[第 ${round} 轮 · 信封] flag=${String(rec.flag)} code=${String(rec.code)}`
                + ` desc=${JSON.stringify(rec.desc)}`)
            },
          })
          if (res.status !== lastStatus) {
            const msg = 'message' in res && res.message ? ` message=${String(res.message).slice(0, 140)}` : ''
            console.log(`[第 ${round} 轮 · 判定] status=${res.status}${msg}`)
            lastStatus = res.status
          }
          if (res.status === 'scanned' || res.status === 'unbound' || res.status === 'error') {
            finished = true
          } else {
            await new Promise((r) => setTimeout(r, 2000))
          }
        }
        if (!finished) console.log(`[第 ${round} 轮] 等待超时（未扫码）`)
        expect(sawRaw, `第 ${round} 轮一个上游响应都没拿到 —— 网络或端点问题`).toBe(true)
      }
    },
    Math.max(60_000, ROUNDS * WAIT_MS + 30_000),
  )
})