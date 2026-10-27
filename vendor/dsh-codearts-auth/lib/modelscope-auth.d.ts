/**
 * ModelScope（魔搭）认证服务。
 *
 * ## 与其余 provider 的**根本差异：没有登录流程，也不能续期**
 *
 * 魔搭的凭据是用户在**控制台手工生成的 API Key**（形态 `ms-…`），
 * 既没有 OAuth 授权页，也没有 refresh 端点：
 *
 * - 因此**不实现** `login()` / `startLogin()` —— 本 provider 的入口是
 *   Jet Hub 面板上的**粘贴 Key 弹窗**（与 opencode 同型，是本插件第二家
 *   「不跳浏览器」的登录方式）。`account.create` 分支直接走
 *   `modelscope.addAccount`，**不经过**「弹窗 + 登录轮询」那条路径；
 * - `refresh()` / `refreshAccountCredential()` / `refreshAll()` 只做
 *   **有效性对账**（重读凭据 + 回写 `expiresAt`），**不假装续期成功** ——
 *   与 Loomy 同类（那边也没有 refresh 端点），但**理由更根本**：魔搭的 Key
 *   默认长期有效，压根没有「快过期」这回事。
 *
 * ## ⚠️ `refreshAll()` 只按「凭据是否已过期」过滤，**不看 `enabled`**
 *
 * AGENTS.md 的铁律：停用只影响「账号池的自动选号」，与「凭据是否需要保持
 * 新鲜」无关。本 provider 的凭据是静态材料，这条影响其实为零（没有网络请求
 * 可发），但**接口形态必须与其余 provider 一致** —— 否则将来若魔搭推出
 * refresh 端点，这里会成为一个新的单向门。
 *
 * ## 服务名
 *
 * 由产品 id 派生为 `modelscopeAuth`（cordis 的 `Service` 同名二次注册会抛错，
 * 故每个 provider 各占一个服务名）。
 *
 * @module src/modelscope-auth.ts
 */
import { Service, type Context } from '@deepseek-ai/cordis';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { type ModelscopeCredential } from './modelscope.js';
import { type ModelscopeProduct } from './modelscope-product.js';
import { AccountPool } from './account-pool.js';
/** 用于 Jet Hub 面板的只读登录状态。 */
export interface ModelscopeLoginStatus {
    configured: boolean;
    /** 恒为 `'api-key'`：魔搭的凭据由用户手工粘贴，不是 OAuth 换来的。 */
    source?: string;
    expiresAt?: number;
    /** 恒为 `false`（魔搭没有续期机制）。 */
    refreshable: boolean;
    /** 最近一次对账失败的原因（如有）。 */
    refreshError?: string;
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** ModelScope 的认证服务实例。 */
        modelscopeAuth: ModelscopeAuth;
    }
}
/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
export declare function parseModelscopeCredential(value: string): ModelscopeCredential | undefined;
/** `ModelscopeAuth` 的构造选项。 */
export interface ModelscopeAuthOptions {
    /** 产品配置；默认 {@link MODELSCOPE}。 */
    product?: ModelscopeProduct;
    /** 服务名覆盖（默认由产品 id 派生为 `modelscopeAuth`）。 */
    serviceName?: string;
}
/**
 * ModelScope 认证服务：**凭据保管与有效期对账**（无登录、无续期）。
 */
export declare class ModelscopeAuth extends Service {
    /** 本实例所属的产品配置。 */
    readonly product: ModelscopeProduct;
    /** 本实例默认读写的凭据 ref 名称（`MODELSCOPE_ACCESS_TOKEN`）。 */
    readonly credentialRefName: string;
    constructor(ctx: Context, options?: ModelscopeAuthOptions);
    /**
     * 面板状态：只看**池里有没有该 provider 的凭据**（与其余 provider 的门控
     * 判据完全一致）。
     *
     * ⚠️ 与 AGENTS.md 的「十个 provider 门控判据完全一致：都只看账号池」同款 ——
     * 本 provider 也**不**为单凭据 ref 开例外（那里早期有过 `extraCredentialRefs`，
     * 已整体删除）。
     */
    status(pool?: AccountPool): Promise<ModelscopeLoginStatus>;
    /**
     * 单凭据路径的「续期」。
     *
     * ⚠️ **这里不发出任何网络请求，也不写凭据** —— 魔搭没有 refresh 端点。
     * 它只做一次**有效性对账**：凭据不可读时抛可读错误（引导用户在面板重新粘贴），
     * 可读时静默通过。**绝不返回「续期成功」的假象**（与 Loomy 的
     * `RefreshTokenExpiredError` 同口径）。
     */
    refresh(): Promise<void>;
    /**
     * 按**凭据 ref** 对账指定账号（RPC `account.refresh` 的分派目标）。
     *
     * ⚠️ 签名里的 `pool` / `accountId` **必须接受并透传**给 `syncAccountExpiry`：
     * 它们是「续期后把新的 `expiresAt` 回写账号池」这条链路的唯一入口
     * （issue !IKIRTT）。魔搭这边通常没有 `expires_at` 可写，但**接口不能少**
     * —— `tests/unit/refresh-bootstrap-wiring.spec.ts` 会逐个 provider 扫这条
     * 不变式，缺参数能编译、类型全绿，但会静默丢回写。
     *
     * @param refName  账号的凭据 ref（**不是**默认单凭据 ref）。
     * @param pool     账号池；提供时才回写 `expiresAt`。
     * @param accountId 账号 id；提供时免去按凭据身份反查。
     */
    refreshAccountCredential(refName: string, pool?: AccountPool, accountId?: string): Promise<void>;
    /**
     * 批量对账（启动首轮 + 每 30 分钟的定时器）。
     *
     * ## ⚠️ 三条必须同时满足（见 AGENTS.md 的「续期三件事缺一不可」）
     *
     * 1. **不看 `enabled`**：停用账号的凭据同样要保持新鲜。魔搭这里没有网络
     *    请求，但判据必须写对 —— 否则将来加 refresh 端点即成单向门；
     * 2. **不过滤 `refreshable`**：那个布尔只是**凭据材料的镜像**，拿它当门禁会把
     *    一次瞬时失败固化成永久状态（AGENTS.md 的「账号池的 `refreshable` 只是
     *    凭据材料的镜像」一节）。魔搭的凭据恒 `refreshable:false`，用它会变成
     *    **一条都进不来**；
     * 3. **判据用凭据自己的值，不用池里的 `expiresAt`**：池值正是可能陈旧的那份
     *    数据（`syncAccountExpiry` 的 lead-time 注释）。
     *
     * 本 provider 的「跳过」分支**只跳过对账之外的动作**，且每轮仍会调用
     * `syncAccountExpiry` —— 存量账号的池值即便早已陈旧（例如上一版插件从未
     * 回写过），也会在第一次运行后被自动更正。
     */
    refreshAll(pool?: AccountPool): Promise<void>;
    /** 凭据是否被判定为已失效（供门控与面板用）。 */
    checkExpired(pool?: AccountPool): Promise<boolean>;
    /** 读一个 ref 下的凭据（不可用或非 JSON 时返回 undefined）。 */
    private readCredential;
}
/** 默认凭据 ref（等价于 `MODELSCOPE.defaultCredentialRef`）。 */
export declare const MODELSCOPE_CREDENTIAL_REF: CredentialRef;
//# sourceMappingURL=modelscope-auth.d.ts.map