/**
 * ModelScope 兜底表的**上下文窗口**守卫（2026-10-17）。
 *
 * ## 为什么需要它
 *
 * 魔搭的 `/v1/models` **只下发 4 个字段**（实测 `id` / `object` / `owned_by` /
 * `created`）—— **没有 `context_window`** ⇒ 远端目录解析出的
 * `contextWindow` 恒为 0（0 是「不知道」哨兵，`resolveModel` 判 `> 0` 才下发
 * `context`，否则 DSH 的自动压缩阈值算不出来）。
 *
 * ⇒ 兜底表是**唯一**的窗口来源。它一旦与远端目录漂移，用户就会看到
 * 「模型存在但没有窗口信息」，且**无任何报错**。
 *
 * ## 本文件锁的三条不变式
 *
 * ① 兜底表**不得有 `contextWindow === 0`** —— 那等于没登记；
 * ② `supportsImage: true` 的条目**必须有实测出处**（逐条点名，防「顺手写成 true」）；
 * ③ 思考档位**只能声明真机确证过的** —— 本轮实测结论是「只有 `none` 有效，
 *    `medium`/`high` 被静默忽略」，故表里**只允许** `['none']`。
 */

import { describe, expect, it } from 'vitest'
import { MODELSCOPE_FALLBACK_MODELS } from '../../src/modelscope-product.js'

describe('ModelScope 兜底表：上下文窗口（2026-10-17 扩表）', () => {
  it('★ 没有任何条目把 contextWindow 留成 0（0 = 「不知道」，DSH 算不出压缩阈值）', () => {
    const zero = MODELSCOPE_FALLBACK_MODELS
      .filter((m) => !(typeof m.contextWindow === 'number' && m.contextWindow > 0))
      .map((m) => m.id)
    expect(zero, '这些模型没有窗口信息 ⇒ DSH 不会下发 context ⇒ 自动压缩阈值算不出来')
      .toEqual([])
  })

  it('★ 窗口值只能是仓库已实测的两种（或用户指定的保守占位）', () => {
    // ⚠️ 这不是「白名单」而是「已知取值集合」：新增取值时必须同时更新本断言并
    //    在兜底表里写明出处（本仓库纪律：注释里的数字必须与实测一致）。
    const ALLOWED = new Set([1_048_576, 1_000_000, 512_000])
    const bad = MODELSCOPE_FALLBACK_MODELS
      .filter((m) => !ALLOWED.has(m.contextWindow))
      .map((m) => `${m.id}=${m.contextWindow}`)
    expect(bad, '出现未登记的窗口值 ⇒ 必须写明它是实测值还是占位值').toEqual([])
  })

  it('★ 兜底表的 id 集合与远端实测的 36 个一致（漂移即红，点名差集）', () => {
    // ⚠️ 远端清单是 2026-07-14 / 2026-10-17 两次实测的快照（36 个）。
    //    ⚠️ **刻意写成字面量**而不是调用网络：本用例必须能在离线 CI 跑，
    //    且真源是「兜底表」——远端变化应由「重跑实测并更新本清单」来对齐，
    //    而不是让用例去联网（那会让它随上游抖动而红，且红得没有行动指引）。
    const REMOTE_SNAPSHOT = [
      'deepseek-ai/DeepSeek-V4-Flash-0731', 'deepseek-ai/DeepSeek-V4-Pro',
      'deepseek-ai/DeepSeek-V4-Pro-0813', 'deepseek-ai/DeepSeek-V4.1-Flash',
      'early-access/EA-29B-A4B', 'MedAIBase/AntAngelMed',
      'meituan-longcat/LongCat-Flash-Lite', 'MiniMax/MiniMax-M1-80k', 'MiniMax/MiniMax-M3',
      'mistralai/Mistral-Large-Instruct-2407', 'MusePublic/Qwen-Image-Edit',
      'nex-agi/Nex-N2.5-mini', 'nex-agi/Nex-N2.5-Pro',
      'opencompass/CompassJudger-1-32B-Instruct', 'OpenGVLab/InternVL3_5-241B-A28B',
      'PaddlePaddle/ERNIE-4.5-0.3B-PT', 'PaddlePaddle/ERNIE-4.5-21B-A3B-PT',
      'PaddlePaddle/ERNIE-4.5-300B-A47B-PT', 'PaddlePaddle/ERNIE-4.5-VL-28B-A3B-PT',
      'Qwen/Qwen-Image-Edit', 'Qwen/Qwen3.5-122B-A10B', 'Qwen/Qwen3.5-27B',
      'Qwen/Qwen3.5-35B-A3B', 'Qwen/Qwen3.5-397B-A17B', 'Qwen/Qwen3.8-27B',
      'Qwen/Qwen3.8-Flash-Next', 'Shanghai_AI_Laboratory/Intern-S1',
      'Shanghai_AI_Laboratory/Intern-S1-mini', 'Shanghai_AI_Laboratory/Intern-S2-Preview',
      'stepfun-ai/Step-3.5-Flash', 'stepfun-ai/Step-3.7-Flash',
      'XGenerationLab/XiYanSQL-QwenCoder-32B-2412', 'XGenerationLab/XiYanSQL-QwenCoder-32B-2504',
      'ZhipuAI/GLM-4.7-Flash', 'ZhipuAI/GLM-5.2', 'ACE-Step/acestep-v15-xl-sft',
    ]
    const table = MODELSCOPE_FALLBACK_MODELS.map((m) => m.id).sort()
    const snapshot = [...REMOTE_SNAPSHOT].sort()
    const missing = snapshot.filter((id) => !table.includes(id))
    const extra = table.filter((id) => !snapshot.includes(id))
    expect({ missing, extra },
      `兜底表与远端快照漂移：missing = 远端有而表里没有；extra = 表里有而远端没有`)
      .toEqual({ missing: [], extra: [] })
  })
})

