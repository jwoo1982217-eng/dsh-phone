const $ = id => document.getElementById(id);
const native = /Android/.test(navigator.userAgent) && /\bwv\b/.test(navigator.userAgent);
let page = 0, pending = false, deferred = false, loadedCategories = false, timer, refreshTimer;
let state, runtime, runtimeError = '', busy = false, returnFocus;
const feedback = new Map();
async function rpc(route, payload) {
  const response = await fetch(route + '/manage', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID?.() ?? String(Date.now()) + Math.random(), method: 'manage', payload }) });
  if (!response.ok) throw Error('连接已中断，请返回 DSH 刷新后重新打开市场');
  const result = (await response.json()).result;
  if (!result?.ok) throw Error(result?.error?.message || '操作未完成');
  return result.value;
}
const manage = payload => rpc('/controlled-market', payload);
const pluginManage = payload => rpc('/plugin-center', payload);
function part(parent, tag, text, className) {
  const element = document.createElement(tag); if (text !== undefined) element.textContent = text;
  if (className) element.className = className; parent.append(element); return element;
}
function installed(row) { return runtime?.bundles?.find(bundle => bundle.name === row.npm && (bundle.installed || bundle.enabled)); }
function protectedRow(row) { return row.protected === true || /^(?:@deepseek-ai\/dsh(?:-|$)|dsh-(?:peer|phone-qq|phone-account|codearts-auth|phone-control|phone-cloud-tools|desktop-chatgpt)$|@zseven-w\/dsh-noema$)/.test(row.npm || ''); }
function cardAction(row) {
  const bundle = installed(row), protectedPlugin = protectedRow(row) || bundle?.readOnlyReason;
  if (protectedPlugin) return { label: '内置组件', disabled: true };
  if (state.role === 'phone') {
    if (!native) return { label: '请在手机 App 中安装', disabled: true };
    if (!row.canTrial || row.deprecated) return { label: '暂不可安装', disabled: true };
    if (!state.trialEnabled) return { label: '先开启上方允许试装', disabled: true };
    if (bundle && (!row.version || bundle.version === row.version)) return { label: bundle.enabled ? '已安装' : '启用插件', disabled: !!bundle.enabled, enable: !bundle.enabled };
    return { label: bundle ? '备份后更换版本' : '备份后安装到手机' };
  }
  if (runtimeError) return { label: '安装服务暂不可用', disabled: true };
  if (!row.npm || !row.version || row.deprecated) return { label: '暂无可安装版本', disabled: true };
  if (bundle?.version === row.version) return { label: bundle.enabled ? '已安装' : '启用插件', disabled: !!bundle.enabled, enable: !bundle.enabled };
  return { label: bundle ? '安装 v' + row.version : '一键安装到电脑' };
}
function setFeedback(row, message, error = false) { feedback.set(row.url, { message, error }); $('notice').textContent = message; render(); }
function render() {
  if (!state) return;
  $('plugins').replaceChildren();
  for (const [index, row] of state.plugins.entries()) {
    const article = part($('plugins'), 'article', undefined, 'plugin-card'); article.dataset.name = row.name;
    part(article, 'span', String(page * state.pageSize + index + 1), 'rank');
    const initials = row.name.replace(/^@[^/]+\//, '').replace(/^dsh[-_]/, '').slice(0, 2).toUpperCase();
    const avatar = part(article, 'div', initials, 'avatar'); avatar.setAttribute('aria-hidden', 'true');
    const body = part(article, 'div', undefined, 'card-body'), title = part(body, 'div', undefined, 'title-row');
    part(title, 'h2', row.name);
    if (row.version) part(title, 'span', 'v' + row.version, 'badge version');
    const bundle = installed(row);
    if (bundle) part(title, 'span', bundle.error ? '加载异常' : bundle.enabled ? '已安装' : '已停用', 'badge ' + (bundle.error ? 'orange' : 'green'));
    if (row.deprecated) part(title, 'span', '作者已弃用', 'badge orange');
    const badges = part(body, 'div', undefined, 'badges');
    part(badges, 'span', '☆ GitHub ' + row.stars.toLocaleString(), 'badge blue');
    for (const category of row.category) part(badges, 'span', state.categories[category] || category, 'badge');
    if (state.role === 'phone' && !protectedRow(row)) part(badges, 'span', 'Android 待验证', 'badge orange');
    const description = part(body, 'div', undefined, 'description'); part(description, 'span', '✧', 'description-icon');
    part(description, 'span', row.description || '作者暂未提供介绍，可在详情中查看项目源码。');
    const metadata = part(body, 'div', undefined, 'metadata');
    part(metadata, 'span', '作者：' + (row.owner || '未提供'));
    if (bundle?.version) part(metadata, 'span', '当前 v' + bundle.version);
    if (protectedRow(row)) part(metadata, 'span', '随应用提供');
    else part(metadata, 'span', row.npm && row.version ? '安装前检查兼容性' : '从源码详情了解发布方式');
    const actions = part(article, 'div', undefined, 'card-actions'), action = cardAction(row);
    const install = part(actions, 'button', action.label, 'primary'); install.disabled = !!action.disabled || busy || !!runtime?.busy;
    install.addEventListener('click', () => void beginInstall(row, action));
    const details = part(actions, 'button', '详情 →', 'secondary'); details.disabled = busy;
    details.addEventListener('click', () => showDetails(row));
    const note = feedback.get(row.url);
    if (note) part(article, 'p', note.message, 'card-feedback' + (note.error ? ' error' : '')).setAttribute('role', 'status');
  }
  if (!state.plugins.length) part($('plugins'), 'div', '没有找到匹配的插件，试试其他关键词或分类。', 'empty');
}
function openDialog(title) {
  returnFocus = document.activeElement; $('dialog-title').textContent = title;
  $('dialog-content').replaceChildren(); $('dialog-actions').replaceChildren();
  $('modal').hidden = false; document.body.classList.add('modal-open'); $('dialog').focus();
}
function closeDialog() {
  $('modal').hidden = true; document.body.classList.remove('modal-open');
  if (returnFocus?.isConnected) returnFocus.focus();
}
function detailField(list, label, value) { part(list, 'dt', label); return part(list, 'dd', value); }
function showDetails(row) {
  openDialog(row.name);
  part($('dialog-content'), 'p', row.description || '作者暂未提供介绍。');
  const fields = part($('dialog-content'), 'dl');
  detailField(fields, '安装目标', state.target); detailField(fields, '作者', row.owner || '未提供');
  detailField(fields, '目录版本', row.version ? 'v' + row.version : '未提供固定发布版本');
  detailField(fields, '当前版本', installed(row)?.version ? 'v' + installed(row).version : '尚未安装');
  detailField(fields, '分类', row.category.map(category => state.categories[category] || category).join('、') || '未分类');
  detailField(fields, '兼容检查', protectedRow(row) ? '已内置的适配组件，随应用更新' : state.role === 'phone' ? '安装前检查 Android / ARM64 和 DSH 版本；先自动备份' : '安装前检查当前电脑平台和 DSH 版本');
  const source = part(detailField(fields, '项目源码', ''), 'a', row.url); source.href = row.url; source.target = '_blank'; source.rel = 'noopener noreferrer';
  const action = cardAction(row);
  if (!action.disabled) { const install = part($('dialog-actions'), 'button', action.label, 'primary'); install.disabled = busy || !!runtime?.busy; install.addEventListener('click', () => { closeDialog(); void beginInstall(row, action); }); }
  const done = part($('dialog-actions'), 'button', '关闭', 'secondary'); done.addEventListener('click', closeDialog);
}
function confirmInstall(row, plan, enable) {
  return new Promise(resolve => {
    openDialog(enable ? '启用 ' + row.name : '安装 ' + row.name);
    const fields = part($('dialog-content'), 'dl');
    detailField(fields, '安装目标', state.target); detailField(fields, '插件', plan.name);
    detailField(fields, '固定版本', 'v' + plan.version);
    if (installed(row)?.version && !enable) detailField(fields, '当前版本', 'v' + installed(row).version);
    part($('dialog-content'), 'p', enable ? '启用后，插件将参与当前 DSH 的运行。' : '兼容检查通过。确认后会下载并启用这个版本，安装结果会显示在卡片上。');
    part($('dialog-content'), 'p', '第三方插件可以访问 DSH 的文件与账号数据，请确认你信任这个插件。');
    const cancel = part($('dialog-actions'), 'button', '取消', 'secondary'), confirm = part($('dialog-actions'), 'button', enable ? '确认启用' : '确认安装', 'primary');
    let settled = false;
    function finish(accepted) { if (settled) return; settled = true; $('modal').removeEventListener('market-close', cancelled); closeDialog(); resolve(accepted); }
    function cancelled() { finish(false); }
    $('modal').addEventListener('market-close', cancelled);
    cancel.addEventListener('click', cancelled); confirm.addEventListener('click', () => finish(true));
  });
}
function dismissDialog() { $('modal').dispatchEvent(new Event('market-close')); closeDialog(); }
function changeMessage(result) {
  if (!result || result.application === 'failed' || result.application === 'cancelled') throw Error(result?.error?.diagnostic || (result?.application === 'cancelled' ? '安装已取消' : '安装未完成，请在已安装插件中查看原因并重试'));
  const warnings = result.warnings?.length ? '；' + result.warnings.join('；') : '';
  if (result.application === 'restart-required') return '安装已保存，重启 DSH 后生效' + warnings;
  if (result.application === 'overridden') return '安装已保存，但启用状态被其他设置覆盖，请查看已安装插件' + warnings;
  if (result.application !== 'applied') throw Error('安装状态暂未确认，请刷新已安装插件列表');
  return '已安装并启用' + warnings;
}
async function refreshRuntime() {
  try { runtime = await pluginManage({ action: 'status' }); runtimeError = ''; }
  catch (error) { runtime = null; runtimeError = error.message; }
}
async function beginInstall(row, action) {
  if (busy || runtime?.busy || action.disabled) return;
  busy = true; clearTimeout(refreshTimer); render();
  try {
    if (state.role === 'phone' && !action.enable) {
      setFeedback(row, '正在检查固定版本和手机兼容性…');
      const plan = await manage({ action: 'trial-prepare', name: row.name, url: row.url });
      setFeedback(row, '已检查 ' + plan.name + '@' + plan.version + '，请在手机窗口确认备份和安装。');
      window.top.location.href = 'dsh-phone://market/install?ticket=' + plan.ticket;
    } else {
      setFeedback(row, action.enable ? '正在准备启用插件…' : '正在检查版本和兼容性…');
      const plan = action.enable ? { name: row.npm, version: installed(row).version } : await pluginManage({ action: 'inspect', name: row.npm, version: row.version });
      if (!await confirmInstall(row, plan, action.enable)) { setFeedback(row, '已取消，插件未改变。'); return; }
      setFeedback(row, action.enable ? '正在启用插件…' : '正在下载并安装，请稍候…');
      const result = await pluginManage(action.enable ? { action: 'toggle', name: plan.name, enabled: true } : { action: 'install', name: plan.name, ticket: plan.ticket });
      const message = changeMessage(result); await refreshRuntime();
      setFeedback(row, action.enable && result.application === 'applied' ? '已启用' : message);
    }
  } catch (error) { await refreshRuntime(); setFeedback(row, error.message, true); }
  finally { busy = false; render(); if (deferred || state?.refreshing) { deferred = false; void load(); } }
}
async function load(refresh = false) {
  if (pending || busy) { deferred = true; return; }
  clearTimeout(refreshTimer); pending = true; $('notice').textContent = '正在读取社区目录…';
  try {
    const [catalog] = await Promise.all([manage({ action: 'catalog', query: $('query').value, category: $('category').value, page, refresh }), refreshRuntime()]);
    state = catalog; page = state.page;
    $('target').textContent = '当前目标：' + state.target;
    $('intro').textContent = state.role === 'phone' ? '找到适合你的插件。手机安装前自动备份，可以随时从恢复页撤回。' : '找到适合你的插件，直接在卡片上检查、确认并安装到这台电脑。';
    $('trial-control').hidden = state.role !== 'phone' || !native; $('trial').checked = state.trialEnabled === true;
    $('recover').hidden = state.role !== 'phone' || !native; $('computer').hidden = state.role !== 'phone';
    $('computer').href = native ? 'dsh-phone://market/computer' : 'http://127.0.0.1:3081/controlled-market'; $('computer').target = '_top';
    $('builtins').hidden = !state.builtins.length;
    $('builtins').textContent = '已内置：' + state.builtins.join('、');
    if (!loadedCategories) { for (const [value, label] of Object.entries(state.categories)) { const option = part($('category'), 'option', label); option.value = value; } loadedCategories = true; }
    render();
    $('meta').textContent = `${state.total} 个结果 · 目录更新 ${state.catalogUpdated || '未提供'}`;
    $('pages').textContent = `${page + 1} / ${Math.max(1, Math.ceil(state.total / state.pageSize))}`;
    $('prev').disabled = page === 0; $('next').disabled = (page + 1) * state.pageSize >= state.total;
    $('notice').textContent = runtime?.busy ? '另一项插件操作正在进行，请稍候。' : runtimeError ? '插件状态读取失败，刷新后重试：' + runtimeError : state.refreshing ? '正在更新目录，先显示本机缓存。' : state.stale ? '网络更新未完成，当前显示本机缓存。' : '目录已加载 · ☆ 为 GitHub 收藏数';
    if (state.refreshing || runtime?.busy) refreshTimer = setTimeout(() => { void load(); }, 1500);
  } catch (error) { $('notice').textContent = error.message; }
  finally { pending = false; if (deferred && !busy) { deferred = false; void load(); } }
}
$('query').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { page = 0; void load(); }, 300); });
$('category').addEventListener('change', () => { page = 0; void load(); });
$('refresh').addEventListener('click', () => { page = 0; void load(true); });
$('prev').addEventListener('click', () => { page--; void load(); });
$('next').addEventListener('click', () => { page++; void load(); });
$('recover').addEventListener('click', () => { window.top.location.href = 'dsh-phone://market/recovery'; });
$('trial').addEventListener('change', async () => {
  const enabled = $('trial').checked; $('trial').disabled = true;
  try {
    if (enabled && !confirm('允许试装未验证插件？每次安装前都会自动备份。第三方插件能够访问 DSH 的文件和账号。')) { $('trial').checked = false; return; }
    await manage({ action: 'trial-allow', enabled }); await load();
  } catch (error) { $('trial').checked = !enabled; $('notice').textContent = error.message; }
  finally { $('trial').disabled = false; }
});
$('close-dialog').addEventListener('click', dismissDialog);
$('modal').addEventListener('click', event => { if (event.target === $('modal')) dismissDialog(); });
document.addEventListener('keydown', event => {
  if ($('modal').hidden) return;
  if (event.key === 'Escape') { event.preventDefault(); dismissDialog(); }
  if (event.key === 'Tab') {
    const elements = [...$('dialog').querySelectorAll('button:not(:disabled),a[href]')].filter(element => !element.hidden);
    const first = elements[0], last = elements.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === $('dialog'))) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === $('dialog'))) { event.preventDefault(); first?.focus(); }
  }
});
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
void load();
