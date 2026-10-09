/**
 * captcha 载体页 origin 的解析与默认值锁死用例。
 *
 * ## 为什么专门锁它
 * `CAPTCHA_PAGE_ORIGIN` 是**实测出来的硬前提**（`about:blank` 的 origin 是字符串
 * `"null"`，第二次 mint 必 `F001`；真实 https origin 连续 5/5，矩阵见
 * `src/zcode-captcha.ts` 的 `CAPTCHA_PAGE_ORIGIN` 与 README 的 ZCode 章节）。
 *
 * 把它参数化**只有一个理由**：`scripts/probe-captcha-local-origin.mjs`（本地探针、
 * 不入库）要验证「本地 origin 到底行不行」—— DSH web 版若想让浏览器当载体，
 * 载体页只能是 GUI 自己的 origin。⚠ 它**不是配置项**：不许接 env、不许进
 * settings、不许给 UI 开关。本文件就是这条红线的机器证明。
 *
 * ## 为什么不测构造函数
 * `ZcodeCaptchaBrowser` 的构造是 `constructor(private readonly options = {})` ——
 * **原样存下整个对象**，未知键也在。所以「断言实例里存了 pageOrigin」这类写法
 * 在实现之前就会绿（同义反复）。本文件因此直接测**导航真正调用的解析函数**：
 * 它才是「注入值有没有被用上」的唯一可证点。
 *
 * ## 反向验证（已实跑，见 task-7 报告）
 * - 把缺省值从 `CAPTCHA_PAGE_ORIGIN` 换成硬编码另一 origin ⇒ 第 1、2 条变红；
 * - 忽略入参（恒返回常量）⇒ 第 3 条变红。
 */
import { describe, expect, it } from 'vitest'

import {
  CAPTCHA_PAGE_ORIGIN,
  resolveCaptchaPageOrigin,
} from '../../src/zcode-captcha.js'

describe('captcha 载体页 origin 的解析', () => {
  it('★ 缺省值就是实测常量（参数化不许改变生产行为）', () => {
    expect(CAPTCHA_PAGE_ORIGIN).toBe('https://zcode.z.ai/')
    expect(resolveCaptchaPageOrigin()).toBe('https://zcode.z.ai/')
    expect(resolveCaptchaPageOrigin({})).toBe(CAPTCHA_PAGE_ORIGIN)
  })

  it('空白/未定义的注入值一律回落到常量（防「注入成空串 ⇒ 导航 about:blank」）', () => {
    for (const bad of [undefined, '', '   ']) {
      expect(resolveCaptchaPageOrigin({ pageOrigin: bad })).toBe(CAPTCHA_PAGE_ORIGIN)
    }
  })

  it('非空注入值优先（本地探针靠这一条才改得动 origin）', () => {
    const local = 'http://127.0.0.1:8099/'
    expect(resolveCaptchaPageOrigin({ pageOrigin: local })).toBe(local)
    // 注入不改变常量本身
    expect(CAPTCHA_PAGE_ORIGIN).toBe('https://zcode.z.ai/')
  })
})
