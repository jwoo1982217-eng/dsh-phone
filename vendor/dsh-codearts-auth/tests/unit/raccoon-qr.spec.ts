import { describe, expect, it } from 'vitest'
import { buildQrMatrix, renderQrSvg } from '../../src/raccoon-qr.js'

describe('buildQrMatrix', () => {
  it('尺寸符合 QR 规范（21 + 4×(版本-1)）', () => {
    const { size, modules } = buildQrMatrix('HELLO')
    expect([21, 25, 29, 33, 37, 41].includes(size)).toBe(true)
    expect(modules.length).toBe(size)
    for (const row of modules) expect(row.length).toBe(size)
  })

  it('三个角有 finder pattern（7×7 的方框）', () => {
    const { size, modules } = buildQrMatrix('https://xiaohuanxiong.com/login/mp?code=abc')
    // 左上角：外圈是黑，内 5×5 的第 2 圈是白，中心 3×3 是黑
    const checkFinder = (rowStart: number, colStart: number): void => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const isBorder = r === 0 || r === 6 || c === 0 || c === 6
          const isCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4
          const expected = isBorder || isCenter
          expect(modules[rowStart + r]?.[colStart + c], `(${rowStart + r},${colStart + c})`).toBe(expected)
        }
      }
    }
    checkFinder(0, 0)
    checkFinder(0, size - 7)
    checkFinder(size - 7, 0)
  })

  it('右下角没有 finder pattern（只有三个角有）', () => {
    const { size, modules } = buildQrMatrix('TEST')
    // 右下角 7×7 不应是完整的 finder
    let allBorderBlack = true
    for (let c = 0; c < 7; c++) {
      if (modules[size - 7]?.[size - 7 + c] !== true) allBorderBlack = false
    }
    expect(allBorderBlack).toBe(false)
  })

  it('相同输入产生相同矩阵（确定性）', () => {
    const a = buildQrMatrix('SAME')
    const b = buildQrMatrix('SAME')
    expect(a.modules).toEqual(b.modules)
  })

  it('不同输入产生不同矩阵', () => {
    const a = buildQrMatrix('AAA')
    const b = buildQrMatrix('BBB')
    expect(a.modules).not.toEqual(b.modules)
  })

  it('内容变长时版本提升（矩阵变大）', () => {
    const short = buildQrMatrix('A')
    const long = buildQrMatrix('https://xiaohuanxiong.com/login/mp?code=' + 'a'.repeat(64))
    expect(long.size).toBeGreaterThanOrEqual(short.size)
  })

  it('空字符串不抛错（产出最小矩阵）', () => {
    expect(() => buildQrMatrix('')).not.toThrow()
  })

  it('真实长度的登录 URL 可编码（含中文 appname 的 percent-encoding）', () => {
    const params = new URLSearchParams({ code: 'a'.repeat(32), appname: '商汤小浣熊官网' })
    const url = `https://xiaohuanxiong.com/login/mp?${params.toString()}`
    // 该 URL 约 145 字节，需要版本 8
    const { size } = buildQrMatrix(url)
    expect(size).toBeGreaterThanOrEqual(49)
  })

  it('内容超出支持范围时抛可读错误（不静默产出坏码）', () => {
    expect(() => buildQrMatrix('x'.repeat(1000))).toThrow(/过长|超出/)
  })
})

describe('renderQrSvg', () => {
  it('产出合法 SVG 字符串，含 viewBox 与 path', () => {
    const svg = renderQrSvg('HELLO')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('viewBox=')
    expect(svg).toContain('<path')
    expect(svg).toContain('</svg>')
  })

  it('size 选项生效', () => {
    const svg = renderQrSvg('HELLO', { size: 158 })
    expect(svg).toContain('width="158"')
    expect(svg).toContain('height="158"')
  })

  it('自定义颜色生效', () => {
    const svg = renderQrSvg('HELLO', { dark: '#8E6BF2' })
    expect(svg).toContain('#8E6BF2')
  })

  it('viewBox 含静区（默认 4 模块）', () => {
    const { size } = buildQrMatrix('HELLO')
    const svg = renderQrSvg('HELLO')
    expect(svg).toContain(`viewBox="0 0 ${size + 8} ${size + 8}"`)
  })

  it('可指定 margin', () => {
    const { size } = buildQrMatrix('HELLO')
    const svg = renderQrSvg('HELLO', { margin: 0 })
    expect(svg).toContain(`viewBox="0 0 ${size} ${size}"`)
  })

  it('深色模块数等于矩阵里的 true 数（SVG 与矩阵一致）', () => {
    const { modules } = buildQrMatrix('HELLO')
    const darkCount = modules.flat().filter(Boolean).length
    const svg = renderQrSvg('HELLO')
    expect(svg.split('M').length - 1).toBe(darkCount)
  })
})

/**
 * 掩码参数的回归（诊断与交叉验证用）。
 *
 * ⚠️ 这一组断言的存在理由：`options.mask` 曾被发现**不生效**
 * （不同掩码产出相同矩阵），而当时的测试看不出来。这里锁死「不同掩码
 * 产出不同矩阵」这一事实。
 */
describe('mask 参数', () => {
  it('8 个掩码产出各不相同的矩阵', () => {
    const sigs = new Set<string>()
    for (let mask = 0; mask < 8; mask++) {
      const { modules } = buildQrMatrix('HELLO', { mask })
      sigs.add(modules.map((r) => r.map((c) => (c ? '1' : '0')).join('')).join('|'))
    }
    expect(sigs.size).toBe(8)
  })

  it('非法掩码抛错', () => {
    expect(() => buildQrMatrix('HELLO', { mask: 8 })).toThrow(/掩码/)
    expect(() => buildQrMatrix('HELLO', { mask: -1 })).toThrow(/掩码/)
    expect(() => buildQrMatrix('HELLO', { mask: 1.5 })).toThrow(/掩码/)
  })

  it('不传 mask 时自动选出的掩码是 0..7 之一，且矩阵与对应固定掩码一致', () => {
    const auto = buildQrMatrix('HELLO')
    const autoSig = auto.modules.map((r) => r.map((c) => (c ? '1' : '0')).join('')).join('|')
    const matched = [0, 1, 2, 3, 4, 5, 6, 7].some((mask) => {
      const fixed = buildQrMatrix('HELLO', { mask })
      return fixed.modules.map((r) => r.map((c) => (c ? '1' : '0')).join('')).join('|') === autoSig
    })
    expect(matched).toBe(true)
  })
})
