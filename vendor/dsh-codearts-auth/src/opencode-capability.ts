/**
 * OpenCode Zen 模型能力元数据（**读共享缓存**，不再自己直连）。
 *
 * ## 数据源：models.dev 的 `opencode` 条目，**经共享本地缓存**
 *
 * `/zen/v1/models` **只返回 4 个字段**（`id` / `object` / `created` /
 * `owned_by`，实测 85 条全如此），**不含任何能力信息**。能力在 models.dev
 * （`https://models.dev/api.json` 的 `opencode` 键，实测 127 个模型），官方
 * CLI 自己就用它（`packages/core/src/models-dev.ts`）。
 *
 * | 字段 | 用途 |
 * |---|---|
 * | `modalities.input` | 能力主源：`['text']` / `['text','image']` … |
 * | `cost.input` / `cost.output` | **免费判定的权威来源**（0 = 免费） |
 * | `limit.context` / `limit.output` | 上下文窗口与输出上限 |
 * | `reasoning_options` | 思考档位（见 {@link OpencodeModelCapability.efforts}） |
 * | **`provider.api`** | **协议可达性**（见下方「为什么必须采它」） |
 *
 * ## ⚠️⚠️ 读取路径：只读共享缓存，**永不**自己 fetch（用户 2026-10-17）
 *
 * 本模块改前**自己** `fetch('https://models.dev/api.json')`，并维护独立的
 * TTL / 在飞去重 / 磁盘缓存（与 `cline-models-dev.ts` 各一套，那是本仓库
 * 明令禁止的「一文件两套同义判据」形态）。那份数据**解压后 ~5 MB**、实测
 * 「要么 ~2 秒、要么整段挂死」，而本仓库已有一次真机事故：渲染路径上 await
 * 这个拉取 ⇒ **模型选择器一直空白**（2026-10-02）。
 *
 * ⇒ 现在一切取数都走 `src/models-dev-cache.ts`：**本模块不再持有 URL，
 * 也不发起任何请求**；`readProviderModelsSync()` 只做 `readFileSync`。
 * 「全仓唯一直读点」由 `tests/unit/models-dev-cache.spec.ts` 的扫描用例守住。
 *
 * ## ⚠️ 为什么必须采 `provider.api`（Issue IKM9LR 的根因）
 *
 * 改前 `opencode-product.ts` 的 `OPENCODE_FALLBACK_MODELS` 兜底表**同时**当
 * 「网络失败的兜底目录」与「协议可达性白名单」两个职责，而后者是硬编码的
 * ⇒ Zen 新上线的模型（issue 里的 `deepseek-v4.1-flash-free` /
 * `glm-5.3-flash-free`）**远端 `/v1/models` 明明下发了，却被本地表挡掉**，
 * 用户在选择器里根本看不到（症状与「上游没这模型」完全同形）。
 *
 * models.dev 的 `provider.api` 正是**协议端点**的权威字段。实测按它分组与
 * 「我们实现了哪些协议」逐格吻合（`openai/v1` 56 条 / `anthropic/v1` 17 条 /
 * `google/v1beta` 8 条 / 无条目 4 条），且改前的 14 条兜底表条目**全部**落在
 * `openai/v1` 内、零反例。
 *
 * ⚠️ 它**不能**替代的三样（目录层无从预知，只能靠运行时错误分类兜）：
 * ① 地域封锁（`beam-free` 的 api 就是 openai/v1，实测 403 RegionError）；
 * ② 上游不稳定（`glm-5.3-flash-free` 约 2/5 概率 429）；
 * ③ 废弃（`mimo-v2.5-free` 回 410，但只要远端还下发，目录层就挡不住）。
 */

import {
  clearModelsDevCache,
  readProviderModelsSync,
  refreshModelsDev,
} from './models-dev-cache.js'
import {
  OPENCODE_CHAT_PROTOCOL_API,
  setOpencodeCapabilityHook,
  setRemoteOpencodeFreeFlags,
  setRemoteOpencodeReachability,
} from './opencode-product.js'

