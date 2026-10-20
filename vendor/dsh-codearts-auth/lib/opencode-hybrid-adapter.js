/**
 * OpenCode 混合适配器：同一个 provider 下并列两条通道路由。
 *
 * ## 为什么需要它
 *
 * JetHub 的 `opencode` 槽位当前接的是**本机 OpenCode serve**（`OpencodeLocalAdapter`）：
 * 请求交给本地 CLI 服务，模型目录也来自它。该通道在免费档上要过本地 CLI、
 * 会话握手与工具回传，体感慢；而上游 2026-10-17 开放的
 * `https://opencode.ai/inference` 直连入口（见 `opencode-inference.ts`）实测
 * 单轮响应明显更快，且同样免 key。
 *
 * 用户要的是「在 OpenCode 这个选项里」用到快通道，而不是多一个供应商，
 * 故这里做**按模型 id 分流**的包装：
 *
 * - `OPENCODE_INFERENCE_MODELS` 里的模型（deepseek-v4.1-flash-free 等）→ 直连 /inference；
 * - 其余模型 → 原有本地服务通道，行为不变。
 *
 * 目录取两边并集；本地服务没起来时，快通道模型仍可见可用。
 */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import { getOpencodeCapabilitiesSync } from './opencode-capability.js';
import { OpencodeAdapter as ZenAdapter } from './opencode-adapter.js';
import { deriveProjectId } from './opencode.js';
import { OPENCODE, OPENCODE_INFERENCE_MODELS, usesInferenceLane } from './opencode-product.js';
/** 快通道的匿名槽（`Bearer public`，直连出口 IP 记账）。 */
export function opencodeInferenceSlot() {
    return {
        id: 'opencode-inference',
        kind: 'anonymous',
        apiKey: OPENCODE.anonymousKey,
        proxy: undefined,
        fingerprint: { projectId: deriveProjectId('opencode-inference', 0), generation: 0 },
        userAgent: OPENCODE.inferenceUserAgent,
    };
}
/** 构造一个只走匿名快通道的 Zen 适配器实例。 */
export function createOpencodeInferenceAdapter(options = {}) {
    const slot = opencodeInferenceSlot();
    return new ZenAdapter({ ...options, identitySlots: async () => [slot] });
}
/**
 * 混合适配器：快通道优先按模型分流，其余委托本地服务。
 *
 * ⚠️ `listAllModels()` 必须**同步**（Jet Hub 的 `ModelCatalogSource` 契约），
 * 因此这里只读两个适配器的同步快照，不触发任何网络/进程操作。
 */
export class OpencodeHybridAdapter extends LlmAdapter {
    local;
    fast;
    options;
    constructor(local, fast, options = {}) {
        super();
        this.local = local;
        this.fast = fast;
        this.options = options;
    }
    /** 已有视觉型号整体保留原生通道；不能用 /zen 的视觉声明冒充快通道已验证。 */
    useFast(model) {
        if (!usesInferenceLane(model))
            return false;
        const local = this.local.service?.cachedModels().find(entry => entry.id === model);
        const capability = getOpencodeCapabilitiesSync().find(entry => entry.id === model);
        return local?.inputModalities.includes('image') !== true && capability?.modalities.includes('image') !== true;
    }
    providerInfo(provider) {
        return { id: provider, name: OPENCODE.displayName };
    }
    listAllModels() {
        const disabled = this.options.disabledModels?.() ?? new Set();
        const local = this.local.listAllModels().filter((m) => !disabled.has(m.id));
        const seen = new Set(local.map((m) => m.id));
        // 快通道模型全部为免费档；与本地目录重名时以本地为准（本地优先，行为不变）。
        const extra = OPENCODE_INFERENCE_MODELS
            .filter((m) => this.useFast(m.id) && !seen.has(m.id) && !disabled.has(m.id))
            .map((m) => ({ id: m.id, name: m.name, isFree: true }));
        return [...local, ...extra];
    }
    async listModels(provider) {
        const disabled = this.options.disabledModels?.() ?? new Set();
        const local = (await this.local.listModels(provider)).filter((m) => !disabled.has(m.id));
        const seen = new Set(local.map((m) => m.id));
        // 只取快通道实测表内的条目：fast.listModels 的目录还含旧 /zen 免费模型，
        // 那些在本 provider 下没有可用通道，不能露给用户。
        const fast = (await this.fast.listModels(provider))
            .filter((m) => this.useFast(m.id) && !seen.has(m.id) && !disabled.has(m.id));
        return [...local, ...fast];
    }
    async resolveModel(provider, model, signal) {
        if (this.useFast(model))
            return this.fast.resolveModel(provider, model, signal);
        // OpencodeLocalAdapter.resolveModel 只有 (provider, id) 两个参数。
        return this.local.resolveModel(provider, model);
    }
    async prepareCall(provider, model, signal) {
        // 后台能力刷新不能让同一次请求的元信息与发送切到两个不同通道。
        const adapter = this.useFast(model) ? this.fast : this.local;
        return adapter.prepareCall(provider, model, signal);
    }
    handleRpc(method, payload) {
        return this.local.handleRpc(method, payload);
    }
    async *stream(options) {
        if (this.useFast(options.model)) {
            yield* this.fast.stream(options);
            return;
        }
        yield* this.local.stream(options);
    }
}
//# sourceMappingURL=opencode-hybrid-adapter.js.map