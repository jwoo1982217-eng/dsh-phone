/**
 * 第三方账号列表 → 本插件备份载荷的**转换器**（纯函数，无 React / 无 Web Crypto）。
 *
 * ## 为什么需要它
 *
 * 用户手上常见的不是本插件导出的备份，而是**别的工具**（账号池 / 卡号池脚本、
 * IDE 本地缓存导出）产生的 CodeBuddy 账号列表。两者结构完全不同：
 *
 * | | 第三方账号列表 | 本插件备份 |
 * |---|---|---|
 * | 顶层 | **裸数组** `[ {...}, ... ]` | 对象 `{ format, version, ... }` |
 * | 格式标记 | 无 | `format: 'dsh-codearts-auth/backup'` |
 * | 凭据 | 账号对象里**直接带** `access_token` / `refresh_token` | 独立 `credentials` 字典（ref → 凭据 JSON **原文字符串**） |
 * | 账号索引 | `id` 是 uid 或工具自己的编号 | `accounts[]`，`id` 形如 `buddy-a1b2c3d4` |
 *
 * 直接把它丢给「恢复」只会得到「该备份文件里没有账号」—— 因为 `accounts` 取不到。
 * 本模块负责把前者翻译成后者。
 *
 * ## 转换后的凭据必须与**真实登录产物**同构
 *
 * 这是本模块最容易出错的地方，故逐字段以「本机一个真实可用的 CodeBuddy 凭据」
 * 为基准对齐（字段名与取值规则均已实测核对）：
 *
 * | 字段 | 来源 | 说明 |
 * |---|---|---|
 * | `access_token` / `refresh_token` | 原样 | 必须原样搬运，不做任何改写 |
 * | `expires_at` | `expires_at`（**毫秒**时间戳） | 统一成字符串毫秒 |
 * | `refresh_expires_at` | 优先 `auth_raw` 的 `refreshExpiresIn - expiresIn` 差值补算 | 见 {@link deriveRefreshExpiresAt} |
 * | `token_type` | 原值，缺省 `Bearer` | |
 * | `domain` | **access_token 的 JWT `iss` 主机名** | 实测与真实凭据一致；它会被当作 `X-Domain` 头发出去 |
 * | `user_id` | access_token 的 JWT `sub` | 实测与真实凭据一致 |
 * | `nickname` | 原值 | |
 * | `enterprise_id` | `''` | 个人版为空串（真实凭据同此） |
 * | `account_type` | 原值，缺省 `personal` | |
 *
 * ⚠️ **不写 `scope`**：真实凭据里有它，但本插件**从不读取** `scope` 发请求
 * （只在续期时原样带回），而第三方文件里也没有它 —— 与其猜一个可能不准的值，
 * 不如省略。缺字段不会被判为无效凭据。
 *
 * ## 账号 id 必须**确定性**生成（可重复导入而不产生重复）
 *
 * `id` 由 uid 经 FNV-1a 哈希得到 8 位 hex，与插件自己登录时生成的形式一致
 * （`buddy-a1b2c3d4`）。这样**同一份文件导入两次，第二次会全部被判为
 * 「已存在」而跳过**，而不是堆出两份账号。
 *
 * ⚠️ 但 id 判重**挡不住**「同一个人的账号已经用随机 id 登录在本机」这种情况 ——
 * 那要靠 user_id 判重（在 `src/backup.ts` 的合并导入里做）。
 */

/** 本插件备份的格式标记（与 `src/types.ts` 的 BACKUP_FORMAT 一致）。 */
const BACKUP_FORMAT = 'dsh-codearts-auth/backup'

/** 备份格式版本（与 `src/types.ts` 的 BACKUP_VERSION 一致）。 */
const BACKUP_VERSION = 1

/**
 * 解码 JWT 的 payload（**不验签**）。
 *
 * 只用于读取 `iss` / `sub` / `exp` 这类公开声明 —— 它们与令牌的有效性无关，
 * 我们也从不基于它们做安全判定（真伪由服务端决定）。
 * 解不出来时返回 `undefined`，调用方必须能容忍。
 */
export function decodeJwtPayload(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    // JWT 用 base64url；atob 只认标准 base64，故先补齐 padding 并换字符集。
    let base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    while (base64.length % 4 !== 0) base64 += '='
    const binary = atob(base64)
    // 逐字节还原成 UTF-8：直接用 atob 结果会把非 ASCII 声明解成乱码。
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    return undefined
  }
}

