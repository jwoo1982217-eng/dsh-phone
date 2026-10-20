'use strict';
const $ = id => document.getElementById(id), node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
let state, selectedId = '', busy = false;
const labels = { queued: '服务器已接收，等待执行', running: '服务器正在执行', started: '任务已提交', stopping: '正在请求停止', completed: '已完成', failed: '执行失败', cancelled: '已停止', interrupted: '服务器中断', waiting_for_approval: '等待服务器确认', submission_unknown: '提交结果未知' };
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
async function rpc(action, args = {}) {
  const response = await fetch('/hermes-remote/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload: { action, ...args } }) });
  let envelope; try { envelope = await response.json(); } catch { throw Error('请从手机 DSH 已登录的页面打开 Hermes'); }
  if (!response.ok || !envelope.result?.ok) throw Error(envelope.result?.error?.message || 'Hermes 操作未完成'); return envelope.result.value;
}
async function work(fn) { if (busy) return; busy = true; if (state) controls(); else { $('send').disabled = true; $('conversations').disabled = true; } try { await fn(); } catch (e) { notice(e.message, true); } finally { busy = false; if (state) controls(); } }
function controls() {
  $('conversations').disabled = busy;
  for (const id of ['save','check','disconnect','refresh','name','server','key','message']) $(id).disabled = busy;
  const c = state.conversations.find(c => c.id === selectedId), active = c?.run && !['completed','failed','cancelled','interrupted'].includes(c.run.status);
  $('send').disabled = busy || !c?.available || active; $('create').disabled = busy || !state.configured; $('stop').disabled = busy || !c?.available || !active || !c.run.id;
  const approval = c?.run?.approval;
  $('approve-once').disabled = busy || !c?.available || !approval?.request_id || !approval.choices?.includes('once'); $('deny').disabled = busy || !c?.available || !approval?.request_id || !approval.choices?.includes('deny');
}
function render(value, config = false) {
  state = value; if (value.selectedId) selectedId = value.selectedId;
  if (config) { $('server').value = value.config.baseUrl; $('name').value = value.config.name; $('key').value = ''; $('key').placeholder = value.config.hasKey ? '已保存；留空保留密钥' : '服务器的 API_SERVER_KEY'; }
  $('connection').textContent = value.error || (!value.configured ? '尚未配置自己的 Hermes 服务器。' : value.checked ? '已核对 Hermes 接口 · 服务：' + (value.checked.model || 'Hermes') : '连接已保存，点击「检查连接」核对服务。');
  const select = $('conversations'); select.replaceChildren(node('option', '选择或新建 Hermes 对话')); select.firstChild.value = '';
  for (const c of value.conversations) { const o = node('option', c.title + (c.available ? '' : '（另一连接）')); o.value = c.id; select.append(o); } select.value = selectedId;
  const c = value.conversations.find(c => c.id === selectedId); $('messages').replaceChildren();
  for (const m of c?.messages || []) { const article = node('article'); article.className = m.role; article.append(node('strong', m.role === 'user' ? '你' : 'Hermes'), node('p', m.text)); $('messages').append(article); }
  $('run-state').textContent = c?.run ? (labels[c.run.status] || c.run.status) + (c.run.error ? ' · ' + c.run.error : '') + (c.run.runtime?.model ? ' · 实际模型：' + c.run.runtime.model : '') : '模型和任务在你的 Hermes 服务器上运行。';
  $('recovery').hidden = !c?.run?.recoverable; $('approval').hidden = c?.run?.status !== 'waiting_for_approval'; $('approval-detail').textContent = c?.run?.approval ? JSON.stringify(c.run.approval, null, 2) : '';
  controls();
}
async function confirm(title, text) { $('confirm-title').textContent = title; $('confirm-detail').textContent = text; const d = $('confirm'); d.returnValue = ''; d.showModal(); return new Promise(resolve => d.addEventListener('close', () => resolve(d.returnValue === 'ok'), {once:true})); }
$('save').onclick = () => work(async () => { render(await rpc('configure', { baseUrl: $('server').value, name: $('name').value, key: $('key').value }), true); notice('连接已保存，请检查连接。'); });
$('check').onclick = () => work(async () => { render(await rpc('check')); notice('Hermes 接口检查通过，可以新建对话。'); });
$('create').onclick = () => work(async () => { render(await rpc('create')); notice('新对话已建立，发送时只使用服务器的模型和上下文。'); });
$('send').onclick = () => work(async () => { const text = $('message').value; render(await rpc('send', { id: selectedId, text })); $('message').value = ''; notice('已记录请求，请等待或刷新任务状态。'); });
$('refresh').onclick = () => work(async () => render(await rpc(selectedId ? 'refresh' : 'status', { id: selectedId })));
$('stop').onclick = () => work(async () => { if (await confirm('停止服务器任务', '已完成的文件写入等操作不会自动撤销。确认向服务器请求停止？')) render(await rpc('stop', { id: selectedId })); });
for (const [button, choice] of [['approve-once','once'], ['deny','deny']]) $(button).onclick = () => work(async () => {
  const approval = state.conversations.find(c => c.id === selectedId)?.run?.approval;
  if (approval && await confirm(choice === 'once' ? '批准服务器这一次操作' : '拒绝服务器这一次操作', JSON.stringify(approval, null, 2))) render(await rpc('approve', { id: selectedId, requestId: approval.request_id, choice }));
});
$('recover').onclick = () => work(async () => { if (await confirm('恢复原任务', '使用相同消息和编号向支持持久去重的原服务器核对任务。不会生成新编号；请先确认原服务器没有更换或清空状态库。')) render(await rpc('recover', { id: selectedId })); });
$('disconnect').onclick = () => work(async () => { if (await confirm('移除本机连接', '本机忘记连接密钥，保留 Hermes 对话记录。服务器任务仍可能运行；如需停止，请先停止并核对结果。')) { render(await rpc('disconnect'), true); notice('已移除本机连接。'); } });
$('conversations').onchange = () => { selectedId = $('conversations').value; render(state); };
void work(async () => render(await rpc('status'), true));
setInterval(() => { const c = state?.conversations.find(c => c.id === selectedId); if (!busy && !$('confirm').open && document.visibilityState === 'visible' && c?.available && c.run?.id && !['completed','failed','cancelled','interrupted'].includes(c.run.status)) void work(async () => render(await rpc('refresh', { id: selectedId }))); }, 2500);
window.addEventListener('pagehide', () => { $('key').value = ''; });
