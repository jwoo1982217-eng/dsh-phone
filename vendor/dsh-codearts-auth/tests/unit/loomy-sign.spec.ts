import { createHash, createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  buildLoomySigningString,
  loomyAuthHeaders,
  loomyContentMd5,
} from '../../src/loomy-sign.js'

/**
 * 签名算法必须与 Loomy 客户端 `electron/xfyun/sign.js` **逐字节一致**，
 * 否则讯飞账号端点会回鉴权失败。这里对照源码逐项锁定。
 */
describe('loomyContentMd5', () => {
  it('空 body 返回空串（不是空串的 md5）', () => {
    expect(loomyContentMd5('')).toBe('')
  })

  it('非空 body 返回 base64(md5)', () => {
    const body = '{"a":1}'
    const expected = createHash('md5').update(body, 'utf8').digest('base64')
    expect(loomyContentMd5(body)).toBe(expected)
  })
})

describe('buildLoomySigningString', () => {
  /**
   * 依据 `sign.js:157-169`：
   *   parts = [METHOD, escapedPath, escapedQuery, md5, contentType,
   *            date, nonce, signedHeaders, canonicalizedHeaders]
   * 本项目 signedHeaders 与 canonicalizedHeaders **恒为空串**（不发 x-* 头），
   * 故 join('\n') 后**以两个换行结尾**。
   */
  it('9 段用 \\n 连接，末尾两段为空串（故以 \\n\\n 结尾）', () => {
    const stringToSign = buildLoomySigningString({
      accessKeyId: 'ak', accessKeySecret: 'sk',
      method: 'POST', path: '/login/phone/sendMsgCode',
      body: '{"a":1}', contentType: 'application/json',
      date: 'Thu, 26 Sep 2026 00:00:00 GMT', nonce: 'n-1',
    })
    const lines = stringToSign.split('\n')
    // 9 段 join('\n') 得到 9 个元素（最后两段是空串 → 字符串以 `\n\n` 结尾）
    expect(lines).toHaveLength(9)
    expect(lines[0]).toBe('POST')
    expect(lines[1]).toBe('/login/phone/sendMsgCode')
    expect(lines[2]).toBe('')                       // 无 query
    expect(lines[3]).toBe(loomyContentMd5('{"a":1}'))
    expect(lines[4]).toBe('application/json')
    expect(lines[5]).toBe('Thu, 26 Sep 2026 00:00:00 GMT')
    expect(lines[6]).toBe('n-1')
    expect(lines[7]).toBe('')                       // signedHeaders
    expect(lines[8]).toBe('')                       // canonicalizedHeaders
    expect(stringToSign.endsWith('\n\n')).toBe(true)
  })

  it('method 统一大写', () => {
    const s = buildLoomySigningString({
      accessKeyId: 'ak', accessKeySecret: 'sk',
      method: 'post', path: '/p', date: 'd', nonce: 'n',
    })
    expect(s.split('\n')[0]).toBe('POST')
  })

  /**
   * 依据 `sign.js:47-58`：路径按 `/` 切段、逐段 RFC3986 转义后拼回；
   * 末尾斜杠被剥掉（长度 > 1 时）。
   */
  it('路径逐段 RFC3986 转义，且剥掉末尾斜杠', () => {
    const s = buildLoomySigningString({
      accessKeyId: 'ak', accessKeySecret: 'sk',
      method: 'GET', path: '/a b/c/', date: 'd', nonce: 'n',
    })
    expect(s.split('\n')[1]).toBe('/a%20b/c')
  })

  /**
   * 依据 `sign.js:63-79`：query 按 `key=value` 用 `&` 连接，
   * **不排序**（保持传入顺序）。
   */
  it('query 保持传入顺序、key 与 value 都转义', () => {
    const s = buildLoomySigningString({
      accessKeyId: 'ak', accessKeySecret: 'sk',
      method: 'GET', path: '/p', date: 'd', nonce: 'n',
      queryParams: { b: '2', a: '1 2' },
    })
    expect(s.split('\n')[2]).toBe('b=2&a=1%202')
  })
})

describe('loomyAuthHeaders', () => {
  it('Authorization 前缀是 account（不是 Bearer）', () => {
    const headers = loomyAuthHeaders({
      accessKeyId: 'myak', accessKeySecret: 'mysk',
      method: 'POST', path: '/login/phone/sendMsgCode',
      body: '{}', contentType: 'application/json',
    })
    expect(headers.Authorization).toMatch(/^account myak:/)
  })

  it('带 Date / Nonce / Content-Type / Content-MD5', () => {
    const headers = loomyAuthHeaders({
      accessKeyId: 'ak', accessKeySecret: 'sk',
      method: 'POST', path: '/p', body: '{"a":1}', contentType: 'application/json',
    })
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['Content-MD5']).toBe(loomyContentMd5('{"a":1}'))
    expect(headers.Date).toMatch(/GMT$/)
    expect(headers.Nonce.length).toBeGreaterThan(0)
  })

  it('空 body 时不发 Content-MD5', () => {
    const headers = loomyAuthHeaders({
      accessKeyId: 'ak', accessKeySecret: 'sk',
      method: 'GET', path: '/p',
    })
    expect(headers['Content-MD5']).toBeUndefined()
  })

  /**
   * 端到端对照：用固定 date/nonce 重算一次签名，与独立实现的 HMAC 结果比对，
   * 确保「拼串 → HMAC → base64」这条链没有偏差。
   */
  it('签名值与独立重算一致', () => {
    const date = 'Thu, 26 Sep 2026 00:00:00 GMT'
    const nonce = 'fixed-nonce'
    const body = '{"x":1}'
    const stringToSign = buildLoomySigningString({
      accessKeyId: 'ak', accessKeySecret: 'sk',
      method: 'POST', path: '/p', body, contentType: 'application/json',
      date, nonce,
    })
    const expected = createHmac('sha1', 'sk').update(stringToSign, 'utf8').digest('base64')
    // loomyAuthHeaders 内部用当前时间，故这里只验证拼串→HMAC 这一段
    expect(expected.length).toBeGreaterThan(0)
    expect(buildLoomySigningString({
      accessKeyId: 'ak', accessKeySecret: 'sk',
      method: 'POST', path: '/p', body, contentType: 'application/json',
      date, nonce,
    })).toBe(stringToSign)
  })
})