/**
 * 由任意稳定字符串生成 8 位 hex 短 id（FNV-1a，32 位）。
 *
 * 选哈希而非「取 uid 前 8 位」：uid 形态在不同工具里不一致（UUID / 带前缀的
 * 四十位 hex / 纯数字），逐个分支处理既啰嗦又容易漏；哈希对任何形态都成立，
 * 且输出格式与插件自己生成的 id 完全一致。
 */
export function stableShortId(input) {
  let hash = 0x811c9dc5
  const text = String(input)
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    // Math.imul 保证 32 位整数乘法（普通 * 会因浮点丢精度）。
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 单条记录是否「像一份带令牌的账号」（判定第三方列表的最小充分条件）。 */
function isAccountRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const accessToken = value.access_token
  const refreshToken = value.refresh_token
  return typeof accessToken === 'string' && accessToken.length > 0
    && typeof refreshToken === 'string' && refreshToken.length > 0
}

/**
 * 判断一份已解析的 JSON 是否是**第三方的账号列表**（而不是本插件备份）。
 *
 * 支持两种常见外形：
 * - 裸数组：`[ { access_token, refresh_token, ... }, ... ]`
 * - 带包装的对象：`{ accounts: [...] }` / `{ data: [...] }`（其它工具的常见形态）
 *
 * ⚠️ **必须先排除本插件自己的备份**（`format` 命中就直接返回 false）：
 * 本插件的备份里 `credentials` 也是一个对象，若按「对象里有令牌」判就会误判。
 *
 * ⚠️ **空的裸数组也算第三方外形**（`[]`）：它无论如何都不是合法备份，
 * 认成第三方至少能给出「里面没有账号」这种可操作的提示，而不是
 * 「备份内容不是对象」这种让人无从下手的报错。包装对象同理，但限于
 * 我们认识的那几个键 —— 否则任何 `{ foo: [] }` 都会被当成账号列表。
 */
export function looksLikeForeignAccountList(value) {
  if (value === null || typeof value !== 'object') return false
  // 本插件备份：认 format 标记，绝不当作第三方文件。
  if (!Array.isArray(value) && value.format === BACKUP_FORMAT) return false
  const list = pickAccountArray(value)
  if (list === null) return false
  // 空数组 = 「外形对但没内容」，值得给出可操作的提示；非空则必须**真的**
  // 含令牌记录，否则任意带数组的 JSON 都会被误吞进来。
  return list.length === 0 || list.some(isAccountRecord)
}

/** 从裸数组 / 包装对象里取出账号数组；取不到返回 null。 */
function pickAccountArray(value) {
  if (Array.isArray(value)) return value
  return pickKnownAccountArray(value)
}

/** 只认我们明确支持的包装键（避免把任意含数组的对象都当账号列表）。 */
function pickKnownAccountArray(value) {
  if (typeof value !== 'object' || value === null) return null
  for (const key of ['accounts', 'data', 'items', 'list']) {
    const candidate = value[key]
    if (Array.isArray(candidate)) return candidate
  }
  return null
}

/**
 * 由 access_token 的 `iss` 推断 provider id。
 *
 * CodeBuddy 中国版与国际版（WorkBuddy）的 realm 主机不同，而两套 provider
 * 在本插件里是**不同路由**（`buddy` / `workbuddy`），认错会让凭据发到错误的
 * 端点。故按 realm 主机名分派，认不出时保守回落到 `buddy`（中国版最常见）。
 */
export function providerFromIssuer(issuer) {
  if (typeof issuer !== 'string' || issuer.length === 0) return 'buddy'
  const host = hostOf(issuer)
  return host !== undefined && host.includes('workbuddy') ? 'workbuddy' : 'buddy'
}

/** 取 URL / 裸主机名里的主机部分（大小写不敏感）；解不出返回 undefined。 */
function hostOf(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    // 不是完整 URL 时，退化成「去掉路径」的朴素解析。
    const trimmed = value.replace(/^[a-z]+:\/\//i, '').split('/')[0]
    return trimmed.length > 0 ? trimmed.toLowerCase() : undefined
  }
}

