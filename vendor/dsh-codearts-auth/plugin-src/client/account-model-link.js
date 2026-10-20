/**
 * 「停用账号」与「关闭该 Provider 模型」之间的联动判定（纯逻辑）。
 *
 * ## 背景：为什么需要这个联动
 *
 * 门控判据刻意**不看 `enabled`**（见 `AccountPool.hasLoggedInAccount` 的注释：
 * 「停用只应影响自动选号，与是否已登录无关」）。这是**整体设计**，本模块不改它。
 *
 * 但它带来一个用户可感知的落差：停用某 provider 的**最后一个**启用账号后，
 * 该 provider 在账号池里已经不可用，可它的模型**仍然留在对话框的模型选择器里**
 * （因为凭据还在，目录门控判为「可见」）。用户看到的是「我都停用了，怎么还能选到
 * 它的模型」—— 只能再去「显示列表」里手动把几十上百个模型逐个关掉。
 *
 * 本模块把这件事变成**显式的一次选择**：停用最后一个启用账号时问一句
 * 「是否同时关闭它的模型」，由用户决定，而不是替用户静默改门控语义。
 *
 * ## 为什么只在「最后一个启用账号」时问
 *
 * 该 provider 还有别的启用账号时，它的模型依然可用，关掉全部模型纯属误伤。
 * 只有停用后**不再有任何启用账号**，模型才真的用不上 —— 这才是该提问的时刻。
 *
 * 与 `model-bulk.js` / `model-filter.js` 同理单独成文件：本仓库单测环境里
 * react 不在依赖内，组件无法渲染，故把判定抽成纯函数才能用真实断言覆盖。
 */

/**
 * 停用某账号后，该 provider 是否**不再有任何启用账号**。
 *
 * 只在「停用」方向、且该账号当前确实启用时返回 true —— 对已停用账号再点停用
 * 是空操作，不该弹确认。
 *
 * @param {Array<{ id: string, provider: string, enabled?: boolean }> | null} accounts 当前账号列表
 * @param {string} accountId 正在被停用的账号 id
 * @param {string} provider 该账号所属 provider
 * @returns {boolean}
 */
export function disablingLeavesNoEnabledAccount(accounts, accountId, provider) {
  const list = Array.isArray(accounts) ? accounts : [];
  const target = list.find(a => a?.id === accountId);
  // 账号不在列表里（列表已过期）或本就已停用：没有可判定的状态变更，不提示。
  if (target === undefined || target.enabled === false) return false;
  const stillEnabled = list.some(
    a => a?.provider === provider && a?.id !== accountId && a?.enabled !== false,
  );
  return !stillEnabled;
}

/**
 * 该 provider 的模型是否**全部处于关闭状态**（且至少有一个模型）。
 *
 * 用于「启用账号」方向的反向联动：如果这个 provider 的模型是全关的（很可能正是
 * 上一次停用账号时连带关掉的），启用账号时顺带问一句要不要一起打开。
 *
 * 空列表返回 false：没有模型可谈，「打开全部」也无事可做。
 *
 * @param {Array<{ disabled?: boolean }> | null} models 模型列表（来自 `model.list`）
 * @returns {boolean}
 */
export function allModelsDisabled(models) {
  const list = Array.isArray(models) ? models : [];
  if (list.length === 0) return false;
  // 与适配器黑名单语义对齐：只有显式 true 才算已关闭。
  return list.every(m => m?.disabled === true);
}
