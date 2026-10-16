const open = mode => window.parent.dispatchEvent(new CustomEvent('dsh-team:open', {detail: {mode}}));
document.getElementById('open-team').onclick = () => open('bot');
document.getElementById('open-agent').onclick = () => open('agent');
(async () => {
  try {
    const response = await fetch('/dsh-team/manage', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload: {action: 'status'}})});
    const envelope = await response.json(), result = envelope.result;
    if (!response.ok || !result?.ok) throw Error(result?.error?.message || '团队尚未连接');
    document.getElementById('notice').textContent = result.value.readOnly ? '团队在另一个 DSH 实例中打开，当前只读。' : `成员 ${result.value.bots.length} 位，项目群 ${result.value.groups.length} 个。`;
    for (const bot of result.value.bots) {const li = document.createElement('li'); li.textContent = `${bot.name}${bot.main ? ' · 主理人' : ''}${bot.role ? ' · ' + bot.role : ''}`; document.getElementById('members').append(li);}
  } catch (error) {document.getElementById('notice').textContent = error.message;}
})();
