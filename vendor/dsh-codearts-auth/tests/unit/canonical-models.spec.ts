import { describe, expect, it } from 'vitest'
import {
  EXCLUDED_ALIASES,
  canonicalDisplayName,
  canonicalKeyFor,
  channelOf,
  normalizeModelKey,
  normalizeNameKey,
} from '../../src/canonical-models.js'

describe('normalizeModelKey：命名空间与前缀', () => {
  it('剥 cline 的命名空间前缀，保留末段', () => {
    expect(normalizeModelKey('cline-free/deepseek-v4.1-flash')).toBe('deepseek-v4-1-flash')
    expect(normalizeModelKey('deepseek/deepseek-v4.1-flash')).toBe('deepseek-v4-1-flash')
    expect(normalizeModelKey('cline-pass/deepseek-v4.1-flash')).toBe('deepseek-v4-1-flash')
  })

  it('去 `:free` 后缀', () => {
    expect(normalizeModelKey('kimi-k2.6:free')).toBe('kimi-k2-6')
  })

  it('剥 raccoon 的 `sn-` 前缀', () => {
    expect(normalizeModelKey('sn-glm-5-3')).toBe('glm-5-3')
    expect(normalizeModelKey('sn-deepseek-v4-1-flash')).toBe('deepseek-v4-1-flash')
  })

  it('全小写', () => {
    expect(normalizeModelKey('MiniMax-M3')).toBe('minimax-m3')
    expect(normalizeModelKey('GLM-5.3')).toBe('glm-5-3')
  })
})

