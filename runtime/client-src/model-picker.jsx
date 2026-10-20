// Composer picker for the pinned 0.2.1-alpha.1 client. Host directory and
// selection remain authoritative; preferences contain only exact model pairs.
const DSH_PICKER_KEY = 'dsh:model-picker:v1';
const MEASURE_STYLE = {visibility:'hidden', left:0, top:0};
const pickerPair = value => JSON.stringify([value.provider, value.model]);
function pickerPreferences() {
  try {
    const raw = localStorage.getItem(DSH_PICKER_KEY);
    const data = raw && raw.length < 100000 ? JSON.parse(raw) : {};
    const clean = (values, limit) => {
      const seen = new Set();
      return (Array.isArray(values) ? values : []).filter(value => {
        if (!value || typeof value.provider !== 'string' || typeof value.model !== 'string' || value.provider.length > 512 || value.model.length > 1024) return false;
        const key = pickerPair(value);
        if (seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, limit).map(({provider, model}) => ({provider, model}));
    };
    return {recent: clean(data?.recent, 30), favorites: clean(data?.favorites, 100)};
  } catch { return {recent: [], favorites: []}; }
}
function savePickerPreferences(value) {
  try { localStorage.setItem(DSH_PICKER_KEY, JSON.stringify(value)); } catch {}
}
function pickerRows(groups, query, provider, view, preferences, current) {
  const terms = query.normalize('NFKC').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const compact = text => text.replace(/[\s\p{P}\p{S}]+/gu, '');
  const favorites = new Set(preferences.favorites.map(pickerPair));
  const recent = new Map(preferences.recent.map((value, index) => [pickerPair(value), index]));
  const rows = [];
  for (const group of groups) for (const model of group.models) {
    const row = {provider: group.id, providerName: group.name, model: model.id, name: model.name};
    const key = pickerPair(row);
    if (provider && row.provider !== provider || view === 'favorites' && !favorites.has(key) || view === 'recent' && !recent.has(key)) continue;
    const text = `${row.name} ${row.model} ${row.providerName} ${row.provider}`.normalize('NFKC').toLowerCase();
    if (!terms.every(term => text.includes(term) || compact(text).includes(compact(term)))) continue;
    const selected = current && pickerPair(current) === key;
    const name = compact(row.name.toLowerCase());
    const score = terms.length ? terms.reduce((n, term) => n + (name === compact(term) ? 100 : name.startsWith(compact(term)) ? 20 : name.includes(compact(term)) ? 10 : 0), 0) : 0;
    rows.push({...row, selected, favorite: favorites.has(key), recent: recent.get(key), score});
  }
  // Searches rank across APIs. On an unfiltered opening, put current/favorites/
  // recently used entries first, while preserving catalog order for the rest.
  rows.sort((a, b) => terms.length ? b.score - a.score : view === 'recent' ? a.recent - b.recent : Number(b.selected) - Number(a.selected) || Number(b.favorite) - Number(a.favorite) || (a.recent ?? 999) - (b.recent ?? 999));
  return rows;
}

function ModelSelect({locked, available, directory, load, select, t}) {
  const state = react.useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot());
  const [open, setOpen] = react.useState(false);
  const [pane, setPane] = react.useState('model');
  const [query, setQuery] = react.useState('');
  const [provider, setProvider] = react.useState('');
  const [view, setView] = react.useState('all');
  const [preferences, setPreferences] = react.useState(pickerPreferences);
  const [active, setActive] = react.useState(0);
  const [toast, setToast] = react.useState(null);
  const [pos, setPos] = react.useState(MEASURE_STYLE);
  const [submitting, setSubmitting] = react.useState(false);
  const triggerRef = react.useRef(null), menuRef = react.useRef(null), inputRef = react.useRef(null), itemRefs = react.useRef([]);
  const alive = react.useRef(true), selecting = react.useRef(false), toastSeq = react.useRef(0);
  const id = react.useId();
  const P = _deepseek_ai_dsh_client_ui_primitives;
  const english = t('menu.model') === 'Model';
  const words = english ? {title:'Choose model', search:'Search model or API…', source:'API source', allSources:'All APIs', all:'All', favorites:'Favorites', recent:'Recent', current:'Current', close:'Close model picker', add:'Favorite', remove:'Unfavorite', empty:'No matching models', reset:'Clear filters', noFavorites:'Use ☆ beside a model to save it here.', noRecent:'Models you choose appear here.', count:'models', effort:'Reasoning effort', back:'Back to models'} : {title:'选择模型', search:'搜索模型或 API 来源…', source:'API 来源', allSources:'全部 API', all:'全部', favorites:'收藏', recent:'最近', current:'当前', close:'关闭模型选择', add:'收藏', remove:'取消收藏', empty:'没有找到匹配的模型', reset:'清除筛选', noFavorites:'点模型旁的 ☆，下次在这里快速找到。', noRecent:'切换过的模型会出现在这里。', count:'个模型', effort:'推理等级', back:'返回模型列表'};
  const groups = react.useMemo(() => orderModelProviders(state.groups), [state.groups]);
  const currentGroup = groups.find(group => group.id === state.current?.provider);
  const currentModel = currentGroup?.models.find(model => model.id === state.current?.model);
  const reasoning = currentModel?.reasoning;
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
  const effortLabel = reasoning === undefined ? state.retainedEffort : effectiveEffort === undefined ? t('effort.providerDefault') : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort;
  const effortChoices = reasoning === undefined ? [] : [...reasoning.defaultEffort === undefined ? [{id:'provider-default', effort:undefined, name:t('effort.providerDefault')}] : [], ...reasoning.efforts.map(level => ({id:level.id, effort:level.id, name:level.name}))];
  const rows = react.useMemo(() => pickerRows(groups, query, provider, view, preferences, state.current), [groups, query, provider, view, preferences, state.current]);
  const activeIndex = Math.min(active, rows.length - 1);
  const busy = state.pending !== null || submitting;
  const modelLabel = currentModel?.name ?? (state.current ? `${state.current.provider}/${state.current.model}` : t('trigger.fallback'));
  const close = (focus = true) => {setOpen(false); if (focus) triggerRef.current?.focus();};
  const reset = () => {setQuery(''); setProvider(''); setView('all'); setActive(0);};
  const remember = value => {
    const next = {...preferences, recent:[{provider:value.provider, model:value.model}, ...preferences.recent.filter(item => pickerPair(item) !== pickerPair(value))].slice(0, 30)};
    setPreferences(next); savePickerPreferences(next);
  };
  const favorite = row => {
    const next = {...preferences, favorites: row.favorite ? preferences.favorites.filter(item => pickerPair(item) !== pickerPair(row)) : [...preferences.favorites, {provider:row.provider, model:row.model}].slice(-100)};
    setPreferences(next); savePickerPreferences(next); setActive(0);
  };
  const submit = async (value, isEffort = false) => {
    if (selecting.current || busy || locked) return;
    if (!isEffort && state.current?.provider === value.provider && state.current.model === value.model) {remember(value); close(); return;}
    selecting.current = true; setSubmitting(true); setToast(null);
    try {
      const result = await select(value);
      if (!alive.current) return;
      if (result?.ok) {if (!isEffort) remember(value); close();}
      else if (result && !result.ok) {
        const error = result.error;
        setToast({seq:++toastSeq.current, text:error.code === 'session/writer-held' ? t('error.sessionInUse') : t('error.action', {message:`${error.code}: ${error.message}`})});
      }
    } catch (error) {
      if (alive.current) setToast({seq:++toastSeq.current, text:t('error.action', {message:String(error.message ?? error)})});
    } finally {selecting.current = false; if (alive.current) setSubmitting(false);}
  };
  const choose = row => submit({provider:row.provider, model:row.model});
  react.useEffect(() => {alive.current = true; return () => {alive.current = false;};}, []);
  react.useEffect(() => {
    if (!open) return;
    const outside = event => {if (!menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) close(false);};
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  react.useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = triggerRef.current?.getBoundingClientRect(), menu = menuRef.current;
      if (!rect || !menu) return;
      const viewport = window.visualViewport;
      const width = viewport?.width ?? innerWidth, height = viewport?.height ?? innerHeight;
      const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
      const mobile = innerWidth <= 600;
      const tablet = !mobile && matchMedia('(pointer:coarse)').matches;
      const maxHeight = Math.max(100, Math.min(tablet ? 680 : mobile ? 620 : 580, height - (tablet ? 48 : 24)));
      const h = Math.min(menu.offsetHeight, maxHeight);
      setPos({visibility:'visible', maxHeight, left: tablet ? left + (width - menu.offsetWidth) / 2 : mobile ? left + 12 : Math.max(left + 12, Math.min(rect.right - menu.offsetWidth, left + width - menu.offsetWidth - 12)), top:tablet ? top + (height - h) / 2 : mobile ? top + height - h - 12 : Math.max(top + 12, Math.min(rect.top - h - 8, top + height - h - 12))});
    };
    const observer = new ResizeObserver(place); if (menuRef.current) observer.observe(menuRef.current);
    place(); window.addEventListener('resize', place); window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place); window.visualViewport?.addEventListener('scroll', place);
    return () => {observer.disconnect(); window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);};
  }, [open, pane]);
  react.useEffect(() => {
    if (!open) return;
    if (pane === 'model' && matchMedia('(min-width:601px) and (pointer:fine)').matches) inputRef.current?.focus();
    else if (pane === 'effort') menuRef.current?.querySelector('[aria-checked="true"]')?.focus();
  }, [open, pane]);
  react.useLayoutEffect(() => {if (open && pane === 'model') itemRefs.current[activeIndex]?.scrollIntoView({block:'nearest'});}, [open, pane, activeIndex, rows]);
  const keys = event => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation();
      if (pane === 'effort') setPane('model'); else if (query) {setQuery(''); setActive(0);} else close();
    } else if (pane === 'model' && (event.target === inputRef.current || event.target.dataset.pickerModel !== undefined)) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault(); event.stopPropagation();
        if (!busy && rows.length) {
          const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
          setActive(next);
          if (event.target !== inputRef.current) itemRefs.current[next]?.focus();
        }
      } else if (event.key === 'Enter' && event.target === inputRef.current) {
        event.preventDefault(); event.stopPropagation(); if (rows[activeIndex]) choose(rows[activeIndex]);
      }
    }
  };
  if (!available) return null;
  return <div className={ModelSelect_module_css_default.root} onKeyDown={keys}>
    <button ref={triggerRef} className={ModelSelect_module_css_default.trigger} type="button" disabled={locked || busy} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${id}-menu`} aria-label={state.current ? t('trigger.aria', {model:modelLabel}) : t('trigger.selectAria')} title={`${currentGroup?.name ?? ''} · ${modelLabel}${effortLabel ? ' · ' + effortLabel : ''}`} onClick={() => {
      if (open) {close(); return;}
      setPreferences(pickerPreferences()); reset(); setPane('model'); setOpen(true); load();
    }}>
      <span className={ModelSelect_module_css_default.triggerLabel}>{modelLabel}</span>
      {effortLabel && <span className={ModelSelect_module_css_default.triggerEffort}> · {effortLabel}</span>}
      {busy ? <P.StateDot state="ongoing"/> : <P.IconChevronDownOutlineRegular/>}
    </button>
    {open && react_dom.createPortal(<P.MenuSurface ref={menuRef} id={`${id}-menu`} role="dialog" aria-label={words.title} aria-busy={busy} className="dsh-picker" style={pos} onKeyDown={keys}>
      <div className="dsh-picker-head"><strong>{pane === 'effort' ? words.effort : words.title}</strong><div className="dsh-picker-actions">
        {pane === 'effort' ? <button type="button" onClick={() => setPane('model')}>{words.back}</button> : reasoning && <button type="button" disabled={busy} onClick={() => setPane('effort')}>{words.effort} · {effortLabel}</button>}
        <button type="button" aria-label={words.close} onClick={() => close()}>×</button>
      </div></div>
      {pane === 'model' ? <>
        {state.current && <div className="dsh-picker-current"><span>{words.current}</span><span title={modelLabel}>{modelLabel}<small>{currentGroup?.name ?? state.current.provider}</small></span></div>}
        <div className="dsh-picker-search"><P.Input ref={inputRef} icon={<P.IconSearchOutlineRegular/>} type="search" role="searchbox" aria-label={words.search} aria-controls={`${id}-models`} aria-activedescendant={activeIndex >= 0 ? `${id}-model-${activeIndex}` : undefined} placeholder={words.search} value={query} readOnly={busy} autoComplete="off" onChange={event => {setQuery(event.target.value); setActive(0);}}/>{query && <button type="button" aria-label={t('search.clear')} onClick={() => {setQuery(''); setActive(0); inputRef.current?.focus();}}>×</button>}</div>
        <div className="dsh-picker-filters"><div role="group" aria-label={english ? 'Model filters' : '模型筛选'}>{['all','favorites','recent'].map(value => <button key={value} type="button" disabled={busy} aria-pressed={view === value} onClick={() => {setView(value); setActive(0);}}>{words[value]}</button>)}</div><select aria-label={words.source} value={provider} disabled={busy} onChange={event => {setProvider(event.target.value); setActive(0);}}><option value="">{words.allSources}</option>{groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>
        <div className="dsh-picker-list scrollable" id={`${id}-models`} role="menu" aria-label={t('menu.model')}>
          {state.status === 'loading' && <div className="dsh-picker-status" role="status">{t('status.loading')}</div>}
          {state.error && !toast && <div className="dsh-picker-error" role="alert">{t('error.action', {message:state.error})} <button type="button" disabled={busy} onClick={load}>{t('action.reload')}</button></div>}
          {state.failures.map(failure => <div className="dsh-picker-error" key={failure.id}>{t('warning.groupLoad', {name:failure.name, message:failure.message})} <button type="button" disabled={busy} onClick={load}>{t('action.reload')}</button></div>)}
          {rows.map((row, index) => <div className="dsh-picker-row" key={pickerPair(row)}>
            <button ref={node => {itemRefs.current[index] = node;}} data-picker-model="" data-provider={row.provider} data-model={row.model} type="button" role="menuitemradio" aria-checked={!!row.selected} id={`${id}-model-${index}`} disabled={busy || locked} data-highlighted={index === activeIndex ? '' : undefined} className="dsh-picker-choice" onFocus={() => setActive(index)} onClick={() => choose(row)} title={`${row.name}\n${row.providerName} · ${row.model}`}>
              <span className="dsh-picker-copy"><span>{row.name}</span><small>{row.providerName}{row.model !== row.name ? ` · ${row.model}` : ''}</small></span><span className="dsh-picker-check">{state.pending?.provider === row.provider && state.pending.model === row.model ? <P.StateDot state="ongoing"/> : row.selected ? '✓' : ''}</span>
            </button><button type="button" className="dsh-picker-star" aria-label={`${row.favorite ? words.remove : words.add} ${row.name} · ${row.providerName}`} aria-pressed={row.favorite} disabled={busy} onClick={() => favorite(row)}>{row.favorite ? '★' : '☆'}</button>
          </div>)}
          {rows.length === 0 && state.status !== 'loading' && <div className="dsh-picker-empty" role="status"><strong>{words.empty}</strong><span>{view === 'favorites' ? words.noFavorites : view === 'recent' ? words.noRecent : ''}</span>{(query || provider || view !== 'all') && <button type="button" onClick={reset}>{words.reset}</button>}</div>}
        </div><div className="dsh-picker-foot"><span>{rows.length} {words.count}</span>{groups.some(g=>g.id==='zcode') && <button type="button" className="dsh-picker-reset" aria-label="重置 ZCode 套餐额度" disabled={busy} onClick={()=>{const launch=globalThis.__dshOpenZcodeReset;if(typeof launch!=='function'){setToast({seq:++toastSeq.current,text:'额度重置入口尚未就绪，请稍后重新打开模型选择器'});return;}close(false);launch({model:state.current?.provider==='zcode'?state.current.model:undefined,onChanged:load,returnFocus:triggerRef.current});}}>ZCode 重置额度</button>}<span className="dsh-picker-shortcuts">↑ ↓ {english ? 'navigate' : '选择'} · Enter {english ? 'confirm' : '确认'} · Esc {english ? 'close' : '关闭'}</span></div>
      </> : <div className="dsh-picker-list" role="menu" aria-label={words.effort}>{effortChoices.map(level => <button key={level.id} type="button" role="menuitemradio" aria-checked={effectiveEffort === level.effort} className="dsh-picker-effort" disabled={busy || locked} onClick={() => {if (effectiveEffort === level.effort) {close(); return;} submit({provider:state.current.provider, model:state.current.model, ...level.effort === undefined ? {} : {reasoningEffort:level.effort}}, true);}}>{level.name}<span>{effectiveEffort === level.effort ? '✓' : ''}</span></button>)}</div>}
    </P.MenuSurface>, document.body)}
    {toast && <P.Toast key={toast.seq} text={toast.text} icon={<P.IconWarningOutlineRegular/>} anchor={triggerRef.current?.closest('[data-composer-card]') ?? null} onDone={() => setToast(null)}/>}
  </div>;
}
