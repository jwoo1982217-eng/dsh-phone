/**
 * 模型列表「打开全部 / 关闭全部」按钮的可用性判定（纯逻辑）。
 *
 * 与 `account-order.js` 同理单独成文件：本仓库的单测环境里 react 不在依赖内，
 * 组件无法渲染，因此把判定逻辑抽出来才能用真实断言覆盖，而不是靠源码级
 * 字符串匹配去间接验证。
 *
 * 判定要点：**已经是目标状态时按钮必须禁用**。
 *
 * 「打开全部」在全部已打开时若仍可点，用户点下去看不到任何变化，只会以为
 * 按钮失灵；「关闭全部」在全部已关闭时同理。空列表与提交中一律全禁用 ——
 * 前者无意义（且会白写一次空黑名单 + 广播），后者是为了避免并发提交互相覆盖。
 */

/**
 * 计算两个批量按钮的禁用状态。
 *
 * @param {Array<{ disabled: boolean }> | null} models 当前列表（null = 尚未载入）
 * @param {boolean} busy 是否有批量提交正在进行
 * @returns {{ openAllDisabled: boolean, closeAllDisabled: boolean }}
 */
export function bulkButtonState(models, busy) {
  // 未载入与空列表同语义：没有任何模型可操作，两个按钮都禁用。
  if (busy || !models || models.length === 0) {
    return { openAllDisabled: true, closeAllDisabled: true };
  }
  // 只要还存在「已关闭」的项，「打开全部」就有事可做。
  const anyDisabled = models.some(m => m.disabled);
  // 只要还存在「已打开」的项，「关闭全部」就有事可做。
  const anyEnabled = models.some(m => !m.disabled);
  return { openAllDisabled: !anyDisabled, closeAllDisabled: !anyEnabled };
}