// ⚠️⚠️ **模块加载期**注册「读能力表」钩子（独立审计 P1 的根治）。
//
// `opencode-product.ts` 的两个判据（`isFreeOpencodeModel` /
// `isReachableOpencodeModel`）在表为 `undefined` 时会回调它，就地完成注入 ——
// 于是判据**自给自足**，不再依赖「每个调用点都先读一次能力表」这种跨文件的
// 隐式顺序约定。
//
// ⚠️ **必须是模块加载期**（不是首次归一后）：冷启动首帧能力表还没被任何
//   路径读过，若那时钩子未注册，判据就会退回本地表。
//
// ⚠️ 回调里**不缓存**结果：`readNormalized()` 自身按共享缓存的 provider 块
//   身份记忆化，重复调用极廉价，而缓存一份反而会在后台刷新后读到旧值。
setOpencodeCapabilityHook(() => { readNormalized() })

/** 归一后的模型能力条目。 */
export interface OpencodeModelCapability {
  id: string
  name: string
  /** 输入模态（已归一到 DSH 支持的 text/image；video/audio/pdf 一律降级为 text）。 */
  modalities: readonly ('text' | 'image')[]
  /** 上下文窗口（0 = 未知，不编造）。 */
  contextWindow: number
  /**
   * 模型单次输出上限（0 = 未知）。
   *
   * ⚠️ **刻意不下发给 DSH 的 `defaultMaxTokens`**（issue IKJJ68）。
   * 它是**上限**而非「合理的默认输出预算」：DSH 会在用户未指定 `max_tokens` 时
   * 直接拿它填请求，于是每轮都按上限走 —— 而 `space-bunny-free` 的上限是
   * **524288**、`nemotron-3-ultra-free` 是 128000，作为「默认」明显荒谬。
   *
   * ⚠️ 实测 2026-10-02 澄清了两件事（别再凭猜写这里的注释）：
   *   ① 给到这些值**不会被服务端拒绝**（big-pickle 32000 / nemotron 128000 /
   *      space-bunny 524288 全部 200）—— 「免费通道会拒」的说法**不成立**；
   *   ② **不给** `max_tokens` 时服务端用自己的默认值，实测 667 tokens 且
   *      `finish=stop`（自然结束，非截断）—— 现有「不下发」的行为就是好的。
   * 采下来是为了**留档**，以及将来按渠道实测出安全默认值。
   */
  maxOutputTokens: number
  /** 是否支持思考推理（**仅表示「支持」**；档位见 {@link efforts}）。 */
  reasoning: boolean
  /**
   * 思考档位 id（**原序**来自 models.dev 的 `reasoning_options`）。
   *
   * ⚠️ **空数组 = 不声明 `reasoning`**（选择器不出现），而不是「支持但无档位」。
   * 依据是 DSH 的渲染逻辑（`dsh-api-session-controller/lib/types/catalog.js`）：
   * `resolved.reasoning === undefined ? undefined : { efforts: … }` ——
   * 声明了空数组会让 UI 出现一个**没有任何档位**的空选择器。
   * （issue IKJJ0V）
   */
  efforts: readonly string[]
  /** 是否支持工具调用。 */
  toolCall: boolean
  /**
   * 是否**免费**（`cost.input` 与 `cost.output` 同时为 0）。
   *
   * ⚠️ 这是免费判定的**权威来源**（Zen 匿名通道按此放行），
   * 不依赖本地硬编码表 —— 后者会在上游调整定价后静默失准。
   */
  isFree: boolean
  /**
   * ⚠️ **协议可达性**（issue IKM9LR）：该模型是否走本插件实现的
   * OpenAI-chat 协议（`provider.api` 指向 {@link OPENCODE_CHAT_PROTOCOL_API}）。
   *
   * `undefined` = **不知道**（条目缺 `provider.api`，实测 `jev-1.13-free`
   * 连 models.dev 条目都没有）⇒ 调用方**不得**据此判不可达 ——
   * 那是本仓库反复踩过的「把没读到说成不支持」。
   */
  chatProtocol: boolean | undefined
}

/**
 * 实测校准表：**只**覆盖与 models.dev 不一致的视觉能力。
 *
 * ## 范围（用户定调 2026-10-02：只验证免费模型）
 *
 * 校准**只针对免费模型**。付费模型走账号通道，能力以远端 models.dev 为准即可，
 * 不做逐个实测 —— 那需要真实付费调用，且余额/价格变动时结论也易过期。
 */