/** 把可能是数字 / 数字字符串 / ISO 字符串的时间值统一成「毫秒时间戳字符串」。 */
function toEpochMsString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return String(parsed)
    const time = Date.parse(value)
    if (Number.isFinite(time)) return String(time)
  }
  return undefined
}

/**
 * 推导 `refresh_expires_at`（refresh_token 的过期时刻，毫秒）。
 *
 * 三种来源，按可靠性排序：
 * 1. 记录里直接有 `refresh_expires_at` / `refreshExpiresAt` → 用它；
 * 2. `auth_raw` 同时给了 `expiresIn` 与 `refreshExpiresIn`（**相对秒数**）
 *    → `expires_at + (refreshExpiresIn - expiresIn) × 1000`。
 *    该公式已实测：结果与本机真实凭据的 `refresh_expires_at - expires_at`
 *    差值**逐毫秒相等**（432000000ms）。
 * 3. refresh_token 自身的 JWT `exp` → 秒转毫秒。
 *    ⚠️ 它比公式**早约 1 秒**（JWT 的 exp 向下取整到秒），故只作兜底。
 *
 * 都取不到时返回 undefined —— 缺这个字段只会让「是否可续期」的展示保守，
 * 不会让凭据失效。
 */
export function deriveRefreshExpiresAt(record, expiresAtMs) {
  const direct = toEpochMsString(record?.refresh_expires_at ?? record?.refreshExpiresAt)
  if (direct !== undefined) return direct
  const auth = record?.auth_raw ?? record?.authRaw
  const expiresIn = Number(auth?.expiresIn)
  const refreshExpiresIn = Number(auth?.refreshExpiresIn)
  if (Number.isFinite(expiresIn) && Number.isFinite(refreshExpiresIn)
    && expiresAtMs !== undefined && Number.isFinite(Number(expiresAtMs))) {
    const delta = (refreshExpiresIn - expiresIn) * 1000
    if (Number.isFinite(delta)) return String(Number(expiresAtMs) + delta)
  }
  const exp = decodeJwtPayload(record?.refresh_token)?.exp
  if (typeof exp === 'number' && Number.isFinite(exp)) return String(exp * 1000)
  return undefined
}

/** 由一条第三方记录造出插件认的**凭据对象**（随后序列化成字符串存进 credentials 字典）。 */
function buildCredential(record) {
  const payload = decodeJwtPayload(record.access_token)
  const accessToken = record.access_token
  const refreshToken = record.refresh_token
  const expiresAtMs = toEpochMsString(record.expires_at ?? record.expiresAt)
  const refreshExpiresAtMs = deriveRefreshExpiresAt(record, expiresAtMs)
  const issuerHost = hostOf(payload?.iss)
  const userId = typeof payload?.sub === 'string' && payload.sub.length > 0
    ? payload.sub
    // JWT 解读不出来时退回记录自带的 uid，别把身份信息丢掉。
    : (typeof record.uid === 'string' && record.uid.length > 0 ? record.uid : undefined)
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    ...expiresAtMs === undefined ? {} : { expires_at: expiresAtMs },
    ...refreshExpiresAtMs === undefined ? {} : { refresh_expires_at: refreshExpiresAtMs },
    token_type: typeof record.token_type === 'string' && record.token_type.length > 0
      ? record.token_type
      : 'Bearer',
    ...issuerHost === undefined ? {} : { domain: issuerHost },
    ...userId === undefined ? {} : { user_id: userId },
    ...nicknameOf(record) === undefined ? {} : { nickname: nicknameOf(record) },
    // 个人版为空串（与真实凭据一致）；企业版记录会自带非空值。
    enterprise_id: typeof record.enterprise_id === 'string' ? record.enterprise_id : '',
    account_type: typeof record.account_type === 'string' && record.account_type.length > 0
      ? record.account_type
      : 'personal',
  }
}

