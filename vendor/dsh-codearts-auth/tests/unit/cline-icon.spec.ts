import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '../..')
const JET_HUB_SOURCE = join(REPO_ROOT, 'plugin-src', 'client', 'jet-hub.js')

/**
 * ⚠️ 提取脚本**不入库**（`scripts/` 整目录在 `.gitignore` 里：只读排查与研究工具
 * 仅本地保留），所以这里**不能**写静态 `import`。
 *
 * **真实缺陷**（2026-10-02 定位）：本文件原先在顶部静态
 * `import { decodePng, … } from '../../scripts/extract-cline-icon.mjs'` —— 静态 import
 * 会在 **收集阶段**解析模块，脚本不存在时（干净克隆 / CI / 换台机器）整份套件直接
 * 变成 **Failed Suite（0 条用例）**，报错只有一句 `Failed to load url …`，既不是
 * 断言失败、也没有任何「已跳过」提示。而这**正是本文件下方注释早已警告过的失效
 * 模式**（「收集阶段读文件会让 skip 变成 Failed Suite」）—— 当时只为官方 PNG 路径
 * 加了 `existsSync` 守卫，静态 import 这条通路漏掉了，自相矛盾。
 *
 * 现在改为 **惰性动态加载 + 存在性守卫**：脚本不在时，需要它的两条用例干净跳过。
 */
const ICON_SCRIPT = resolve(REPO_ROOT, 'scripts', 'extract-cline-icon.mjs')
const hasIconScript = existsSync(ICON_SCRIPT)
interface IconTools {
  decodePng: (bytes: Buffer) => { width: number; height: number; rgba: Uint8Array }
  encodePng: (rgba: Uint8Array, width: number, height: number, filter?: string) => Buffer
  resizeArea: (rgba: Uint8Array, w: number, h: number, tw: number, th: number) => Uint8Array
}
let iconTools: Promise<IconTools> | null = null
const loadIconTools = async (): Promise<IconTools> => {
  iconTools ??= import(/* @vite-ignore */ pathToFileURL(ICON_SCRIPT).href) as Promise<IconTools>
  return iconTools
}

/**
 * Cline 面板图标的回归测试。
 *
 * ## 为什么需要这个文件
 *
 * **真实缺陷**（用户报障）：「我们用的图标和 cline 的好像不一样」。
 *
 * 初版图标是**凭印象手绘**的内联 SVG（「C 形弧线 + 圆角方块」），与 Cline 的
 * 真实标志（**顶部带凸起的圆角方块 + 中间两条竖线 + 左右两侧尖角**）完全不符。
 * 修法是从本机官方安装目录提取真实图标（`scripts/extract-cline-icon.mjs`）。
 *
 * 本测试因此守两件事：
 * 1. 内联的必须是**结构完整的 PNG**（防退回手绘 SVG）；
 * 2. 它与「从官方 PNG 重新提取」的结果**逐字节一致**（防图标被悄悄改坏）。
 *
 * ⚠️ 官方源文件可能不存在（未安装 Cline 的机器 / CI）——那条用例**干净跳过**，
 * 而不是失败。故路径探测用轻量的 `existsSync`，**内容读取留在测试体内**
 * （惰性读取：在收集阶段读不存在的文件会让整份套件变成 Failed Suite 而非 skip）。
 */
