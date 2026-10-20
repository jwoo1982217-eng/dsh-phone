/** 密钥的来源，供设置页展示与复制（**不要**在日志里打印 `value`）。 */
export interface ApiKeySource {
    /** 密钥本体。 */
    value: string;
    /** 是否来自 `DSH_OPENAI_GATEWAY_API_KEY` 环境变量。 */
    fromEnv: boolean;
    /**
     * 密钥文件路径；`fromEnv` 为真时为 `null`。
     *
     * 交给 UI 是为了让用户能自己核对/备份，而不必猜 DSH home 到底在哪 ——
     * 它可能来自 `profileContext.home`，未必是 `%USERPROFILE%\.dsh`。
     */
    path: string | null;
}
/**
 * 读取网关密钥；没有时生成一次。
 *
 * ## 为什么「文件内容异常」要报错而不是换掉
 *
 * 初版是「读不到就重新生成」，看似自愈，实则有一个隐蔽后果：文件被误删或
 * 被手工改坏时，服务端会**悄悄换一个全新的 key**，所有已配置的客户端同时开始
 * 返回 `unauthorized`。而客户端只给这一句提示，用户无从判断是自己粘错了哪
 * 一位、还是服务端变了 —— 这类「重登一下就好了」之外毫无线索的故障极难排查。
 *
 * 因此这里区分三种情况：
 * - **文件不存在 / 内容为空** ⇒ 从未生成过，正常生成；
 * - **内容符合 {@link KEY_PATTERN}** ⇒ 是我们自己写的，采信；
 * - **内容有值但不符合** ⇒ 明确报错，并给出恢复办法（删掉文件让它重建，
 *   或改用 `DSH_OPENAI_GATEWAY_API_KEY`）。
 */
export declare function loadOrCreateApiKey(home: string, env?: NodeJS.ProcessEnv): ApiKeySource;
//# sourceMappingURL=auth.d.ts.map