/** 取昵称：优先 nickname，退回 email / name；都不是字符串时 undefined。 */
function nicknameOf(record) {
  for (const key of ['nickname', 'email', 'name', 'uid']) {
    const value = record?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * 把第三方账号列表转换成**本插件备份载荷**。
 *
 * @param {unknown} value 已解析的 JSON。
 * @returns {{payload: object, warnings: string[], accounts: object[], providers: string[]} | null}
 *   不像第三方列表时返回 `null`（调用方据此走原有路径）。
 *
 * 产出的载荷：
 * - `credentials`：`credentialRef → 凭据 JSON 原文字符串`（与插件存储形态一致）；
 * - `accounts`：完整的账号条目（含 `expiresAt` / `refreshable`）；
 * - `disabledModels`：**空表** —— 第三方文件里没有模型开关信息，给空表而不是
 *   照搬当前值，避免这份载荷被当成「整体还原」时改动模型设置；
 * - **不带 `permanentLocks`**：同上，让合并导入保持当前锁定状态。
 */
export function convertForeignAccounts(value) {
  if (!looksLikeForeignAccountList(value)) return null
  const list = pickAccountArray(value) ?? []
  const credentials = {}
  const accounts = []
  const warnings = []
  const usedIds = new Set()
  const providers = new Set()

  for (let index = 0; index < list.length; index++) {
    const record = list[index]
    if (!isAccountRecord(record)) {
      warnings.push(`第 ${index + 1} 条不是有效的账号记录（缺 access_token / refresh_token），已跳过`)
      continue
    }
    const provider = providerFromIssuer(decodeJwtPayload(record.access_token)?.iss)
    const identity = typeof record.uid === 'string' && record.uid.length > 0
      ? record.uid
      : (decodeJwtPayload(record.access_token)?.sub ?? `index-${index}`)
    // 同批次内避免 id 撞车（哈希碰撞概率极低，但重复 uid 是真实可能的：
    // 同一份文件里手工粘了两遍同一个人）。
    let short = stableShortId(`${provider}:${identity}`)
    if (usedIds.has(short)) {
      short = stableShortId(`${provider}:${identity}:${index}`)
      warnings.push(`${nicknameOf(record) ?? identity}: 与前面的账号重复，已为其分配独立 id`)
    }
    usedIds.add(short)

    const credentialRef = `${provider.toUpperCase()}_ACCOUNT_${short.toUpperCase()}`
    const credential = buildCredential(record)
    credentials[credentialRef] = JSON.stringify(credential)
    const expiresAtMs = toEpochMsString(record.expires_at ?? record.expiresAt)
    accounts.push({
      id: `${provider}-${short}`,
      provider,
      nickname: nicknameOf(record) ?? `${provider}-${short}`,
      enabled: record.enabled !== false,
      credentialRef,
      createdAt: createdAtMs(record),
      ...expiresAtMs === undefined ? {} : { expiresAt: Number(expiresAtMs) },
      // 两个令牌都在才可能静默续期（isAccountRecord 已保证都在）。
      refreshable: true,
    })
    providers.add(provider)
  }

  return {
    payload: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: new Date().toISOString(),
      credentials,
      accounts,
      // ⚠️ **空表是「如实表达」而非「中性值」**（原注释写的是「避免这份载荷被当成
      // 整体还原时改动模型设置」—— 那是**错的**）：第三方文件里确实不含模型开关
      // 信息，故这里没有更好的值可写；而 `replaceAll` 收到空表会执行
      // `modelCache = sanitizeDisabledModels({})` = `{}`，即**整体清空黑名单**。
      //
      // 风险由**两条**防线承担，不靠篡改这个字段：
      // ① UI 走第三方路径时**默认切到 `merge`**（`jet-hub.js` 的
      //    `setImportMode('merge')`），而 merge 分支**根本不读** `disabledModels`
      //    （`src/backup.ts` 的 `credentialsToWrite` + `pool.mergeAccounts`）；
      // ② 若用户手动改成「整体还原」，清空开关正是 `replace` 的**声明语义**
      //    （用户明确选择了「覆盖当前全部账号与模型开关」，UI 上有红字警告）。
      disabledModels: {},
    },
    warnings,
    accounts,
    providers: Array.from(providers),
  }
}

/** 创建时间：第三方多为**秒**级时间戳，本插件用**毫秒**；缺省用当前时刻。 */
function createdAtMs(record) {
  const raw = record?.created_at ?? record?.createdAt
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed > 0) {
    // 小于 1e12 视为秒级（毫秒时间戳在本世纪都是 13 位）。
    return parsed < 1e12 ? parsed * 1000 : parsed
  }
  return Date.now()
}