describe('Cline 面板图标（必须来自官方提取，不得手绘）', () => {
  /** 从客户端源码里取出 `CLINE_ICON` 的 data URI。 */
  function readIconDataUri(): string {
    const source = readFileSync(JET_HUB_SOURCE, 'utf8')
    const matched = /const CLINE_ICON = '([^']*)'/.exec(source)
    if (matched === null) throw new Error("jet-hub.js 里找不到 const CLINE_ICON = '...' 声明")
    return matched[1]!
  }

  it('是 PNG data URI，不是手绘 SVG', () => {
    const uri = readIconDataUri()
    // 这条断言就是「防退回手绘」的闸门：初版是 data:image/svg+xml;base64,...
    expect(uri.startsWith('data:image/png;base64,'), `当前形态：${uri.slice(0, 40)}…`).toBe(true)
    expect(uri.startsWith('data:image/svg+xml')).toBe(false)
  })

  it('base64 解码后是结构完整的 PNG，且尺寸为 48×48', () => {
    const uri = readIconDataUri()
    const bytes = Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64')

    // PNG 签名（8 字节）
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // 第一个 chunk 必须是 IHDR，长度 13
    expect(bytes.toString('ascii', 12, 16)).toBe('IHDR')
    expect(bytes.readUInt32BE(8)).toBe(13)
    // IHDR：宽 / 高 / 位深 8 / color type 6(RGBA) / 非隔行
    expect(bytes.readUInt32BE(16)).toBe(48)
    expect(bytes.readUInt32BE(20)).toBe(48)
    expect(bytes[24]).toBe(8)
    expect(bytes[25]).toBe(6)
    expect(bytes[28]).toBe(0)
    // 以 IEND 结尾
    expect(bytes.toString('ascii', bytes.length - 8, bytes.length - 4)).toBe('IEND')
    // 体积下限：真实位图图标远大于手绘 SVG 的几百字节
    expect(bytes.length).toBeGreaterThan(1_000)
  })

  it.skipIf(!hasIconScript)('能被提取脚本自己的解码器读回（编码/解码自洽）', async () => {
    const { decodePng } = await loadIconTools()
    const uri = readIconDataUri()
    const bytes = Buffer.from(uri.slice('data:image/png;base64,'.length), 'base64')
    const decoded = decodePng(bytes)
    expect(decoded.width).toBe(48)
    expect(decoded.height).toBe(48)
    expect(decoded.rgba.length).toBe(48 * 48 * 4)
    // 四角应是透明的（官方图标带透明圆角）
    const alphaAt = (x: number, y: number): number => decoded.rgba[(y * 48 + x) * 4 + 3]!
    expect(alphaAt(0, 0)).toBe(0)
    expect(alphaAt(47, 0)).toBe(0)
    expect(alphaAt(0, 47)).toBe(0)
    expect(alphaAt(47, 47)).toBe(0)
    // 中心应是不透明的品牌紫/白色标记区域
    expect(alphaAt(24, 24)).toBe(255)
  })

  /**
   * ⚠️ 需要「本机装了 Cline」（官方图标源存在）**且**「提取脚本存在」（它不入库）。
   * 两者缺任一则跳过 —— 不断言失败。
   */
  const appDir = process.env.CLINE_APP_DIR !== undefined && process.env.CLINE_APP_DIR.length > 0
    ? process.env.CLINE_APP_DIR
    : join(process.env.LOCALAPPDATA ?? '', 'Cline')
  const officialClassic = join(appDir, 'icons', 'app', 'macos', 'classic.png')
  const hasOfficialSource = existsSync(officialClassic)

  it.skipIf(!hasOfficialSource || !hasIconScript)(
    '与「从官方 classic.png 重新提取」的结果逐字节一致',
    async () => {
      const { decodePng, encodePng, resizeArea } = await loadIconTools()
      // 惰性读取（见文件头注释：收集阶段读文件会让 skip 变成 Failed Suite）
      const source = decodePng(readFileSync(officialClassic))
      const regenerated = encodePng(
        resizeArea(source.rgba, source.width, source.height, 48, 48), 48, 48, 'paeth',
      )
      const inlined = Buffer.from(readIconDataUri().slice('data:image/png;base64,'.length), 'base64')
      expect(inlined.equals(regenerated), '内联图标与官方源提取结果不一致（图标可能被改坏）').toBe(true)
    },
  )

  it('前置条件缺失时明确记录（便于解释上面哪些用例被跳过）', () => {
    if (!hasIconScript) {
      console.log(`\n[cline-icon] 未找到提取脚本：${ICON_SCRIPT}\n  → 依赖它的两条用例已跳过。该脚本不入库（scripts/ 在 .gitignore 内），干净克隆与 CI 本来就没有它，属预期。`)
    }
    if (!hasOfficialSource) {
      console.log(`\n[cline-icon] 未找到官方图标源：${officialClassic}\n  → 逐字节比对用例已跳过；如需校验请安装 Cline 或设置 CLINE_APP_DIR。`)
    }
    expect(typeof hasIconScript).toBe('boolean')
    expect(typeof hasOfficialSource).toBe('boolean')
  })
})
