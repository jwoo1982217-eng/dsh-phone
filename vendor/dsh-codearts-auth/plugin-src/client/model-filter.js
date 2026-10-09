/**
 * 模型列表的搜索与状态筛选（纯逻辑）。
 *
 * ## 为什么单独成文件
 *
 * 与 `model-bulk.js` / `account-order.js` 同理：本仓库单测环境里 react 不在
 * 依赖内，组件无法渲染，故把最容易写错的判定抽成纯函数才能用真实断言覆盖，
 * 而不是靠源码级字符串匹配间接验证。
 *
 * ## 为什么只有搜索与筛选（**没有多选、没有渲染上限**）
 *
 * Cline 的远端目录实测约 478 条，搜索与筛选确实有用。但**多选勾选框曾引入
 * 真实的行为倒退**（已回退，勿再引入）：
 *
 * `ModelToggle` 的根元素是 `<label>`。原先 label 内只有 1 个 checkbox，点行内
 * 任意位置（如模型名）都会激活它 —— 即「点模型名切换可见性」。一旦插入第二个
 * checkbox（多选勾选框），浏览器把点击激活到**第一个**可标记控件，于是
 * 「点模型名」变成切换勾选、可见性开关纹丝不动。实测确认（无头 Edge）：
 *
 * | 操作 | 单 checkbox | 双 checkbox |
 * |---|---|---|
 * | 点行内文字 | 切换可见性 ✅ | **切换勾选，可见性不动** ❌ |
 *
 * 若将来确需多选，**必须先把行容器从 `<label>` 改成 `<div>`**（并自行处理
 * 点击切换），否则同样会踩这个坑。
 *
 * 渲染上限同理被移除：改动前 478 条本来就是一次性全渲染、工作正常，
 * 加「显示更多」反而凭空多一次点击，属于功能收缩。
 */

/**
 * 状态筛选的合法取值。
 *
 * `all` 不筛；`enabled` 只留**已打开**（`disabled === false`）；
 * `disabled` 只留**已关闭**。用白名单而不是「非 all 即筛」：未知取值必须
 * 退化为不筛（宁多勿少），否则一次前端笔误会让列表凭空少掉大半。
 */
export const MODEL_STATUS_FILTERS = Object.freeze(['all', 'enabled', 'disabled']);

/**
 * 归一化状态筛选值：未知取值一律退化为 `all`。
 *
 * @param {unknown} status 原始取值
 * @returns {'all' | 'enabled' | 'disabled'}
 */
export function normalizeStatusFilter(status) {
  return MODEL_STATUS_FILTERS.includes(status) ? status : 'all';
}

/**
 * 单个模型是否命中搜索词。
 *
 * 同时匹配**展示名与 id**（不区分大小写）：Cline 的 id 形如
 * `cline-free/deepseek-v4.1-flash`，用户可能记得名字（`DeepSeek V4.1 Flash`）
 * 也可能只记得 id 片段（`v4.1`），两者都要能搜到。
 *
 * 空搜索词视为命中全部（而不是不命中）——这是「未搜索」而非「搜索空串」。
 *
 * @param {{ id?: string, name?: string }} model 模型条目
 * @param {string} query 搜索词
 * @returns {boolean}
 */
export function matchesModelQuery(model, query) {
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle.length === 0) return true;
  const name = typeof model?.name === 'string' ? model.name : '';
  const id = typeof model?.id === 'string' ? model.id : '';
  return name.toLowerCase().includes(needle) || id.toLowerCase().includes(needle);
}

/**
 * 按搜索词与状态筛选模型列表。
 *
 * 非数组输入返回空数组（与 `bulkButtonState` 的 null 容忍同约定），
 * 因为列表在载入完成前就是 `null`。
 *
 * @param {Array<{ id: string, name?: string, disabled?: boolean }> | null} models 全量列表
 * @param {{ query?: string, status?: string }} [options] 筛选条件
 * @returns {Array<object>} 命中的模型（保持原顺序）
 */
export function filterModels(models, options = {}) {
  const list = Array.isArray(models) ? models : [];
  const status = normalizeStatusFilter(options.status);
  const query = typeof options.query === 'string' ? options.query : '';
  return list.filter((model) => {
    // 状态判定用 `=== true` 与适配器的黑名单语义对齐：只有显式 true 才算已关闭。
    if (status === 'enabled' && model?.disabled === true) return false;
    if (status === 'disabled' && model?.disabled !== true) return false;
    return matchesModelQuery(model, query);
  });
}

/**
 * 当前是否处于「有筛选」状态。
 *
 * 用途：只在有筛选时才显示「清空筛选」按钮 —— 无筛选时那个按钮无事可做，
 * 显示出来只是噪音。
 *
 * @param {{ query?: string, status?: string }} [options] 筛选条件
 * @returns {boolean}
 */
export function isFilterActive(options = {}) {
  const query = typeof options.query === 'string' ? options.query.trim() : '';
  return query.length > 0 || normalizeStatusFilter(options.status) !== 'all';
}