const MEASURED_IMAGE_OVERRIDES: Record<string, { image: boolean; note: string }> = {
  // 实测 2026-10-02：models.dev 标 `modalities.input: ["text"]`，
  // 但 1×1 PNG 的多模态请求真实返回 200（big-pickle 是最常用的免费模型）。
  'big-pickle': { image: true, note: '2026-10-02 实测 200，models.dev 漏报 image' },
  // 实测 2026-10-02：models.dev 标支持 image，但带图请求真实 500
  // （"Upstream request failed: Endpoint is unsupported"）。
  'longcat-2.5-preview-free': { image: false, note: '2026-10-02 实测 500，models.dev 多报 image' },
}

/** models.dev 原始条目（只声明用到的字段；`provider.api` 用于协议可达性）。 */
interface RawModelDevEntry {
  id?: unknown
  name?: unknown
  modalities?: { input?: unknown }
  limit?: { context?: unknown; output?: unknown }
  cost?: { input?: unknown; output?: unknown }
  reasoning?: unknown
  /**
   * 思考档位声明（issue IKJJ0V）。
   *
   * 实测 2026-10-02：opencode 的模型里 **88/115** 个带此字段，形态有四种：
   * | 形态 | 实例 |
   * |---|---|
   * | 多档 | `{"type":"effort","values":["minimal","low","medium","high","xhigh"]}` |
   * | 自定义档 | `{"type":"effort","values":["low","high","max"]}` |
   * | 单档 | `{"type":"effort","values":["max"]}` |
   * | 仅开关 | `{"type":"toggle"}` |
   * | 预算制 | `{"type":"budget_tokens","max":81920}` |
   */
  reasoning_options?: unknown
  tool_call?: unknown
  /** 协议端点（issue IKM9LR）：判「本插件实现了它的协议吗」的权威字段。 */
  provider?: { api?: unknown }
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * 档位 id → 官方中文展示名。
 *
 * ⚠️ 沿用 Qoder 那份**官方 i18n**（`settings.efforts`，见 AGENTS.md §2.2），
 * 因为 DSH 客户端**直接渲染** `efforts[].name`（不本地化、不查字典），
 * 给英文就显示英文。
 * ⚠️ `minimal` / `xhigh` 在那份表里没有 —— models.dev 确实会下发这两个值，
 * 遇到时回退到 id 本身（**不猜中文**）：宁可显示 `minimal` 也不编一个错译。
 */
const EFFORT_NAMES: Record<string, string> = {
  none: '关闭思考',
  minimal: '最小',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
}

/**
 * 档位 id → 展示名（**无官方中文时回退到 id 本身**，不猜译名）。
 *
 * 导出给适配器用：`resolveModel()` 要给 `efforts[].name` 填中文，
 * 而客户端**直接渲染**该字段。
 */
export function opencodeEffortName(id: string): string {
  return EFFORT_NAMES[id] ?? id
}

/**
 * 从 `reasoning_options` 提取思考档位。
 *
 * ## 三种形态的处置（issue IKJJ0V）
 *
 * - `type:'effort'` + `values` → **原序**产出，值就是上游认的 id。
 * - `type:'toggle'`（只能开/关）→ 产出 `['none', 'low']` 两档：
 *   `none`=关闭思考、`low`=开启（最低档即「开」）。这是与 Qoder 的
 *   `supportsDisable` 独立维度等价的表达 —— 在本形态里「关」就是全部语义。
 * - `type:'budget_tokens'`（预算制）→ **不声明**。DSH 的 `reasoning.efforts`
 *   表达不了预算，编一档等于谎报能力。
 *
 * @returns 档位 id 数组；为空表示**不声明** `reasoning`（UI 不出现）。
 */
function normalizeEfforts(entry: RawModelDevEntry): readonly string[] {
  if (!Array.isArray(entry.reasoning_options)) return []
  const out: string[] = []
  for (const raw of entry.reasoning_options) {
    if (typeof raw !== 'object' || raw === null) continue
    const option = raw as { type?: unknown; values?: unknown }
    if (option.type === 'effort' && Array.isArray(option.values)) {
      for (const v of option.values) {
        if (typeof v === 'string' && v.length > 0 && !out.includes(v)) out.push(v)
      }
    } else if (option.type === 'toggle' && !out.includes('none')) {
      out.push('none', 'low')
    }
    // `budget_tokens` 刻意不处理（见上方说明）
  }
  return out
}

/** 把 models.dev 的一个条目归一；不合法时返回 null。 */
function normalizeEntry(id: string, raw: unknown): OpencodeModelCapability | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as RawModelDevEntry
  const declared = Array.isArray(entry.modalities?.input)
    ? entry.modalities.input.filter((m): m is string => typeof m === 'string')
    : []
  // ⚠️ **video / audio / pdf 一律降级为 text**：DSH 的 `inputModalities` 只认
  // 这两个值，声明不存在的模态会让 DSH 投影出我们并不发送的内容。
  let modalities: ('text' | 'image')[] = ['text']
  if (declared.includes('image')) modalities = ['text', 'image']
  const override = MEASURED_IMAGE_OVERRIDES[id]
  if (override !== undefined) modalities = override.image ? ['text', 'image'] : ['text']
  const efforts = normalizeEfforts(entry)
  return {
    id,
    name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
    modalities,
    contextWindow: isFiniteNumber(entry.limit?.context) ? entry.limit!.context as number : 0,
    maxOutputTokens: isFiniteNumber(entry.limit?.output) ? entry.limit!.output as number : 0,
    // ⚠️ `reasoning` 与 `efforts` 必须一致：只有真拿到档位才报「支持思考」。
    // `reasoning: true` 但 `efforts: []` 会声明一个空选择器（UI 出现但无内容）。
    reasoning: entry.reasoning === true && efforts.length > 0,
    efforts,
    toolCall: entry.tool_call !== false,
    isFree: isFiniteNumber(entry.cost?.input) && entry.cost!.input === 0
      && isFiniteNumber(entry.cost?.output) && entry.cost!.output === 0,
    // ⚠️⚠️ 协议可达性（issue IKM9LR）。**缺字段 = 不知道**，不是「不可达」：
    //   实测 `jev-1.13-free` 连 models.dev 条目都没有，而 `claude-*` / `gemini-*`
    //   的 `api` 指向本插件**未实现**的协议（实测 `/v1/messages` 恒 500）。
    chatProtocol: typeof entry.provider?.api === 'string'
      ? entry.provider.api === OPENCODE_CHAT_PROTOCOL_API
      : undefined,
  }
}


