import { randomUUID, createHash } from 'node:crypto';

export const REF = 'DSH_AGENT_CARDS_V1';
export const limits = { cards: 64, combos: 32, subCards: 8, cardBytes: 32768, activeBytes: 131072, fileBytes: 524288 };
export class CardsError extends Error {}
const fail = message => { throw new CardsError(message); };
const text = (value, max, label) => typeof value === 'string' && value.trim() && Buffer.byteLength(value) <= max ? value.trim() : fail(`${label}不能为空，且不能超过 ${max} 字节`);
const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,120}$/.test(value) ? value : fail('卡片或组合标识无效');
const empty = () => ({ version: 1, revision: 0, cards: [], combos: [], selection: { mainId: null, subIds: [] }, legacyIds: [] });
function card(value) {
  if (!value || !['main', 'sub'].includes(value.kind)) fail('请选择主卡或副卡');
  return { id: identifier(value.id), name: text(value.name, 160, '卡片名称'), kind: value.kind, content: text(value.content, limits.cardBytes, '卡片正文') };
}
function selection(value, cards) {
  if (!value || !Array.isArray(value.subIds) || value.subIds.length > limits.subCards || new Set(value.subIds).size !== value.subIds.length) fail(`最多同时启用 ${limits.subCards} 张不同副卡`);
  const mainId = value.mainId ?? null;
  if (mainId !== null && !cards.some(c => c.id === mainId && c.kind === 'main')) fail('主卡不存在或类型不正确');
  if (value.subIds.some(id => !cards.some(c => c.id === id && c.kind === 'sub'))) fail('副卡不存在或类型不正确');
  const selected = [mainId, ...value.subIds].filter(Boolean).map(id => cards.find(c => c.id === id));
  if (selected.reduce((n, c) => n + Buffer.byteLength(c.content), 0) > limits.activeBytes) fail('当前组合正文过长，请减少启用的副卡');
  return { mainId, subIds: [...value.subIds] };
}
function combo(value, cards) {
  return { id: identifier(value.id), name: text(value.name, 160, '组合名称'), ...selection(value, cards) };
}
function validate(value) {
  if (value?.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.cards) || value.cards.length > limits.cards || !Array.isArray(value.combos) || value.combos.length > limits.combos) fail('人设配置格式不正确');
  const cards = value.cards.map(card), combos = value.combos.map(c => combo(c, cards));
  if (new Set(cards.map(c => c.id)).size !== cards.length || new Set(combos.map(c => c.id)).size !== combos.length) fail('卡片或组合标识重复');
  return { version: 1, revision: value.revision, cards, combos, selection: selection(value.selection, cards), legacyIds: (value.legacyIds ?? []).map(identifier) };
}

