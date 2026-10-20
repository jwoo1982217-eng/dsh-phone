/**
 * TRAE 产品配置单元测试。
 *
 * 重点锁住两类事实：
 * 1. 配置里的字面量与 `trae2api` 逆向结果一致（改错端点/版本号会让请求静默失败）；
 * 2. **不**含其它 product 类型的专有字段 —— 避免被误当成 BuddyProduct /
 *    LobsteraiProduct 使用（三个类型刻意是平级而非继承）。
 */

import { describe, expect, it } from 'vitest'
import {
  TRAE,
  TRAE_AGENT_HOST,
  TRAE_CONSOLE_HOST,
  TRAE_OAUTH_HOST,
  TRAE_UG_HOST,
} from '../../src/trae-product.js'

describe('TRAE 产品配置', () => {
  it('基础字段与实测值一致', () => {
    expect(TRAE).toMatchObject({
      id: 'trae',
      displayName: 'TRAE (字节)',
      defaultCredentialRef: 'TRAE_ACCESS_TOKEN',
      function: 'solo_work_lite',
    })
  })

  it('四个 host 与 trae2api/internal/upstream/constants.go 一致', () => {
    // 这些是不同区域的独立服务，混用会让请求打到错误的端点。
    expect(TRAE.agentHost).toBe('https://trae-api-cn.mchost.guru')
    expect(TRAE.ugHost).toBe('https://api.trae.cn')
    expect(TRAE.oauthHost).toBe('https://api.trae.com.cn')
    expect(TRAE.consoleHost).toBe('https://www.trae.cn')
  })

  it('导出的 host 常量与配置字段一致', () => {
    expect(TRAE_AGENT_HOST).toBe(TRAE.agentHost)
    expect(TRAE_UG_HOST).toBe(TRAE.ugHost)
    expect(TRAE_OAUTH_HOST).toBe(TRAE.oauthHost)
    expect(TRAE_CONSOLE_HOST).toBe(TRAE.consoleHost)
  })

  it('agent / ug / oauth 是三个**不同**的域名（这是关键配置差异）', () => {
    // 腾讯系登录与 API 共用一个 endpoint；TRAE 则是三套独立服务。
    const hosts = new Set([
      new URL(TRAE.agentHost).hostname,
      new URL(TRAE.ugHost).hostname,
      new URL(TRAE.oauthHost).hostname,
    ])
    expect(hosts.size).toBe(3)
  })

  it('所有 host 都是 HTTPS 且无尾斜杠（拼接路径不能出现双斜杠）', () => {
    for (const host of [TRAE.agentHost, TRAE.ugHost, TRAE.oauthHost, TRAE.consoleHost]) {
      expect(host.startsWith('https://'), host).toBe(true)
      expect(host.endsWith('/'), host).toBe(false)
    }
  })

  it('客户端常量与实测一致', () => {
    expect(TRAE.clientId).toBe('en1oxy7wnw8j9n')
    expect(TRAE.appId).toBe('6eefa01c-1036-4c7e-9ca5-d891f63bfcd8')
    // 0.1.52 是实测可获取 glm-5.3 的最低版本；更低版本会报 4001 param is invalid。
    expect(TRAE.ideVersion).toBe('0.1.52')
    expect(TRAE.ideVersionCode).toBe('20260811')
    expect(TRAE.deviceBrand).toBe('Apple')
    expect(TRAE.osVersion).toBe('macOS 15.7.4')
  })

  it('pluginVersion 是登录门户的插件版本（≠ ideVersion）', () => {
    // 对齐 login.sh:54。两者是独立字段：前者用于登录 URL 的 plugin_version，
    // 后者是 chat 端点的模型准入版本。混用会让登录 URL 发错版本号。
    expect(TRAE.pluginVersion).toBe('2.3.62834')
    expect(TRAE.pluginVersion).not.toBe(TRAE.ideVersion)
  })

  it('UA 含真实 IDE 版本号', () => {
    expect(TRAE.userAgent).toBe(`Trae/${TRAE.ideVersion}`)
  })

  it('**不**含 CodeBuddy / LobsterAI 系专有字段', () => {
    // 三个 product 类型刻意平级而非继承：带上别的类型的字段会让调用方
    // 误以为可以互换使用。
    //
    // 注意 `pluginVersion` **不**在此列：`TraeProduct` 自己也有该字段
    // （登录 URL 的 plugin_version，对齐 login.sh:54），与 BuddyProduct 的
    // 同名同义但来源不同，是合法字段。
    for (const banned of [
      'apiDomain', 'productCode', 'attributionName', 'platform',
      'appendSessionParams', 'userAgentByModelFamily', 'cliVersion', 'endpoint',
      'portalBase', 'apiBase', 'clientVersionApi', 'fallbackClientVersion', 'clientCapabilities',
    ]) {
      expect(TRAE, banned).not.toHaveProperty(banned)
    }
  })
})

