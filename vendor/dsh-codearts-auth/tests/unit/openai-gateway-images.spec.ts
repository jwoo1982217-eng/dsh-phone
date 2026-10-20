import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkImageLimits,
  DEFAULT_IMAGE_LIMITS,
  parseImageDataUrl,
  toImageBlock,
} from '../../src/openai-gateway/images.js'

/** 最小合法 PNG（1×1）。 */
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const DATA_PNG = `data:image/png;base64,${PNG_1x1}`

const bridge = { saveImage: vi.fn().mockResolvedValue({ attachmentId: 'sha256:abc', mediaType: 'image/png' }) }
const noop = { count: 0, bytes: 0 }

// ⚠️ 共享 mock 必须逐例清空：否则「本例断言没调用」会被前一个用例的调用记录
// 误判为失败（mock.calls 是累积的）。
beforeEach(() => {
  bridge.saveImage.mockClear()
  bridge.saveImage.mockResolvedValue({ attachmentId: 'sha256:abc', mediaType: 'image/png' })
})

describe('parseImageDataUrl', () => {
  it('解析 base64 data URL 并解出字节', () => {
    const parsed = parseImageDataUrl(DATA_PNG)
    expect(parsed?.mediaType).toBe('image/png')
    // 1×1 PNG 解出来是 70 字节（探针实测 attachments 也回报 bytes:70）
    expect(parsed?.data).toBeInstanceOf(Uint8Array)
    expect(parsed?.data.length).toBe(70)
  })

  it('接受带额外参数与折行的 base64（客户端常这么发）', () => {
    const wrapped = `data:image/PNG;charset=utf-8;base64,${PNG_1x1.slice(0, 30)}\n${PNG_1x1.slice(30)}`
    expect(parseImageDataUrl(wrapped)?.data.length).toBe(70)
  })

  it('⚠️ 非 base64 的 data URL 一律拒绝（附件服务无法据此判定内容类型）', () => {
    expect(parseImageDataUrl('data:text/plain,hello')).toBeUndefined()
    expect(parseImageDataUrl(`data:image/png,${PNG_1x1}`)).toBeUndefined()
  })

  it('⚠️ http(s) 链接、非法 base64、空内容都不是 data URL', () => {
    // http URL 的处理不在这里 —— 它在 toImageBlock 里被更明确地拒绝（SSRF 理由）。
    expect(parseImageDataUrl('https://example.com/a.png')).toBeUndefined()
    expect(parseImageDataUrl(`data:image/png;base64,!!!not-base64!!!`)).toBeUndefined()
    expect(parseImageDataUrl('data:image/png;base64,')).toBeUndefined()
    expect(parseImageDataUrl(123)).toBeUndefined()
    expect(parseImageDataUrl(null)).toBeUndefined()
  })

  it('媒体类型归一化为小写', () => {
    expect(parseImageDataUrl(`data:image/PNG;base64,${PNG_1x1}`)?.mediaType).toBe('image/png')
  })
})

describe('checkImageLimits', () => {
  const limits = DEFAULT_IMAGE_LIMITS

  it('通过时不返回原因', () => {
    expect(checkImageLimits('image/png', 70, limits, 0, 0)).toBeUndefined()
  })

  it('格式不在白名单时给出可读原因（列出可用格式）', () => {
    const reason = checkImageLimits('image/bmp', 70, limits, 0, 0)
    expect(reason).toContain('image/bmp')
    expect(reason).toContain('image/png')
  })

  it('单张超限时说清实际值与上限', () => {
    const reason = checkImageLimits('image/png', limits.maxImageBytes + 1, limits, 0, 0)
    expect(reason).toContain('超过上限')
  })

  it('单条消息张数超限', () => {
    const reason = checkImageLimits('image/png', 70, limits, limits.maxImagesPerMessage, 0)
    expect(reason).toContain(`${limits.maxImagesPerMessage}`)
  })

  it('单条消息总字节超限', () => {
    const reason = checkImageLimits('image/png', 70, limits, 0, limits.maxMessageImageBytes)
    expect(reason).toContain('总大小')
  })

  it('恰好等于上限时通过（不是 >= 就拒）', () => {
    expect(checkImageLimits('image/png', limits.maxImageBytes, limits, 0, 0)).toBeUndefined()
    expect(checkImageLimits('image/png', 70, limits, limits.maxImagesPerMessage - 1, 0)).toBeUndefined()
  })
})

describe('toImageBlock', () => {
  it('把 data URL 落成附件并返回 ImageBlock', async () => {
    const block = await toImageBlock(DATA_PNG, bridge, DEFAULT_IMAGE_LIMITS, noop)
    expect(block.type).toBe('image')
    expect(block.attachment).toEqual({ attachmentId: 'sha256:abc', mediaType: 'image/png' })
    // 交给附件服务的形状必须是 {data, mediaType}（探针实测契约）
    const [arg] = bridge.saveImage.mock.calls[0]!
    expect(Object.keys(arg!).sort()).toEqual(['data', 'mediaType'])
    expect((arg as { data: Uint8Array }).data).toBeInstanceOf(Uint8Array)
  })

  it('⚠️ http(s) 链接明确拒绝，并说明是 SSRF 理由（而不是含糊的解析失败）', async () => {
    await expect(toImageBlock('https://example.com/a.png', bridge, DEFAULT_IMAGE_LIMITS, noop))
      .rejects.toThrow(/SSRF/)
    expect(bridge.saveImage).not.toHaveBeenCalled()
  })

  it('⚠️ 解析失败必须抛错，绝不静默丢图（静默会让用户以为模型看到了图）', async () => {
    await expect(toImageBlock('data:image/png,notbase64', bridge, DEFAULT_IMAGE_LIMITS, noop))
      .rejects.toThrow(/data URL/)
    await expect(toImageBlock(undefined, bridge, DEFAULT_IMAGE_LIMITS, noop)).rejects.toThrow()
    expect(bridge.saveImage).not.toHaveBeenCalled()
  })

  it('⚠️ 附件服务抛错时保留其原因（否则用户只看到英文内部错误）', async () => {
    const failing = { saveImage: vi.fn().mockRejectedValue(new Error('AttachmentError: Image is empty.')) }
    await expect(toImageBlock(DATA_PNG, failing, DEFAULT_IMAGE_LIMITS, noop))
      .rejects.toThrow(/Image is empty/)
  })

  it('⚠️ 附件服务返回空引用时抛错（不能把 undefined 塞进 ImageBlock）', async () => {
    const empty = { saveImage: vi.fn().mockResolvedValue(undefined) }
    await expect(toImageBlock(DATA_PNG, empty, DEFAULT_IMAGE_LIMITS, noop))
      .rejects.toThrow(/没有返回/)
  })

  it('超限时**不**调用附件服务（前置校验的意义就是不浪费落盘）', async () => {
    await expect(toImageBlock(DATA_PNG, bridge, DEFAULT_IMAGE_LIMITS, {
      count: DEFAULT_IMAGE_LIMITS.maxImagesPerMessage, bytes: 0,
    })).rejects.toThrow()
    expect(bridge.saveImage).not.toHaveBeenCalled()
  })
})
