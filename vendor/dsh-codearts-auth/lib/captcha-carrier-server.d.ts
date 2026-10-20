/** 页面路由（唯一一条）。client 拿到的地址就是 `http://127.0.0.1:<port>/carrier`。 */
export declare const CARRIER_PAGE_ROUTE = "/carrier";
export interface CarrierPageServerOptions {
    /**
     * 渲染载体页（通常是 `buildCarrierPageHtml(await zcode.fetchCaptchaConfig())`）。
     *
     * 抛错 ⇒ 回 500（见 handler），**不许**把监听器带崩。
     */
    renderPage: () => Promise<string> | string;
    /** 候选端口生成（注入只为让单测能制造「端口被占用」那一支）。 */
    pickCandidate?: () => number;
    /** 最多试几个候选端口（默认 8）。全被占 ⇒ 返回 `null`（RPC 据此回 `url: null`）。 */
    attempts?: number;
    log?: (message: string) => void;
}
export declare class CarrierPageServer {
    private readonly renderPage;
    private readonly pickCandidate;
    private readonly attempts;
    private readonly log;
    private server;
    private boundPort;
    /** 并发去重：两个 RPC 同时问地址时只起一个监听器。 */
    private starting;
    constructor(options: CarrierPageServerOptions);
    /** 当前地址（未启动 / 已停止 ⇒ `null`）。 */
    url(): string | null;
    /** 当前端口（未启动 / 已停止 ⇒ `null`）。 */
    port(): number | null;
    /**
     * 起服务并回地址；起不来回 `null`（**不抛** —— 载体页只是「没有 chromium 时的补充」，
     * 它起不来不该影响任何一条主路径）。
     */
    start(): Promise<string | null>;
    /**
     * 关闭。⚠ `close` 的回调在**没有连接**时才会立刻到，所以必须真的回调一次
     * （不能 fire-and-forget：那会让「停掉后端口释放」不可验）。重复调用无害。
     */
    stop(): void;
    /** 选端口 → 占一下 → 真监听。全部失败回 `false`（调用方据此换下一个候选）。 */
    private listen;
    /** 真绑一次端口。成功 ⇒ 记下 server 并回 true；`EADDRINUSE` 之类 ⇒ 回 false（换候选）。 */
    private tryListen;
    /**
     * 唯一的 handler：只服务 `GET /carrier`，其余一律拒。
     *
     * ⚠ 判**路径**而不是「路径含 carrier」：`/api/jet-hub/captcha-carrier`（插件自己那条
     * 旧路由）在这个服务上必须 404，否则两处语义会悄悄合并成一条。
     */
    private handle;
    /** 现渲染那一页（配置跟着远端 60 秒 TTL 变，缓存这份只会拿旧 SceneId）。 */
    private sendCarrierPage;
}
//# sourceMappingURL=captcha-carrier-server.d.ts.map