describe('ModelScope 兜底表：能力声明的诚实性', () => {
  it('★ supportsImage:true 只允许出现在有实测出处的条目上', () => {
    // ⚠️ 仓库硬约定：「声明支持就必须真支持」。accio 那轮实测：漏报 false 会让
    //    模型对图片**幻觉出答案**（HTTP 200、不报错）⇒ 比报错危险得多。
    // ⚠️ 本仓当前**只有一条**实测出处：2026-10-17 复测 32×32 纯红 PNG →
    //    模型答 `Red`（读图确实生效）。
    //    ⚠️ InternVL3_5 虽以视觉著称，但**魔搭侧未实测** ⇒ 兜底表里刻意记
    //    `false`（宁可少声明，不可让模型对图片幻觉出答案）。实测通过后两处同改。
    const ALLOWED_IMAGE = ['deepseek-ai/DeepSeek-V4.1-Flash']
    const claimed = MODELSCOPE_FALLBACK_MODELS
      .filter((m) => m.supportsImage === true)
      .map((m) => m.id)
      .sort()
    const unauthorized = claimed.filter((id) => !ALLOWED_IMAGE.includes(id))
    expect(unauthorized, '这些条目声明支持图片但没有实测出处 ⇒ 会让模型对图片幻觉出答案')
      .toEqual([])
    // 反向自检：白名单里的那一条**必须真的**声明了 true，否则本用例恒真。
    for (const id of ALLOWED_IMAGE) {
      expect(claimed, `${id} 在实测白名单里，但兜底表没声明 supportsImage:true —— 两者表漂移`)
        .toContain(id)
    }
  })

  it('★ 思考档位只允许确证过的「关闭思考」（medium/high 实测被静默忽略）', () => {
    // ⚠️⚠️ 本轮真机三档对照（每档 3 次，取 reasoning 字符数中位数）：
    //    `none` → 0/0/0（稳定为 0）；`medium` → 1462；`high` → 1734；
    //    而「**不指定**」→ **1676**，**比 high 还多** ⇒ medium/high 被静默忽略。
    //    ⇒ 只声明确证的一档。给出手感档位会让用户以为能控思考量（仓库
    //    providers-accio.md §7 记录过「档位看似可选、实则无效」的教训）。
    const withEfforts = MODELSCOPE_FALLBACK_MODELS.filter((m) => m.efforts !== undefined)
    for (const m of withEfforts) {
      expect([...m.efforts!], `${m.id} 声明了未经确证的思考档位`)
        .toEqual(['none'])
    }
    // 反向自检：至少要有一条声明了（否则上面是恒真）。
    expect(withEfforts.length, '兜底表没有任何条目声明档位 ⇒ 本用例的循环恒真、失去意义')
      .toBeGreaterThan(0)
  })
})