/**
 * 内存里归一好的能力表（**派生自共享缓存**，不单独持有 I/O 状态）。
 *
 * ⚠️ 归一结果按「共享缓存的版本」记忆化：缓存没变就不重算（归一 127 条
 * 虽然便宜，但每次 `listModels` 都重算一遍是纯浪费），变了就整体作废。
 */
let normalized: readonly OpencodeModelCapability[] = []

/** 归一结果对应的缓存指纹（provider 块的对象身份变化即作废）。 */
let normalizedFrom: unknown = undefined

/**
 * 从共享缓存同步读出**归一后**的能力表。
 *
 * ⚠️ 全程**同步**、零 I/O 之外的等待：共享缓存内部只做一次 `readFileSync`
 * （见 `models-dev-cache.ts` 的 `loadDiskCacheSync`）。
 */
function readNormalized(): readonly OpencodeModelCapability[] {
  const block = readProviderModelsSync('opencode')
  if (normalizedFrom === block) return normalized
  const out: OpencodeModelCapability[] = []
  for (const [id, raw] of Object.entries(block)) {
    const entry = normalizeEntry(id, raw as unknown)
    if (entry !== null) out.push(entry)
  }
  normalized = out
  normalizedFrom = block
  publishRemoteTables(out)
  return out
}

/**
 * 把归一结果里的**协议可达性**与**免费判定**回灌给 `opencode-product.ts`。
 *
 * ## ⚠️ 为什么必须在这里做（而不是让 product 反向依赖本模块）
 *
 * `isReachableOpencodeModel` / `isFreeOpencodeModel` 在 `opencode-adapter.ts`
 * 的热路径上被逐条调用，而那两个函数住在 `opencode-product.ts`（一个**不该
 * 依赖能力表**的纯常量模块 —— 那会形成 `product ← capability` 的反向依赖）。
 * ⇒ 由本模块归一完之后**主动注入**，product 侧只留两个 setter。
 *
 * ⚠️ **三态必须原样传递**：`chatProtocol` 为 `undefined`（不知道）时
 * **不放进 map** —— map 的 `has` 语义是「有权威结论」，缺键即「不知道，
 * 退回本地表」。直接把 `undefined` 塞成 `false` 会让所有无条目模型被判死。
 */
