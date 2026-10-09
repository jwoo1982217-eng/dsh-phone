/**
 * 账号拖拽排序的纯逻辑 —— 与 React 无关，便于单元测试。
 *
 * 之所以单独成模块：组件本身无法在本仓库单测里渲染（react 不在依赖内），
 * 而「拖拽后新顺序是什么」是这块功能里**最容易写错**的部分 ——
 * 典型错误是移除源元素后直接复用目标下标，而目标下标在移除后可能前移一位，
 * 结果插入到错误位置。把它抽成纯函数就能用真实断言覆盖，而不是靠
 * 源码级字符串匹配。
 */

/**
 * 计算把 `sourceId` 移动到 `targetId` 前/后之后的新顺序。
 *
 * 返回 `null` 表示无需变更（id 不存在，或源与目标相同）。
 *
 * ## 为什么要区分 before / after
 *
 * 只支持「插入到目标之前」会有一个明显的体验缺陷：把 `a` 往下拖一格落在
 * `b` 上时，`a` 本来就在 `b` 之前，结果是**空操作** —— 用户会认为拖拽坏了。
 * 同理把 `b` 往上拖落在 `a` 上却要正常生效。
 *
 * 因此调用方按**指针落在目标卡片的上半还是下半**决定位置（与主流拖拽库
 * 一致），本函数只负责在给定位置执行移动。
 *
 * ## 为什么不能复用目标下标
 *
 * ```
 * ids = [a, b, c, d]，把 a 拖到 c 之前：
 *   from = 0, to = 2
 *   移除 a → [b, c, d]，此时 c 的下标已从 2 变成 1
 * ```
 * 若仍按 `to = 2` 插入会得到 `[b, c, a, d]`（插到 c **之后**），
 * 与用户看到的插入线不符。故移除后必须用 `indexOf` 重算目标位置。
 *
 * @param ids - 当前顺序的 id 列表
 * @param sourceId - 被拖动的 id
 * @param targetId - 落点 id
 * @param position - `'before'` 插到目标之前（默认）；`'after'` 插到目标之后
 * @returns 新顺序；无需变更时返回 null
 */
export function orderAfterDrop(ids, sourceId, targetId, position = 'before') {
  const from = ids.indexOf(sourceId);
  const to = ids.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  next.splice(from, 1);
  // 必须重算：移除源元素后，目标下标可能前移一位。
  const targetIndex = next.indexOf(targetId);
  next.splice(position === 'after' ? targetIndex + 1 : targetIndex, 0, sourceId);
  return next;
}

/**
 * 根据指针在目标元素内的纵向位置决定插入方向。
 *
 * 落在**下半部** → 插到其后；上半部 → 插到其前。这样「往下拖一格」与
 * 「往上拖一格」都能得到符合直觉的结果（见 {@link orderAfterDrop} 的说明）。
 *
 * @param clientY - 指针的视口 Y 坐标
 * @param rect - 目标元素的位置尺寸（`getBoundingClientRect()`）
 * @returns `'before'` 或 `'after'`
 */
export function dropPositionFromPointer(clientY, rect) {
  // rect 缺失或高度为 0（未挂载/隐藏）时退回 'before'，行为可预期。
  if (!rect || !rect.height) return 'before';
  return clientY > rect.top + rect.height / 2 ? 'after' : 'before';
}
