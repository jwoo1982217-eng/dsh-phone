'use strict';
const $ = id => document.getElementById(id);
let state, busy = false;
const node = (tag, text) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; return el; };
const labels = { pending: '等待手机确认', approved: '已批准', running: '正在执行', done: '已完成', rejected: '已拒绝', stopped: '已停止', expired: '已过期', failed: '失败', cancelled: '已撤销', unknown: '结果未知', online: '已连接', offline: '已断开', created: '已建立', revoked: '已撤销' };
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
async function rpc(action, data = {}) {
  const response = await fetch('/phone-tools/manage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload: { action, ...data } }) });
  let envelope; try { envelope = await response.json(); } catch { throw Error('手机工具箱未连接，请从已登录的设置页打开'); }
  if (!response.ok || !envelope.result?.ok) throw Error(envelope.result?.error?.message || '手机工具箱未连接，请从已登录的设置页打开');
  return envelope.result.value;
}
async function work(fn) {
  if (busy) return; busy = true;
  try { await fn(); } catch (error) { notice(error.message, true); } finally { busy = false; }
}
function button(label, action) { const b = node('button', label); b.onclick = () => work(action); return b; }
async function confirmDetails(title, detail) {
  $('confirm-title').textContent = title; $('confirm-content').textContent = typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2);
  const dialog = $('confirm'); dialog.returnValue = ''; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}
function choices(id, items, checked) {
  $(id).replaceChildren();
  for (const item of items) {
    const label = node('label'), input = node('input'); input.type = 'checkbox'; input.value = item.id; input.checked = checked.includes(item.id); label.className = 'choice';
    label.append(input, node('span', item.title + '：' + item.description)); $(id).append(label);
  }
  if (!items.length) $(id).append(node('p', '暂无可共享内容。'));
}
function render(value, preserve = false) {
  state = value;
  $('connection').textContent = value.error || (!value.paired ? '尚未配对。先准备可达的中继，再建立配对。' : !value.enabled ? '已配对，连接已暂停。' : value.online ? '手机已连接外部 AI 工具连接器。' : '等待工具连接器；请保持手机服务运行。');
  if (!preserve) { $('relay').value = value.relay; $('enabled').checked = value.enabled; choices('skills', value.skills, value.skillIds); choices('tools', value.tools, value.toolIds); }
  $('tasks').replaceChildren();
  for (const t of value.tasks) {
    const article = node('article'); article.append(node('strong', t.title), node('p', `${labels[t.status] || t.status} · ${t.minutes} 分钟 · App：${t.packages.join('、') || '无'}`));
    if (t.status === 'pending') {
      article.append(button('查看并批准', async () => { if (await confirmDetails('批准此工具任务', { task: t.title, minutes: t.minutes, packages: t.packages, scope: '独立任务目录；写文件和脚本逐次确认，App 另需原生批准' })) render(await rpc('task.approve', { id: t.taskId, allow: true }), true); }), button('拒绝', async () => render(await rpc('task.approve', { id: t.taskId, allow: false }), true)));
    } else article.append(button('停止此任务', async () => render(await rpc('task.stop', { id: t.taskId }), true)));
    $('tasks').append(article);
  }
  if (!value.tasks.length) $('tasks').append(node('p', '暂无任务申请。'));
  $('operations').replaceChildren();
  for (const o of value.operations) {
    const article = node('article'); article.append(node('strong', o.kind === 'write' ? '写入文件' : '运行本地工具'), node('p', (o.title || '') + ' · ' + (labels[o.status] || o.status)));
    if (o.status === 'pending') article.append(button('核对本次操作', async () => { if (await confirmDetails('批准这一次操作', o.detail)) render(await rpc('operation.approve', { id: o.operationId, allow: true }), true); }), button('拒绝', async () => render(await rpc('operation.approve', { id: o.operationId, allow: false }), true)));
    $('operations').append(article);
  }
  if (!value.operations.length) $('operations').append(node('p', '暂无待确认操作。'));
  $('receipts').replaceChildren();
  for (const receipt of value.receipts || []) {
    const details = node('details'); details.append(node('summary', (receipt.kind === 'write' ? '文件写入' : '本地工具') + ' · ' + (labels[receipt.status] || receipt.status)), node('pre', JSON.stringify(receipt.result ?? { status: receipt.status }, null, 2))); $('receipts').append(details);
  }
  $('events').replaceChildren(...value.events.slice(0, 15).map(e => node('p', new Date(e.at).toLocaleTimeString() + ' · ' + ({ task: '任务', connection: '连接', pair: '配对', write: '文件写入', run: '本地工具' }[e.kind] || e.kind) + ' · ' + (labels[e.status] || e.status))));
}
$('pair').onclick = () => work(async () => { if (await confirmDetails('建立新配对', '旧工具连接与任务授权会撤销。确认中继地址：' + $('relay').value)) { render(await rpc('pair', { relay: $('relay').value })); notice('新配对已建立，显示链接并保存到连接器所在的电脑或服务器。'); } });
$('export').onclick = () => work(async () => { const out = await rpc('export'); $('pair-link').value = out.link; $('pair-output').hidden = false; });
$('hide').onclick = () => { $('pair-link').value = ''; $('pair-output').hidden = true; };
$('revoke').onclick = () => work(async () => { if (await confirmDetails('撤销配对', '断开工具连接并停止全部工具任务，旧链接失效。')) { render(await rpc('revoke')); $('hide').click(); } });
$('save').onclick = () => work(async () => { const selected = id => [...$(id).querySelectorAll('input:checked')].map(i => i.value); render(await rpc('configure', { enabled: $('enabled').checked, skillIds: selected('skills'), toolIds: selected('tools') })); notice('已保存；更改范围会撤销已有工具任务。'); });
$('refresh').onclick = () => work(async () => render(await rpc('status')));
$('import-tool').onchange = () => work(async () => {
  try {
    const file = $('import-tool').files[0]; if (!file) return;
    if (file.size > 180000) throw Error('工具 JSON 最多180 KB');
    const bundle = JSON.parse(await file.text());
    if (await confirmDetails('只导入你信任的工具；脚本拥有 DSH App 权限', bundle)) { render(await rpc('tool.import', { bundle })); notice('工具已导入，勾选并保存后外部 AI 才能申请使用。'); }
  } finally { $('import-tool').value = ''; }
});
void work(async () => render(await rpc('status')));
setInterval(() => { if (!busy && !$('confirm').open && document.visibilityState === 'visible') void work(async () => render(await rpc('status'), true)); }, 3000);
window.addEventListener('pagehide', () => $('hide').click());
