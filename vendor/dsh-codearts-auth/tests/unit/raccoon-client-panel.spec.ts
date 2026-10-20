import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = readFileSync(resolve(here, '../../plugin-src/client/jet-hub.js'), 'utf8')
const capabilitiesSource = readFileSync(
  resolve(here, '../../plugin-src/client/credits-capabilities.js'), 'utf8',
)

/**
 * 客户端面板的线（Task 10）。
 *
 * ⚠️ 本文件的存在理由：**图标是「测试全过但功能坏掉」的高危区**。
 * 真实缺陷（本次实现时踩到）：脚本把**裸 RGBA 缓冲**直接 base64 当 PNG 用，
 * 产出的字符串长度正常（12310 字符）、`toContain('data:image/png;base64')` 也通过，
 * 但**不是合法 PNG** —— 浏览器渲染不出来，表现为图标位置一片空白。
 * 判据必须是「PNG 签名 + 可解码 + 尺寸正确」。
 */
describe('Raccoon 面板图标', () => {
  it('RACCOON_ICON 已声明且非空', () => {
    const m = /const RACCOON_ICON = '([^']*)'/.exec(clientSource)
    expect(m, '未找到 const RACCOON_ICON 声明').not.toBeNull()
    expect((m?.[1] ?? '').length).toBeGreaterThan(0)
  })

  it('**是合法的 PNG 文件字节**（不是裸 RGBA 缓冲）', () => {
    const m = /const RACCOON_ICON = 'data:image\/png;base64,([^']*)'/.exec(clientSource)
    expect(m, '图标不是 PNG data URL').not.toBeNull()
    const bytes = Buffer.from(m?.[1] ?? '', 'base64')
    // PNG 签名固定 8 字节
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    // IHDR 里的宽高必须是 48×48（脚本默认 size）
    expect(bytes.readUInt32BE(16)).toBe(48)
    expect(bytes.readUInt32BE(20)).toBe(48)
    // 位深 8、color type 6（RGBA）、非隔行
    expect(bytes[24]).toBe(8)
    expect(bytes[25]).toBe(6)
    expect(bytes[28]).toBe(0)
  })

  it('图标不是纯透明图（真的画了东西）', () => {
    const m = /const RACCOON_ICON = 'data:image\/png;base64,([^']*)'/.exec(clientSource)
    const bytes = Buffer.from(m?.[1] ?? '', 'base64')
    // 用 zlib 解 IDAT 太麻烦；这里用「字节熵」做粗判：
    // 全透明图的 IDAT 会被 deflate 压到极小，且整体字节数会很小。
    expect(bytes.length).toBeGreaterThan(500)
    // 非零字节占比应显著（真图有大量颜色数据）
    let nonZero = 0
    for (const b of bytes) if (b !== 0) nonZero++
    expect(nonZero / bytes.length).toBeGreaterThan(0.3)
  })

  it('PROVIDERS 里有 raccoon，且指向 RACCOON_ICON', () => {
    expect(clientSource).toMatch(
      /\{ id: 'raccoon', label: 'Raccoon \(商汤\)', icon: RACCOON_ICON, logoClass: 'raccoon' \}/,
    )
  })

  /**
   * ⚠️ **真实缺陷回归**（用户报障）：provider Tab 用
   * 『Raccoon Work (商汤)』时**触发换行**，列表观感被破坏。
   *
   * 判据用「长度上限」而不是只断言精确字符串 —— 后者改个名就失效，
   * 前者能一并防住「以后又写长了」。
   * 对照：`CodeBuddy (腾讯)`=13 / `WorkBuddy (国际版)`=15 / `LobsterAI (有道)`=15。
   */
  it('provider 标签足够短（不触发换行）', () => {
    const m = /\{ id: 'raccoon', label: '([^']*)'/.exec(clientSource)
    expect(m, '未找到 raccoon 的 PROVIDERS 项').not.toBeNull()
    const label = m?.[1] ?? ''
    expect(label).toBe('Raccoon (商汤)')
    expect(label.length, `标签「${label}」过长，会在 Tab 里换行`).toBeLessThanOrEqual(15)
  })

  it('产品配置的 displayName 与客户端 label 一致（防止两处漂移）', () => {
    const productSource = readFileSync(
      resolve(here, '../../src/raccoon-product.ts'), 'utf8',
    )
    const display = /displayName: '([^']*)'/.exec(productSource)
    expect(display?.[1]).toBe('Raccoon (商汤)')
    const label = /\{ id: 'raccoon', label: '([^']*)'/.exec(clientSource)
    expect(label?.[1]).toBe(display?.[1])
  })

  it('logoClass 与 PROVIDERS 项一致', () => {
    expect(clientSource).toContain("logoClass: 'raccoon'")
  })
})

describe('Raccoon 的能力登记', () => {
  it('**登记了 onboardingTasks（登录奖励）**，故面板会渲染领取按钮', () => {
    expect(capabilitiesSource).toMatch(
      /raccoon: Object\.freeze\(\{ balance: true, onboardingTasks: true \}\)/,
    )
  })

  it('**没有登记 dailyCheckin**（每日 300 无端点，登记了会让按钮必然失败）', () => {
    // 抓 raccoon 那一行，确认其中不含 dailyCheckin
    const line = capabilitiesSource.split('\n').find((l) => l.includes('raccoon: Object.freeze'))
    expect(line).toBeDefined()
    expect(line).not.toContain('dailyCheckin')
  })
})
