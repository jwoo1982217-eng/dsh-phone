'use strict';
const $ = id => document.getElementById(id);
let state, editing = null, busy = false;
const node = (tag, content, cls) => { const el = document.createElement(tag); if (content !== undefined) el.textContent = content; if (cls) el.className = cls; return el; };
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
async function rpc(action, data = {}) {
  const response = await fetch('/agent-cards/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random(), method: 'manage', payload: { action, ...data } }) });
  let envelope; try { envelope = await response.json(); } catch { throw Error('人设页面未连接，请从已登录的 DSH 设置中重新打开'); }
  const result = envelope.result;
  if (!response.ok || !result?.ok) throw Error(result?.error?.message || '人设操作未完成，请刷新后重试');
  return result.value;
}
async function task(fn) {
  if (busy) return; busy = true;
  document.querySelectorAll('button').forEach(b => b.disabled = true);
  try { await fn(); } catch (error) { notice(error.message, true); }
  finally { busy = false; document.querySelectorAll('button').forEach(b => b.disabled = false); }
}
const button = (label, handler, cls) => { const el = node('button', label, cls); el.type = 'button'; el.onclick = () => task(handler); return el; };
const selected = () => ({ mainId: $('main-card').value || null, subIds: [...document.querySelectorAll('#sub-choices input:checked')].map(el => el.value) });
const labelFor = id => state.cards.find(c => c.id === id)?.name || '未选择';
function preview() {
  const selection = selected(); $('sub-count').textContent = `${selection.subIds.length} / ${state.limits.subCards}`;
  $('selection-preview').textContent = `主卡：${selection.mainId ? labelFor(selection.mainId) : '未选择'}；副卡：${selection.subIds.map(labelFor).join('、') || '未选择'}`;
}
async function confirmed(message) {
  $('confirm-text').textContent = message;
  return new Promise(resolve => { const dialog = $('confirm'); dialog.returnValue = ''; dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }); dialog.showModal(); dialog.querySelectorAll('button').forEach(b => b.disabled = false); });
}
function edit(card, kind = 'sub') {
  editing = card?.id || null; $('editor-title').textContent = card ? '编辑人设卡' : '新增人设卡';
  $('card-name').value = card?.name || ''; $('card-kind').value = card?.kind || kind; $('card-content').value = card?.content || '';
  $('editor').hidden = false; $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('card-name').focus({ preventScroll: true });
}
function render(value) {
  state = value; $('main-card').replaceChildren(node('option', '不使用主卡')); $('main-card').firstChild.value = '';
  for (const c of state.cards.filter(c => c.kind === 'main')) { const option = node('option', c.name); option.value = c.id; $('main-card').append(option); }
  $('main-card').value = state.selection.mainId || ''; $('sub-choices').replaceChildren();
  for (const c of state.cards.filter(c => c.kind === 'sub')) {
    const label = node('label', undefined, 'choice'), input = node('input'); input.type = 'checkbox'; input.value = c.id; input.checked = state.selection.subIds.includes(c.id);
    input.onchange = () => { if (selected().subIds.length > state.limits.subCards) { input.checked = false; notice(`最多同时启用 ${state.limits.subCards} 张副卡`, true); } preview(); };
    label.append(input, node('span', c.name)); $('sub-choices').append(label);
  }
  if (!$('sub-choices').children.length) $('sub-choices').append(node('p', '还没有副卡，点击“新增副卡”创建。', 'muted'));
  $('cards').replaceChildren();
  for (const c of state.cards) {
    const row = node('article', undefined, 'row'), head = node('div', undefined, 'row-head'), actions = node('div', undefined, 'actions');
    head.append(node('strong', c.name), node('span', c.kind === 'main' ? '主卡' : '副卡', 'badge'));
    actions.append(button('编辑', async () => edit(c)), button('删除', async () => { if (await confirmed(`删除“${c.name}”？它会从当前组合和已保存组合中移除。`)) { render(await rpc('card.delete', { id: c.id, revision: state.revision })); if (editing === c.id) $('editor').hidden = true; notice('卡片已删除。'); } }, 'danger'));
    row.append(head, node('p', c.content), actions); $('cards').append(row);
  }
  if (!state.cards.length) $('cards').append(node('p', '还没有人设卡。可以新建，也可以导入文件。', 'muted'));
  $('combos').replaceChildren();
  for (const c of state.combos) {
    const row = node('article', undefined, 'row'), actions = node('div', undefined, 'actions');
    const current = c.mainId === state.selection.mainId && JSON.stringify(c.subIds) === JSON.stringify(state.selection.subIds);
    actions.append(button(current ? '重新应用' : '一键应用', async () => { render(await rpc('combo.apply', { id: c.id, revision: state.revision })); notice(`已应用“${c.name}”，下一次请求生效。`); }, 'primary'),
      button('用当前选择更新', async () => { render(await rpc('combo.save', { combo: { ...c, ...selected() }, revision: state.revision })); notice('组合已更新；点击“一键应用”即可启用。'); }),
      button('删除', async () => { if (await confirmed(`删除组合“${c.name}”？卡片正文和当前已应用选择会保留。`)) { render(await rpc('combo.delete', { id: c.id, revision: state.revision })); notice('组合已删除。'); } }, 'danger'));
    row.append(node('strong', c.name + (current ? ' · 当前组合' : '')), node('p', `主卡：${c.mainId ? labelFor(c.mainId) : '未选择'}\n副卡：${c.subIds.map(labelFor).join('、') || '未选择'}`), actions); $('combos').append(row);
  }
  if (!state.combos.length) $('combos').append(node('p', '选好主卡、副卡并填写名称，即可保存组合。', 'muted'));
  preview();
}
$('refresh').onclick = () => task(async () => { render(await rpc('status')); notice('已刷新。'); });
$('main-card').onchange = preview;
$('new-main').onclick = () => edit(null, 'main'); $('new-sub').onclick = () => edit(null, 'sub');
$('cancel-edit').onclick = () => { editing = null; $('editor').hidden = true; };
$('card-form').onsubmit = event => { event.preventDefault(); task(async () => {
  render(await rpc('card.save', { card: { id: editing, name: $('card-name').value, kind: $('card-kind').value, content: $('card-content').value }, revision: state.revision }));
  editing = null; $('editor').hidden = true; notice('卡片已保存。选择它并应用组合即可启用。');
}); };
$('apply-selection').onclick = () => task(async () => { render(await rpc('selection.apply', { selection: selected(), revision: state.revision })); notice('当前组合已应用，下一次请求生效。'); });
$('clear-selection').onclick = () => task(async () => { render(await rpc('selection.apply', { selection: { mainId: null, subIds: [] }, revision: state.revision })); notice('已停用人设卡。已有聊天内容仍保留。'); });
$('save-combo').onclick = () => task(async () => { render(await rpc('combo.save', { combo: { name: $('combo-name').value, ...selected() }, revision: state.revision })); $('combo-name').value = ''; notice('组合已保存，点击“一键应用”即可启用。'); });
$('import-file').onchange = () => task(async () => {
  const file = $('import-file').files[0]; if (!file) return;
  if (file.size > state.limits.fileBytes) throw Error('人设文件最多 512 KB');
  render(await rpc('import', { text: await file.text(), filename: file.name, kind: $('import-kind').value, revision: state.revision })); $('import-file').value = ''; notice('已导入，当前组合保持原样。');
});
$('export').onclick = () => task(async () => {
  if (/Android/i.test(navigator.userAgent) && /\bwv\b/i.test(navigator.userAgent)) { window.top.location.href = 'dsh-phone://cards/export'; notice('请在系统文件窗口选择人设 JSON 的保存位置。'); return; }
  const value = await rpc('export'), blob = new Blob([JSON.stringify(value, null, 2) + '\n'], { type: 'application/json' }), url = URL.createObjectURL(blob), link = node('a');
  link.href = url; link.download = 'DSH-Agent人设卡.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); notice('已导出人设卡库与组合。');
});
task(async () => { render(await rpc('status')); notice('已载入。选择组合后点击应用。'); });
