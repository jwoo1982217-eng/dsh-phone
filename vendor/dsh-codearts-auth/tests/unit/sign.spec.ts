import { describe, expect, it } from 'vitest'
import { buildCanonicalRequest, sha256Hex, signRequestHuawei } from '../../src/sign.js'

describe('sha256Hex', () => {
  it('hex-encodes SHA-256 of the input', async () => {
    expect(await sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })
})

describe('buildCanonicalRequest', () => {
  it('sorts signed headers and joins lines', () => {
    const headers = new Map<string, string>([
      ['host', 'example.com'],
      ['x-sdk-date', '20260814T000000Z'],
    ])
    const canonical = buildCanonicalRequest('POST', '/v1/', '', headers, 'payloadhash')
    expect(canonical).toBe(
      'POST\n/v1/\n\nhost:example.com\nx-sdk-date:20260814T000000Z\n\nhost;x-sdk-date\npayloadhash',
    )
  })
})

describe('signRequestHuawei', () => {
  it('produces an SDK-HMAC-SHA256 Authorization header', async () => {
    const headers = await signRequestHuawei(
      'AK', 'SK', 'ST',
      'POST',
      'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2/chat/completions',
      new TextEncoder().encode('{}'),
    )
    expect(headers.get('x-security-token')).toBe('ST')
    expect(headers.get('content-type')).toBe('application/json')
    const auth = headers.get('Authorization') ?? ''
    expect(auth.startsWith('SDK-HMAC-SHA256 Access=AK,SignedHeaders=')).toBe(true)
    expect(auth).toMatch(/Signature=[0-9a-f]{64}$/)
    expect(auth).toContain('host;x-sdk-content-sha256;x-sdk-date;x-security-token')
  })
})