/** One instance owns its persona cards. Writes publish only after durable storage succeeds. */
export class AgentCards {
  constructor(store) { this.store = store; this.state = empty(); this.queue = Promise.resolve(); }
  mutate(fn) { const task = this.queue.then(fn); this.queue = task.catch(() => {}); return task; }
  async init() { return this.mutate(async () => { const raw = await this.store.get(REF); if (raw !== undefined) { if (Buffer.byteLength(raw) > limits.fileBytes) fail('人设配置过大'); this.state = validate(JSON.parse(raw)); } }); }
  async status() { await this.queue; return { ...structuredClone(this.state), limits }; }
  async commit(next) {
    next = validate({ ...next, revision: this.state.revision + 1 });
    const serialized = JSON.stringify(next);
    if (Buffer.byteLength(serialized) > limits.fileBytes) fail('人设库总大小超过限制，请先导出并整理卡片');
    await this.store.set(REF, serialized); this.state = next;
    return { ...structuredClone(next), limits };
  }
  restore(snapshot, revision) { return this.mutate(async () => {
    if(revision!==this.state.revision)fail('人设已变化，请刷新后重试');
    return this.commit(snapshot);
  }); }
  change(action, payload) { return this.mutate(async () => {
    if (payload?.revision !== this.state.revision) fail('人设已在其他窗口更新，请刷新后重试');
    const next = structuredClone(this.state);
    switch (action) {
      case 'card.save': {
        const c = card({ ...payload.card, id: payload.card?.id || randomUUID() });
        const existing = next.cards.find(row => row.id === c.id);
        if (existing && existing.kind !== c.kind && (next.selection.mainId === c.id || next.selection.subIds.includes(c.id) || next.combos.some(row => row.mainId === c.id || row.subIds.includes(c.id)))) fail('这张卡正在组合中使用，请先取消选择再更改类型');
        next.cards = existing ? next.cards.map(row => row.id === c.id ? c : row) : [...next.cards, c];
        break;
      }
      case 'card.delete': {
        if (!next.cards.some(c => c.id === payload.id)) fail('卡片不存在');
        next.cards = next.cards.filter(c => c.id !== payload.id);
        for (const selected of [next.selection, ...next.combos]) { if (selected.mainId === payload.id) selected.mainId = null; selected.subIds = selected.subIds.filter(id => id !== payload.id); }
        break;
      }
      case 'selection.apply': next.selection = selection(payload.selection, next.cards); break;
      case 'combo.save': {
        const row = combo({ ...payload.combo, id: payload.combo?.id || randomUUID() }, next.cards);
        const existing = next.combos.some(c => c.id === row.id);
        next.combos = existing ? next.combos.map(c => c.id === row.id ? row : c) : [...next.combos, row]; break;
      }
      case 'combo.apply': {
        const row = next.combos.find(c => c.id === payload.id); if (!row) fail('组合不存在');
        next.selection = selection(row, next.cards); break;
      }
      case 'combo.delete': {
        if (!next.combos.some(c => c.id === payload.id)) fail('组合不存在');
        next.combos = next.combos.filter(c => c.id !== payload.id); break;
      }
      case 'import': {
        if (typeof payload.text !== 'string' || Buffer.byteLength(payload.text) > limits.fileBytes) fail('导入文件过大');
        if (typeof payload.filename !== 'string' || !/\.(json|md|txt)$/i.test(payload.filename)) fail('请选择 JSON、Markdown 或 TXT 人设文件');
        let source;
        if (/\.json$/i.test(payload.filename)) {
          let data; try { data = JSON.parse(payload.text); } catch { fail('JSON 文件无法解析'); }
          if (data?.format !== 'dsh-agent-cards' || data.version !== 1) fail('请选择 DSH 导出的人设 JSON，或 Markdown/TXT 正文');
          source = validate({ ...data, revision: 0, selection: { mainId: null, subIds: [] }, legacyIds: [] });
        } else {
          source = { cards: [card({ id: randomUUID(), name: payload.name || String(payload.filename || '导入卡片').replace(/\.(md|txt)$/i, ''), kind: payload.kind, content: payload.text })], combos: [] };
        }
        const mapping = new Map(source.cards.map(c => [c.id, randomUUID()]));
        next.cards.push(...source.cards.map(c => ({ ...c, id: mapping.get(c.id) })));
        next.combos.push(...source.combos.map(c => ({ ...c, id: randomUUID(), mainId: c.mainId ? mapping.get(c.mainId) : null, subIds: c.subIds.map(id => mapping.get(id)) })));
        break;
      }
      default: fail('无效的人设操作');
    }
    return this.commit(next);
  }); }
  /** Preserve existing phone prompt edits and activation once; no duplicate injections. */
  importLegacy(rows) { return this.mutate(async () => {
    const next = structuredClone(this.state), initial = !next.cards.length && !next.legacyIds.length;
    let changed = false;
    for (const row of rows) {
      const id = 'legacy-' + createHash('sha256').update(row.key).digest('hex').slice(0, 32);
      if (next.legacyIds.includes(id)) continue;
      if (next.cards.length >= limits.cards) break;
      // A disabled, empty prompt in an old ZIP must never break phone startup.
      if (typeof row.content !== 'string' || !row.content.trim() || Buffer.byteLength(row.content) > limits.cardBytes) continue;
      next.cards.push(card({ id, name: String(row.name || '导入提示卡').slice(0, 40), kind: 'sub', content: row.content })); next.legacyIds.push(id); changed = true;
      if (initial && row.enabled && next.selection.subIds.length < limits.subCards) next.selection.subIds.push(id);
    }
    return changed ? this.commit(next) : { ...structuredClone(next), limits };
  }); }
  export() { const { cards, combos } = this.state; return { format: 'dsh-agent-cards', version: 1, cards: structuredClone(cards), combos: structuredClone(combos) }; }
  promptText() {
    const { cards, selection: selected } = this.state;
    const main = cards.find(c => c.id === selected.mainId), subs = selected.subIds.map(id => cards.find(c => c.id === id));
    if (!main && !subs.length) return '';
    const sections = [];
    if (main) sections.push(`主卡：${main.name}\n${main.content}`);
    sections.push(...subs.map(c => `副卡：${c.name}\n${c.content}`));
    return '用户配置的 Agent 角色与工作约定。主卡定义基础角色，副卡补充工作方式；这些约定保留已有工具、权限和安全要求，结合用户本轮明确任务使用。\n\n' + sections.join('\n\n');
  }
}
