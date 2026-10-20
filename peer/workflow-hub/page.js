const $ = id => document.getElementById(id), pluginMode = location.pathname.startsWith('/plugin-center');
let state, busy = false;
const initial = new URLSearchParams(location.search); $('package').value = initial.get('name') || ''; $('version').value = initial.get('version') || '';
async function manage(payload) {
  const route = pluginMode ? '/plugin-center' : '/workflow-hub';
  const response = await fetch(route + '/manage', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload }) });
  if (!response.ok) throw Error('请返回 DSH 刷新后重新打开');
  const result = (await response.json()).result; if (!result?.ok) throw Error(result?.error?.message || '请求未完成'); return result.value;
}
function part(parent, tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; parent.append(element); return element; }
async function action(payload) {
  if (busy) return; busy = true; document.querySelectorAll('button').forEach(x => { x.disabled = true; }); $('notice').textContent = '正在处理，请稍候…';
  try {
    const result = await manage(payload); await load();
    if (result.application) $('notice').textContent = result.application === 'applied' ? '操作已保存并生效。' : result.application === 'restart-required' ? '已保存，重启 DSH 后生效。' : '状态：' + result.application + (result.error ? ' · ' + result.error.code : '');
  } catch (error) { const message = error.message; await load(); $('notice').textContent = message; }
  finally { busy = false; document.querySelectorAll('#refresh, #package-form button, #feishu-form button').forEach(button => { button.disabled = false; }); }
}
async function load() {
  try {
    state = await manage({ action: 'status' }); $('target').textContent = '当前目标：' + (state.role === 'phone' ? '手机本机' : '这台电脑'); $('items').replaceChildren();
    $('title').textContent = pluginMode ? '插件安装与管理' : 'Preset 工作流广场'; $('install').hidden = !pluginMode || state.role !== 'computer'; $('help').hidden = pluginMode; $('feishu').hidden = pluginMode;
    for (const row of pluginMode ? state.bundles : state.workflows) {
      const article = document.createElement('article'); part(article, 'h2', row.name); part(article, 'p', row.description || '');
      part(article, 'p', pluginMode ? (row.version ? row.version + ' · ' : '') + (row.enabled ? '已启用' : '已停用') + (row.error ? ' · ' + row.error.code : '') : (row.enabled ? '已启用' : '已停用') + (row.broken ? ' · 加载失败：' + row.broken : ''), 'status');
      if (!pluginMode) {
        part(article, 'p', '技能：' + row.skills.join('、')); part(article, 'p', row.readiness.note);
        part(article, 'p', row.readiness.missing.length ? '需配置：' + row.readiness.missing.join('、') + '；目前可准备资料。' : '工作流工具已挂载；任务执行时仍需核对输入和外部服务。');
        const toggle = part(article, 'button', row.enabled ? '停用工作流' : '启用工作流'); toggle.addEventListener('click', () => action({ action: 'toggle', id: row.id, enabled: !row.enabled, revision: state.revision }));
      } else {
        const protectedRow = row.readOnlyReason || /^(?:@deepseek-ai\/dsh(?:-|$)|dsh-(?:peer|phone-qq|phone-account|codearts-auth|phone-control|phone-cloud-tools|desktop-chatgpt)$|@zseven-w\/dsh-noema$)/.test(row.name);
        const toggle = part(article, 'button', protectedRow ? '内置组件受保护' : row.enabled ? '停用' : '启用'); toggle.disabled = !!protectedRow; toggle.addEventListener('click', () => action({ action: 'toggle', name: row.name, enabled: !row.enabled }));
        if (row.removable && !protectedRow) { const remove = part(article, 'button', '卸载'); remove.addEventListener('click', () => { if (confirm('卸载 ' + row.name + '？插件自身保存的数据会保留。')) void action({ action: 'remove', name: row.name }); }); }
        if (state.role === 'computer' && !protectedRow) { const update = part(article, 'button', '检查指定版本更新'); update.addEventListener('click', () => { $('package').value = row.name; $('version').value = ''; $('version').focus(); }); }
      }
      $('items').append(article);
    }
    $('notice').textContent = pluginMode ? '安装前检查版本与入口；核心、账号和设备连接组件保留。' : '7 套工作流已接入，启用后可在新对话中选择。';
  } catch (error) { $('notice').textContent = error.message; }
}
$('refresh').addEventListener('click', () => void load());
$('feishu-form').addEventListener('submit', async event => {
  event.preventDefault();
  const values = { FEISHU_APP_ID: $('feishu-id').value, FEISHU_APP_SECRET: $('feishu-secret').value, FEISHU_DEFAULT_OPEN_ID: $('feishu-owner').value };
  $('feishu-secret').value = ''; await action({ action: 'configure-feishu', values });
});
$('package-form').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return; busy = true; $('preview').replaceChildren(); $('notice').textContent = '正在核对固定版本与当前运行时…';
  try {
    const plan = await manage({ action: 'inspect', name: $('package').value.trim(), version: $('version').value.trim() });
    part($('preview'), 'p', plan.name + '@' + plan.version + '\n' + plan.description);
    const install = part($('preview'), 'button', '确认安装 / 更新'); install.addEventListener('click', () => {
      if (confirm('安装 ' + plan.name + '@' + plan.version + ' 到这台电脑？第三方插件会在 DSH 中运行。')) { install.disabled = true; void action({ action: 'install', name: plan.name, ticket: plan.ticket }); }
    }); $('notice').textContent = '版本和插件入口检查通过，请确认安装。';
  } catch (error) { $('notice').textContent = error.message; } finally { busy = false; }
});
void load();