function publishRemoteTables(entries: readonly OpencodeModelCapability[]): void {
  const reachability = new Map<string, boolean>()
  const freeFlags = new Map<string, boolean>()
  for (const entry of entries) {
    if (entry.chatProtocol !== undefined) reachability.set(entry.id, entry.chatProtocol)
    // ⚠️ 免费判定的权威来源是 `cost`（实测 `isFree` 已按 `cost.input===0 &&
    // cost.output===0` 算好），与协议无关 ⇒ **无条件**发布。
    freeFlags.set(entry.id, entry.isFree)
  }
  setRemoteOpencodeReachability(reachability)
  setRemoteOpencodeFreeFlags(freeFlags)
}

/**
 * **同步**读当前已知的能力表（渲染路径唯一入口）。
 *
 * ⚠️ 刻意**不是** async：调用方在渲染路径上（listModels / resolveModel），
 * await 网络会卡住模型选择器（真机事故 2026-10-02）。
 *
 * ⚠️⚠️ 冷启动首次调用会**同步**读共享缓存文件（`readFileSync`）—— 不是网络 IO，
 * 代价可忽略，却能保证 `resolveModel` 第一次被调用就拿到完整能力表。
 * 少了这一步，内核的 `prompt` 准入校验会读到 `inputModalities: ['text']`
 * 而拒绝图片（2026-10-02 的事故，见 `models-dev-cache.ts` 的同款记录）。
 */
export function getOpencodeCapabilitiesSync(): readonly OpencodeModelCapability[] {
  return readNormalized()
}

/**
 * 作废归一缓存（外部刷新了共享缓存时调用）。
 *
 * ⚠️ **必须真的作废**：归一是按「共享缓存里 provider 块的对象身份」记忆化的，
 * 而成功刷新会**整体换掉**那块对象 —— 所以正常路径靠身份变化自动失效。
 * 但显式作废是**第二道防线**：万一将来缓存改成增量更新（复用同一个对象），
 * 身份判据就会静默失效，症状是「改了没用，重启才好」。
 */
export function invalidateOpencodeCapabilities(): void {
  normalizedFrom = undefined
}

/**
 * 启动期预热（**保持旧签名**以免改动接线层语义）。
 *
 * ⚠️ 现在它**只**触发共享缓存的后台刷新，自身不再读任何文件
 * —— 同步读已在 `readNormalized()` 里做掉了。多一条 async 读链只会让
 * 「是否读到缓存」出现两个判据（本仓库红线：同一语义两套判据）。
 */
export function primeOpencodeCapabilities(): void {
  refreshModelsDev()
}

/**
 * 后台刷新能力表（**保持旧签名**以免改动接线层语义）。
 *
 * ⚠️ 实际动作发生在共享缓存里；本函数只把 `onUpdated` 转交给它。
 * 保留这一层是因为**广播时机**是本渠道的事（能力表一变就要让客户端重读目录），
 * 而拉取细节已不该由本模块掌握。
 */
export function refreshOpencodeCapabilities(
  onUpdated?: () => void,
  force = false,
  warn?: (message: string) => void,
): void {
  refreshModelsDev(onUpdated, {
    force,
    ...warn === undefined ? {} : { warn },
    onUpdated: invalidateOpencodeCapabilities,
  })
}

/** 清空内存与磁盘缓存（单测用）。 */
export async function clearOpencodeCapabilitiesCache(): Promise<void> {
  normalized = []
  normalizedFrom = undefined
  await clearModelsDevCache()
}

/** 某模型是否接受图片输入（未知模型按纯文本处理）。 */
export function supportsOpencodeImage(capability: OpencodeModelCapability | undefined): boolean {
  return capability?.modalities.includes('image') === true
}

/**
 * ⚠️ 该模型是否走**本插件实现的** chat 协议（issue IKM9LR）。
 *
 * ## 判据口径（三格，缺一不可）
 *
 * | 能力表 | 结论 |
 * |---|---|
 * | `chatProtocol === true` | **可达** |
 * | `chatProtocol === false` | **不可达**（`provider.api` 指向 anthropic/google 等未实现的协议） |
 * | **条目不存在**（`undefined`） | **不知道** ⇒ 交给调用方按本地兜底表决定 |
 *
 * ⚠️ 第三格是刻意的：`jev-1.13-free` 连 models.dev 条目都没有，而实测它回
 * `400 ModelProtocolUnsupported` —— 但「这条实测结论」只属于**那个模型**，
 * 不能推广成「无条目的都不可达」。判成不可达会让未来新上线的模型凭空消失。
 */
export function isOpencodeChatReachable(id: string): boolean | undefined {
  return readNormalized().find((c) => c.id === id)?.chatProtocol
}
