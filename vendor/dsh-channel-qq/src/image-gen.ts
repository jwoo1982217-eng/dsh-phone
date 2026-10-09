/** Text-to-image via an OpenAI-compatible images gateway.
 *
 * POST {base}/images/generations → {data:[{url|b64_json}]}; the artifact is
 * downloaded to the channel cache and returned as a local path for the
 * OneBot `image` segment. Long budgets: seedream runs ~60s per picture.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const DEFAULT_BASE = 'https://applecabal.us.ci/v1'
const DEFAULT_KEY = 'rf-a6d7536b496b8f6f'
const DEFAULT_MODEL = 'seedream-5.0'

export const IMAGE_MODELS = [
  'seedream-5.0', 'seedream-5.0-pro', 'seedream-4.5', 'nano-banana-pro',
  'nano-banana', 'flux-schnell', 'gpt-image-1.5', 'dall-e-3',
]

export interface DrawResult { imagePath: string; model: string; bytes: number }

function imagesDir(): string {
  const dir = path.join(process.env.DSH_HOME ?? path.join(process.env.HOME ?? '.', '.dsh'), 'channel-qq', 'images')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function extFor(url: string, contentType: string | null): string {
  const fromUrl = /\.([a-z0-9]{3,5})(?:\?|$)/i.exec(url)?.[1]?.toLowerCase()
  if (fromUrl !== undefined && fromUrl.length <= 5) return fromUrl
  const fromCt = contentType?.split('/')[1]?.split(';')[0]
  return (fromCt && fromCt.length <= 5) ? fromCt : 'png'
}

export async function drawImage(options: {
  prompt: string
  model?: string
  size?: string
  base?: string
  apiKey?: string
}): Promise<DrawResult> {
  const model = options.model?.trim() || DEFAULT_MODEL
  const size = options.size?.trim() || '1024x1024'
  const base = (options.base ?? DEFAULT_BASE).replace(/\/+$/, '')
  const apiKey = options.apiKey ?? DEFAULT_KEY

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 180000)
  try {
    const resp = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, prompt: options.prompt, n: 1, size }),
      signal: controller.signal,
    })
    if (!resp.ok) {
      const detail = await resp.text().catch(() => '')
      throw new Error(`文生图失败 HTTP ${resp.status}: ${detail.slice(0, 200)}`)
    }
    const payload = await resp.json() as { data?: Array<{ url?: string; b64_json?: string }> }
    const item = payload.data?.[0]
    if (item === undefined) throw new Error('文生图返回为空')

    const dir = imagesDir()
    const stamp = Date.now()
    let imagePath: string
    let bytes: number
    if (item.b64_json !== undefined && item.b64_json !== '') {
      const buf = Buffer.from(item.b64_json, 'base64')
      imagePath = path.join(dir, `draw-${stamp}.png`)
      fs.writeFileSync(imagePath, buf)
      bytes = buf.length
    } else if (item.url !== undefined) {
      const imgResp = await fetch(item.url, { signal: controller.signal })
      if (!imgResp.ok) throw new Error(`图片下载失败 HTTP ${imgResp.status}`)
      const buf = Buffer.from(await imgResp.arrayBuffer())
      imagePath = path.join(dir, `draw-${stamp}.${extFor(item.url, imgResp.headers.get('content-type'))}`)
      fs.writeFileSync(imagePath, buf)
      bytes = buf.length
    } else {
      throw new Error('文生图返回既无 url 也无 b64_json')
    }
    return { imagePath, model, bytes }
  } finally {
    clearTimeout(timer)
  }
}