describe('normalizeModelKey：版本结构必须保留（T1 / T2 / T3）', () => {
  it('点号转连字符，但 `v4.1` 与 `v4` 不相等', () => {
    expect(normalizeModelKey('deepseek-v4.1-flash')).toBe('deepseek-v4-1-flash')
    expect(normalizeModelKey('deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(normalizeModelKey('deepseek-v4.1-flash'))
      .not.toBe(normalizeModelKey('deepseek-v4-flash'))
  })

  it('日期快照不并入无后缀版本（loomy 的 0731 是冻结快照）', () => {
    expect(normalizeModelKey('deepseek-v4-flash-0731')).toBe('deepseek-v4-flash-0731')
    expect(normalizeModelKey('deepseek-v4-flash-0731'))
      .not.toBe(normalizeModelKey('deepseek-v4-flash'))
  })

  it('workbuddy 的 `-sg` 与普通版不合并（展示名逐字相同也不行）', () => {
    expect(normalizeModelKey('deepseek-v4.1-flash')).toBe('deepseek-v4-1-flash')
    expect(normalizeModelKey('deepseek-v4.1-flash-sg')).toBe('deepseek-v4-1-flash-sg')
    expect(normalizeModelKey('deepseek-v4.1-flash'))
      .not.toBe(normalizeModelKey('deepseek-v4.1-flash-sg'))
    // ⚠️ 上面三条都只走 id 通道，**证明不了 workbuddy 声明的是哪条通道**
    // （若被误声明为 name，它们照样全绿）。必须直接断言通道本身。
    expect(channelOf('workbuddy')).toBe('id')
    // 对照断言：这两个 id 对应的模型**共享同一个展示名**（逐字都是
    // `Deepseek-V4.1-Flash`，`-sg` 区分不出来），故 name 通道无法区分二者 ——
    // 这正是 workbuddy 必须走 id 的原因。下面的 keyVia 是 Task 2 `canonicalKeyFor`
    // 的通道分派在本用例内的最小替身，只为把「走哪条通道」变成可执行事实：
    // 正确实现（id 通道）⇒ 两键不同；误写成 name 通道 ⇒ 两键相同而**变红**。
    const keyVia = (provider: string, id: string, displayName: string): string =>
      channelOf(provider) === 'id' ? normalizeModelKey(id) : normalizeNameKey(displayName)
    const SHARED_DISPLAY_NAME = 'Deepseek-V4.1-Flash'
    expect(keyVia('workbuddy', 'deepseek-v4.1-flash', SHARED_DISPLAY_NAME))
      .not.toBe(keyVia('workbuddy', 'deepseek-v4.1-flash-sg', SHARED_DISPLAY_NAME))
  })

  it('`-official` 后缀保守保留（不并入无后缀版本）', () => {
    expect(normalizeModelKey('DeepSeek-V4-Flash-Official')).toBe('deepseek-v4-flash-official')
    expect(normalizeModelKey('DeepSeek-V4-Flash-Official'))
      .not.toBe(normalizeModelKey('DeepSeek-V4-Flash'))
  })
})

describe('normalizeNameKey：先剥倍率后缀再归一（T9 / raccoon / loomy）', () => {
  it('剥 ` · x{n}` 倍率', () => {
    expect(normalizeNameKey('GLM-5-3 · x0.75')).toBe('glm-5-3')
    expect(normalizeNameKey('DeepSeek V4 Flash 0731 · x3.0')).toBe('deepseek-v4-flash-0731')
  })

  it('剥促销箭头形态，取整个后缀', () => {
    expect(normalizeNameKey('GLM-5-3-Flash · x0.2→x0.1')).toBe('glm-5-3-flash')
  })

  it('剥「免费」标注', () => {
    expect(normalizeNameKey('SenseNova-6.8-Flash · 免费')).toBe('sensenova-6-8-flash')
  })

  it('剥不带 `·` 的裸「免费」（独立于倍率剥离的那道闸门）', () => {
    // ⚠️ 上面那条走的是 `/\s*·.*$/`，`免费` 是被连在 ` · ` 里一起剥掉的，
    // `replace(/免费/g, '')` 根本没参与 —— 删掉它也照样绿。这条输入没有 `·`，
    // 专门锁住那条独立闸门：删掉它，本断言必红。
    expect(normalizeNameKey('SenseNova-6.8-Flash 免费')).toBe('sensenova-6-8-flash')
  })

  it('空格转连字符（buddy 系的 PascalCase 展示名）', () => {
    expect(normalizeNameKey('Deepseek-V4.1-Flash')).toBe('deepseek-v4-1-flash')
  })

  it('裸 id 形态的展示名与 id 通道结果一致', () => {
    expect(normalizeNameKey('deepseek-v4-flash')).toBe('deepseek-v4-flash')
  })
})

describe('主通道声明（T4：qoder 的 id 是内部代号）', () => {
  it('qoder / qodercn 走 name 通道，其余走 id 通道', () => {
    expect(channelOf('qoder')).toBe('name')
    expect(channelOf('qodercn')).toBe('name')
    expect(channelOf('buddy')).toBe('id')
    expect(channelOf('raccoon')).toBe('id')
    expect(channelOf('minimax')).toBe('id')
    expect(channelOf('lobsterai')).toBe('id')
    expect(channelOf('trae')).toBe('id')
    expect(channelOf('unknown-provider')).toBe('id')
  })

  it('说明性回归：qoder 的 id 通道确实无信息，name 通道才有', () => {
    // ⚠️ 这里原先有三条 `not.toBe` 不等式（`gfmodel` vs `gmodel` vs `dfmodel`）——
    // 它们是**近同义反复**（全分支终审 M1）：`normalizeModelKey` 只做小写 / 剥前缀 /
    // 点号转连字符，三个本就不同的 token 在**任何**合理实现下都不相等 ⇒ 断言恒真，
    // 证伪不了「qoder 走 id 也可行」。
    //
    // 改成**能区分两条通道**的对照：id 通道对这三个内部代号给出**三个互不相同的键**
    //（⇒ 跨渠道聚合完全不发生），而 name 通道能把它们**接到同一个真实模型键**上。
    // 判据是「两条通道的**结论不同**」，而不是「三个字符串不相等」。
    const idKeys = ['gfmodel', 'gmodel'].map((id) => normalizeModelKey(id))
    const nameKeys = ['GLM-5.3-Flash', 'GLM-5.3'].map((name) => normalizeNameKey(name))
    // id 通道：不同代号 ⇒ 不同键（这就是「走 id 通道则无法聚合」的证据）
    expect(new Set(idKeys).size).toBe(idKeys.length)
    // name 通道：真实展示名能归一（且与 id 通道的结论不同）
    expect(nameKeys[0]).toBe('glm-5-3-flash')
    expect(nameKeys[1]).toBe('glm-5-3')
    expect(nameKeys[0]).not.toBe(idKeys[0])
    // ⇒ 故 qoder 必须声明 name 通道（这一条才是判据本身）。
    expect(channelOf('qoder')).toBe('name')
    // 而 name 通道能把内部代号接回真实模型键（id 通道做不到这件事）。
    expect(normalizeNameKey('GLM-5.3-Flash')).toBe('glm-5-3-flash')
  })
})

describe('排除集（T11：抽象别名不是真实模型）', () => {
  it('workbuddy 的抽象路由别名在排除集里', () => {
    for (const id of ['default-model', 'fast-model', 'balanced-model', 'primary-model', 'deep-model']) {
      expect(EXCLUDED_ALIASES.has(id), `${id} 应在排除集`).toBe(true)
    }
  })

  it('qoder 的 auto 在排除集里（它是抽象模式，不是模型）', () => {
    expect(EXCLUDED_ALIASES.has('auto')).toBe(true)
  })

  it('真实模型不在排除集里', () => {
    expect(EXCLUDED_ALIASES.has('deepseek-v4.1-flash')).toBe(false)
    expect(EXCLUDED_ALIASES.has('glm-5.3')).toBe(false)
  })
})

describe('canonicalKeyFor：主通道 + 补丁', () => {
  it('id 通道（buddy）：直接用 id', () => {
    expect(canonicalKeyFor('buddy', 'deepseek-v4.1-flash', 'Deepseek-V4.1-Flash'))
      .toEqual({ key: 'deepseek-v4-1-flash', via: 'id' })
  })

  it('name 通道（qoder）：id 是代号时用展示名', () => {
    expect(canonicalKeyFor('qoder', 'gfmodel', 'GLM-5.3-Flash'))
      .toEqual({ key: 'glm-5-3-flash', via: 'name' })
    expect(canonicalKeyFor('qodercn', 'dfmodel', 'DeepSeek-Flash'))
      .toEqual({ key: 'deepseek-flash', via: 'name' })
  })

  it('raccoon：id 剥 `sn-` 后与展示名一致', () => {
    expect(canonicalKeyFor('raccoon', 'sn-glm-5-3', 'GLM-5-3 · x0.75'))
      .toEqual({ key: 'glm-5-3', via: 'id' })
  })

  it('补丁优先于两个通道（lobsterai 的远端专有 id）', () => {
    // lobsterai 的 deepseek-flash 是远端专有 id，展示名叫 DeepSeek-V4.1-Flash。
    // id 通道会给出 `deepseek-flash`（与 V4.1 Flash 无字面关系），故必须靠补丁。
    expect(canonicalKeyFor('lobsterai', 'deepseek-flash', 'DeepSeek-V4.1-Flash'))
      .toEqual({ key: 'deepseek-v4-1-flash', via: 'patch' })
  })

  it('补丁不覆盖未登记的 id（lobsterai 的旧模型仍走各自通道）', () => {
    const got = canonicalKeyFor('lobsterai', 'deepseek-v4-flash', 'deepseek-v4-flash')
    expect(got?.key).toBe('deepseek-v4-flash')
    expect(got?.via).toBe('id')
  })

  it('抽象别名返回 undefined（不归入任何虚拟模型）', () => {
    expect(canonicalKeyFor('workbuddy', 'default-model', 'Auto')).toBeUndefined()
    expect(canonicalKeyFor('qoder', 'auto', 'Auto')).toBeUndefined()
  })

  it('name 通道算出的键落在排除集里时也必须拒绝（防与 auto 撞名）', () => {
    // ⚠️ 真实风险：qoder 走 name 通道。若某条目的**展示名**归一成 `auto`
    // 而它的 id 不是 `auto`，只查 id 的实现会放行它 ⇒ 产出一个 key === 'auto'
    // 的虚拟模型 ⇒ 与 AGGREGATE_AUTO_MODEL 撞名 ⇒ DSH 的 listModels 因 id 重复
    // 抛 INVALID_CATALOG，**整个聚合目录不可用**。
    // 这条用「id 不是 auto、展示名是 Auto」构造，正好绕开 id 检查。
    expect(canonicalKeyFor('qoder', 'some-internal-key', 'Auto')).toBeUndefined()
    expect(canonicalKeyFor('qodercn', 'some-internal-key', 'Auto')).toBeUndefined()
    // 对照：同样的 id 配一个正常展示名 → 正常归入（证明拒绝的原因是展示名，不是 id）
    expect(canonicalKeyFor('qoder', 'some-internal-key', 'GLM-5.3')?.key).toBe('glm-5-3')
  })
})

describe('规范展示名', () => {
  it('已登记的键给出官方写法', () => {
    expect(canonicalDisplayName('deepseek-v4-1-flash')).toBe('DeepSeek V4.1 Flash')
    expect(canonicalDisplayName('glm-5-3-flash')).toBe('GLM-5.3-Flash')
    expect(canonicalDisplayName('kimi-k3')).toBe('Kimi-K3')
  })

  it('未登记的键回退为键本身（不编造展示名）', () => {
    expect(canonicalDisplayName('some-unknown-model')).toBe('some-unknown-model')
  })
})

describe('★ M9：原型链键不得被当成登记项（全分支终审）', () => {
  // ⚠️ `CANONICAL_NAMES` / `CANONICAL_OVERRIDES` 都是**普通对象字面量** ⇒ 沿原型链
  // 可命中 `constructor` / `toString` / `valueOf` / `hasOwnProperty` / `__proto__`。
  // 修前实测 `typeof canonicalDisplayName('constructor') === 'function'`
  // （返回的是 **`Object` 构造函数**，不是字符串）⇒ DSH 的 `listModels` 校验要求
  // `name` 是非空字符串 ⇒ 抛 `INVALID_CATALOG` ⇒ **整个聚合目录不可用**。
  // 可达性：模型 id 来自各渠道 listModels()，其中 cline 会透传远端 id，是唯一注入面。
  const PROTO_KEYS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', 'isPrototypeOf']

  it('canonicalDisplayName 对原型链键回退为键本身（返回字符串，不是函数）', () => {
    for (const key of PROTO_KEYS) {
      const name = canonicalDisplayName(key)
      expect(typeof name).toBe('string')
      expect(name).toBe(key)
    }
  })

  it('canonicalKeyFor 不会把原型链 provider 当成有补丁（**可达路径**）', () => {
    // ⚠️⚠️ 本条最初写成 `provider='buddy'`，实测是**同义反复**（任何实现都过）：
    //    补丁表里根本没有 `buddy` 这个键 ⇒ `CANONICAL_OVERRIDES['buddy']` 是
    //    `undefined` ⇒ `?.[realId]` 直接短路，原型链根本没被走到。
    //    反向验证（把 `Object.hasOwn` 去掉）时它**没变红**，才发现这一点。
    //
    // 真正可达的形态（实测）：`provider = 'constructor'` ⇒
    // `CANONICAL_OVERRIDES['constructor']` 沿原型链返回 **`Object` 构造函数**，
    // 而它**有自有属性** `name`（字符串 `'Object'`）与 `length`（数字 `1`）⇒
    // **修前**的代码会把 `'Object'` 当成补丁结果返回（`via: 'patch'`）——
    // 一个凭空出现的规范键，且它**不在任何渠道目录里**。
    const viaName = canonicalKeyFor('constructor', 'name', 'name')
    expect(viaName?.via).not.toBe('patch')

    // `length` 更极端：修前会把**数字 1** 当成 key（`typeof !== 'string'`）⇒
    // DSH 的 listModels 校验会抛 INVALID_CATALOG ⇒ 整个聚合目录不可用。
    const viaLength = canonicalKeyFor('constructor', 'length', 'length')
    if (viaLength !== undefined) {
      expect(typeof viaLength.key).toBe('string')
      expect(viaLength.via).not.toBe('patch')
    }
  })
})
