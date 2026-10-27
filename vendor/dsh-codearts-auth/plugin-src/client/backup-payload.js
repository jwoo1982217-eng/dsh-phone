/**
 * 备份载荷的**纯函数**工具（无 React、无 Web Crypto，可直接单测）。
 *
 * 为什么需要裁剪：合并导入（`mode: 'merge'`）的判重发生在**后端**，它只知道
 * 「这份载荷里有哪些账号」，不知道用户在界面上勾了哪几个。若不先裁剪，用户
 * 从别人的整份备份里只勾一个账号，后端仍会把备份里**其余**账号一并追加进来；
 * 更糟的是凭据写入 —— 备份里那些不在勾选范围内的 `credentialRef` 可能已经被
 * 本机现有账号占用，写进去等于**覆盖现有账号的凭据**，与「只增加不覆盖」的
 * 承诺相反。
 *
 * 故裁剪必须发生在**发请求之前**，且要同时裁掉两个地方：`accounts` 与
 * `credentials`（只留被选中账号引用的 ref）。
 *
 * ⚠️ **`disabledModels` 不裁**（真实缺陷，对抗审计实测证伪）：本文件初版把它清成
 * 空表，注释理由是「合并模式本就不使用它，清空可避免被误写成整体替换语义的载荷」
 * —— 但**空表不是中性值**：`replaceAll` 收到空表执行 `sanitizeDisabledModels({})`
 * = `{}`，即**整体清空用户的模型黑名单**（实测：先关闭 2 个模型 → 导入一份
 * `disabledModels: {}` 的载荷并走 `replace` → 开关被静默清空）。
 *
 * `accountIds` 的语义本就**只作用于 `accounts` 与 `credentials`**（黑名单与锁定表
 * 都是全量，产物才是一份可整体还原的自包含快照）⇒ 该字段**原样保留**。
 * 真正防「误当 replace」的是**模式白名单**（`src/jet-hub-rpc.ts` 的
 * `req?.mode === 'merge' ? 'merge' : 'replace'`）与 **merge 分支根本不读它**
 * （`src/backup.ts` 的 `credentialsToWrite` + `pool.mergeAccounts`），
 * 不是靠篡改字段值。
 *
 * ⚠️ **不要**在这里做任何凭据解密或改写：`credentials` 的值是凭据 JSON
 * **原文字符串**，必须原样搬运（后端按存储契约回写）。
 */

/**
 * 把备份载荷裁剪成只含指定账号。
 *
 * @param {object} payload 解密后的备份载荷（`dsh-codearts-auth/backup`）。
 * @param {readonly string[]} accountIds 要保留的账号 id。
 * @returns {object} 新的载荷对象（不修改入参）。`accountIds` 为空时返回一份
 *   `accounts` 为空、`credentials` 为空的载荷 —— 调用方应在此之前拦下「一个
 *   都没勾」的情况并给出提示，而不是发一份空载荷。
 */
export function trimBackupPayload(payload, accountIds) {
  const wanted = new Set(Array.isArray(accountIds) ? accountIds : []);
  const accounts = (Array.isArray(payload?.accounts) ? payload.accounts : [])
    .filter((entry) => entry !== null && typeof entry === 'object' && wanted.has(entry.id));
  // 只保留被选中账号实际引用的凭据 ref：备份里可能存在账号池之外的独立凭据
  // （各 provider 的默认单凭据 ref），它们在「只加一个账号」的语境下不该被写入。
  const refs = new Set(
    accounts
      .map((entry) => entry.credentialRef)
      .filter((ref) => typeof ref === 'string' && ref.length > 0),
  );
  const credentials = {};
  const source = payload?.credentials !== null && typeof payload?.credentials === 'object'
    ? payload.credentials
    : {};
  for (const [ref, value] of Object.entries(source)) {
    if (refs.has(ref)) credentials[ref] = value;
  }
  return {
    ...payload,
    accounts,
    credentials,
    // ⚠️⚠️ **`disabledModels` 必须原样保留，不能改成空表**（真实缺陷，对抗审计
    // 实测证伪）。这里原先写的是 `disabledModels: {}`，注释理由是「让这份载荷
    // 无论被哪个版本的后端当成整体替换处理都不会改动模型开关（防误伤）」——
    // **该理由与实现相反**：`replaceAll` 收到空表执行的是
    // `modelCache = sanitizeDisabledModels({})` = `{}`，即**整体清空黑名单**，
    // 不是「不改动」。空表不是中性值，它谎称「这份备份里没有任何被关闭的模型」。
    //
    // 实测（本机）：先关闭 2 个模型 → 导入一份 `disabledModels: {}` 的载荷并走
    // `replace` → `disabledModelsFor(provider)` 变成空集，**用户的模型开关被静默清空**。
    //
    // ⇒ 正确做法是**保留原值**：`accountIds` 的语义本就只作用于 `accounts` 与
    // `credentials` 两个字段（见本模块文件头），黑名单与锁定表都是**全量**的。
    // 这样即便载荷真的被当成 `replace` 处理，落地的也是**备份文件里真实的开关
    // 状态**（`replace` 的正确语义），而不是被篡改成「全关」。
    // 真正防「误当 replace」的防线是**模式白名单**（`src/jet-hub-rpc.ts` 的
    // `req?.mode === 'merge' ? 'merge' : 'replace'`）与 **merge 分支根本不读
    // `disabledModels`**（`src/backup.ts` 的 `credentialsToWrite` 与
    // `pool.mergeAccounts(importedAccounts)`），不是靠篡改字段值。
    disabledModels: payload?.disabledModels !== null && typeof payload?.disabledModels === 'object'
      && !Array.isArray(payload.disabledModels)
      ? payload.disabledModels
      : {},
  };
}

/**
 * 从备份载荷里取出可勾选的账号摘要（导入弹窗用）。
 *
 * 与 `backup.status` 的 `accountList` 同构，便于两个弹窗共用同一段渲染。
 * 坏条目（缺 id）直接丢弃 —— 它们本来也进不了账号池。
 */
export function describeBackupAccounts(payload) {
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  return accounts
    .filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && entry.id.length > 0)
    .map((entry) => ({
      id: entry.id,
      provider: typeof entry.provider === 'string' ? entry.provider : '',
      nickname: typeof entry.nickname === 'string' && entry.nickname.length > 0 ? entry.nickname : entry.id,
      enabled: entry.enabled !== false,
    }));
}
