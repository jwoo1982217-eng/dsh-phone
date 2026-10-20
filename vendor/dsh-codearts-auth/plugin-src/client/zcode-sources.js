import * as React from 'react';
import {ZcodeResetPanel} from './zcode-reset.js';
/** 每个账号独立选择额度来源；查询与保存失败都保留原选择。 */
export function ZcodeSourcePanel({ account, rpcCall, onChanged }) {
  const [snapshot, setSnapshot] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const alive = React.useRef(true);
  const load = async (refresh = false) => {
    setBusy(true); setError(null);
    try { const data = await rpcCall('zcode.sources', { accountId: account.id, refresh }); if (alive.current) { setSnapshot(data); if (refresh) await onChanged?.(); } }
    catch (caught) { if (alive.current) setError(caught?.message || '额度来源读取失败'); }
    finally { if (alive.current) setBusy(false); }
  };
  React.useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, [account.id]);
  const select = async (sourceId) => {
    setBusy(true); setError(null);
    try {
      await rpcCall('zcode.selectSource', { accountId: account.id, sourceId });
      if (alive.current) { setSnapshot(old => ({ ...old, selected: sourceId })); await onChanged?.(); }
    } catch (caught) { if (alive.current) setError(caught?.message || '额度来源保存失败'); }
    finally { if (alive.current) setBusy(false); }
  };
  const sources = snapshot?.sources || [];
  const selected = snapshot?.selected ?? account.zcodeSource ?? 'auto';
  return React.createElement('div', { className: 'dim-jh-zcodeSources', style: { minWidth: 0, marginTop: 10 } },
    React.createElement('label', { style: { display: 'block' } }, '额度来源 ',
      React.createElement('select', { 'aria-label': 'ZCode额度来源', value: selected, disabled: busy || !snapshot, onChange: e => void select(e.target.value), style: { width: '100%', maxWidth: '100%', minHeight: 40, marginTop: 6 } },
        React.createElement('option', { value: 'auto' }, '自动 · 沿用赠送优先的原设置'),
        sources.map(source => React.createElement('option', { key: source.id, value: source.id, disabled: !source.available }, source.label + (source.available ? '' : '（不可用）'))),
        selected !== 'auto' && !sources.some(s => s.id === selected) ? React.createElement('option', { value: selected }, '已保存来源 · 等待刷新') : null)),
    React.createElement('p', { className: 'dim-jh-hint' }, '后续请求使用所选来源并刷新对应模型目录；已开始的请求保持原来源。机构流量走普通 API，使用该机构项目的资源包或充值余额，不扣编程套餐。余额不足时不会改用本账号其他 Plan。'),
    sources.map(source => React.createElement('div', { key: source.id, className: 'dim-jh-hint', style: { overflowWrap: 'anywhere', marginTop: 4 } },
      (selected === source.id ? '当前 · ' : '') + source.label + '：' + (source.quota || source.reason || (source.available ? '可用' : '不可用')),
      source.reason && source.quota ? React.createElement('span', null, '；' + source.reason) : null)),
    error ? React.createElement('div', { role: 'alert', className: 'dim-jh-hint', 'data-tone': 'error' }, error) : null,
    React.createElement('button', { type: 'button', className: 'dim-jh-btn', disabled: busy, onClick: () => void load(true) }, busy ? '读取中…' : '刷新额度来源'),
    snapshot ? React.createElement(ZcodeResetPanel, { key: account.id, account: {...account,zcodeSource:selected}, sources, rpcCall, onChanged: async()=>{ await load(true); } }) : null);
}