describe('TRAE 兜底模型目录', () => {
  it('含 32 个模型（对齐 Go 端 staticModels 数量）', () => {
    // handler.go:247-280 的 staticModels 共 32 条。
    expect(TRAE.fallbackModels).toHaveLength(32)
  })

  it('每个条目的 id / name / contextWindow 均完整有效', () => {
    for (const model of TRAE.fallbackModels) {
      expect(typeof model.id).toBe('string')
      expect(model.id.length).toBeGreaterThan(0)
      expect(typeof model.name).toBe('string')
      expect(model.name.length).toBeGreaterThan(0)
      expect(model.contextWindow).toBeGreaterThan(0)
    }
  })

  it('模型 id 唯一（重复会让选择器出现两个同名条目）', () => {
    const ids = TRAE.fallbackModels.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('覆盖逆向报告中列出的关键模型', () => {
    const ids = new Set(TRAE.fallbackModels.map((m) => m.id))
    for (const id of [
      'DeepSeek-V4-Flash-Official', 'Doubao-Seed-2.1-Pro', 'glm-5.2', 'glm-5',
      'DeepSeek-V4-Pro', 'DeepSeek-V4-Flash', 'kimi-k3', 'kimi-k2.6', 'minimax-m3',
    ]) {
      expect(ids.has(id), id).toBe(true)
    }
  })

  it('顺序照抄 Go 原表（保持与上游对比时的可比性）', () => {
    expect(TRAE.fallbackModels[0]!.id).toBe('DeepSeek-V4-Flash-Official')
    expect(TRAE.fallbackModels[6]!.id).toBe('glm-5.2')
    expect(TRAE.fallbackModels[31]!.id).toBe('summary')
  })

  it('contextWindow 为实测的 200000（旧的 131072 是估值，已被推翻）', () => {
    for (const model of TRAE.fallbackModels) {
      expect(model.contextWindow, model.id).toBe(200_000)
    }
  })

  it('标出已知的上游内部条目（远端不可用时也不该出现在目录里）', () => {
    const hidden = TRAE.fallbackModels.filter((model) => model.isHidden === true).map((model) => model.id)
    expect(hidden).toEqual([
      'browser_use_subagent',
      'explore_sub_agent_v13',
      'explore_sub_agent_v2',
      'summary',
    ])
  })

  it('channels 首位是 solo_agent（对齐截图 Auto Mode），含 work_lite 与 agent_remote', () => {
    expect(TRAE.channels.length).toBeGreaterThan(0)
    // solo_agent 现在排首位，对应截图 Auto Mode 模型列表
    expect(TRAE.channels[0]).toBe('solo_agent')
    // 仍然含 work_lite（既有模型的 channel 不变）与 agent_remote（专有模型）
    expect(TRAE.channels).toContain('solo_work_lite')
    expect(TRAE.channels).toContain('solo_agent_remote')
  })

  it('⚠️ channels 是**可调用通道白名单**，不得含实测被拒的三个通道（Issue IKJOZ7）', () => {
    // 逐通道实测（2026-10-04，scripts/probe-trae-channel-callable.mjs）：
    //   chat        → 4023 the model is unknown
    //   builder     → 4001 param is invalid
    //   inline_chat → 3003 model service is unavailable
    // 它们进了白名单就等于放行「能选中、一发必失败」的条目。
    for (const bad of ['chat', 'builder', 'inline_chat']) {
      expect(TRAE.channels, bad).not.toContain(bad)
    }
    // 目录恒空的通道放进来也无意义（避免有人"补全 22 个"）。
    for (const empty of ['ui_builder_v2', 'solo_builder', 'custom_agent_generation', 'utils']) {
      expect(TRAE.channels, empty).not.toContain(empty)
    }
  })

  it('⚠️ 实测可调用的通道必须都在白名单内（漏一个 = 独有模型从目录消失）', () => {
    // 反向保护：这 15 个是逐通道实发验证过 OK 的集合（`solo_coder` 首测超时、
    // 换 4 个模型复测全 OK，故计入）。少任何一条都意味着某个模型
    // （如 multimodal_image_kimi-k2.5 → multimodal；deepseek-V3 → git_ai）
    // 会因「非白名单」被剔除，而它本来是能用的。
    expect([...TRAE.channels].sort()).toEqual([
      'builder_v3',
      'chat_v3',
      'code_review_summary',
      'code_reviewer',
      'git_ai',
      'multimodal',
      'solo_agent',
      'solo_agent_lite',
      'solo_agent_remote',
      'solo_coder',
      'solo_design_lite',
      'solo_design_remote',
      'solo_work_lite',
      'solo_work_remote',
      'system_diagnosis',
    ])
  })

  it('产品级兜底输出上限取实测主流值 32000（不是旧的 128000）', () => {
    expect(TRAE.fallbackMaxOutputTokens).toBe(32_000)
  })
})
