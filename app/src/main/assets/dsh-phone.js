// Keep original provider cards and React handlers on narrow screens.
(() => {
  if (window.__dshPhonePresentation) return;
  window.__dshPhonePresentation = true;
  const media = window.matchMedia('(max-width: 700px)');
  // These two same-origin settings documents have a natural-height body.
  // Measure that body, not documentElement.scrollHeight (which is at least
  // the old iframe viewport height and would preserve its empty space).
  const settingsEmbeds = new Map();
  const fitSettingsEmbeds = () => {
    const frames = new Set(document.querySelectorAll('.VOzbGW_options iframe[data-dsh-settings-embed]'));
    for (const [frame, state] of settingsEmbeds) {
      if (media.matches && frames.has(frame)) continue;
      state.disconnect(); frame.removeEventListener('load', state.load);
      frame.style.removeProperty('--dsh-phone-embed-height'); settingsEmbeds.delete(frame);
    }
    if (!media.matches) return;
    for (const frame of frames) {
      let state = settingsEmbeds.get(frame);
      if (!state) {
        state = { disconnect() {}, pending:false };
        state.measure = () => {
          if (!media.matches || !frame.isConnected) return;
          try {
            const doc = frame.contentDocument, body = doc?.body;
            if (!body || !['/agent-cards','/controlled-market','/phone-tools','/hermes-remote'].includes(new URL(doc.URL).pathname)) return;
            const styles = doc.defaultView.getComputedStyle(body);
            const height = Math.ceil(body.getBoundingClientRect().height + (parseFloat(styles.marginTop) || 0) + (parseFloat(styles.marginBottom) || 0));
            if (height > 0 && frame.style.getPropertyValue('--dsh-phone-embed-height') !== height+'px') frame.style.setProperty('--dsh-phone-embed-height', height+'px');
          } catch { /* A navigated iframe may no longer be same-origin. */ }
        };
        const schedule = () => {
          if (state.pending) return; state.pending = true;
          // WebView pauses animation frames while a popup or another app is
          // in front. Catalog requests still finish there; fit their content
          // in a microtask instead of retaining the loading screen's height.
          Promise.resolve().then(() => { state.pending = false; state.measure(); });
        };
        state.load = () => {
          state.disconnect(); frame.style.removeProperty('--dsh-phone-embed-height');
          try {
            const doc = frame.contentDocument, body = doc?.body;
            if (!body || !['/agent-cards','/controlled-market','/phone-tools','/hermes-remote'].includes(new URL(doc.URL).pathname)) return;
            const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
            const mutations = new MutationObserver(schedule);
            resize?.observe(body); mutations.observe(body, {childList:true, subtree:true, characterData:true, attributes:true});
            state.disconnect = () => { resize?.disconnect(); mutations.disconnect(); };
            schedule();
          } catch { /* Keep the bounded fallback if this document is unavailable. */ }
        };
        settingsEmbeds.set(frame, state); frame.addEventListener('load', state.load); state.load();
      }
      state.measure();
    }
  };
  document.addEventListener('visibilitychange', fitSettingsEmbeds);
  document.addEventListener('paste', async event => {
    const input = event.target.closest?.('[data-composer-card] [role=textbox],[data-composer-card] textarea');
    const files = Array.from(event.clipboardData?.files || []);
    if (!event.isTrusted || !input || !files.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    try {
      const { normalizeChatImage } = await import('/phone-skill-import.js');
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(await normalizeChatImage(file) || file);
      const text = event.clipboardData.getData('text/plain'); if (text) transfer.setData('text/plain', text);
      if (input.isConnected) input.dispatchEvent(new ClipboardEvent('paste', { bubbles:true, cancelable:true, clipboardData:transfer }));
    } catch (error) {
      const notice = input.closest('[data-composer-card]').querySelector('[role=status]');
      if (notice) { notice.style.display = 'block'; notice.textContent = error.message; }
    }
  }, true);
  const adapt = () => {
    // Some WebViews resize only the visual viewport when an IME opens. Keep
    // the chat frame inside that visible area; native insets handle Android's
    // edge-to-edge window. Ignore pinch zoom so it does not reflow the app.
    const viewport = window.visualViewport;
    const height = viewport && Math.abs(viewport.scale - 1) < 0.05
      ? Math.min(window.innerHeight, viewport.height) : window.innerHeight;
    if (media.matches && height > 0) document.documentElement.style.setProperty('--dsh-phone-viewport-height', height + 'px');
    else document.documentElement.style.removeProperty('--dsh-phone-viewport-height');
    fitSettingsEmbeds();
    const frame = document.querySelector('.pI_x6G_frame'), rail = frame?.querySelector('.pI_x6G_sidebarCol');
    if (frame && rail) {
      let menu = document.querySelector('.dsh-phone-menu');
      if (!menu) {
        menu = document.createElement('button'); menu.className = 'dsh-phone-menu'; menu.type = 'button';
        menu.textContent = '☰ 菜单'; menu.setAttribute('aria-label', '展开菜单'); menu.setAttribute('aria-expanded', 'false');
        rail.id ||= 'dsh-phone-sidebar'; menu.setAttribute('aria-controls', rail.id);
        const mask = document.createElement('button'); mask.className = 'dsh-phone-sidebar-mask'; mask.type = 'button'; mask.setAttribute('aria-label', '收起菜单');
        const show = open => {
          document.body.classList.toggle('dsh-phone-menu-open', open);
          const dialog = !!rail.querySelector('.VOzbGW_overlay');
          rail.classList.toggle('dsh-phone-dialog-open', dialog);
          rail.inert = !open && !dialog; rail.setAttribute('aria-hidden', String(!open && !dialog));
          menu.setAttribute('aria-expanded', String(open)); menu.setAttribute('aria-label', open ? '收起菜单' : '展开菜单');
          const collapsed = frame.hasAttribute('data-sidebar-collapsed');
          if (open && collapsed) rail.querySelector('.hHd-Xa_toggle')?.click();
        };
        menu.onclick = () => show(!document.body.classList.contains('dsh-phone-menu-open'));
        mask.onclick = () => show(false);
        rail.addEventListener('click', event => {
          const target = event.target.closest('button,a,.YDXeBa_sessionRow');
          if (target && !target.matches('.hHd-Xa_toggle') && (!target.hasAttribute('aria-expanded') || target.closest('.hHd-Xa_footArea'))) requestAnimationFrame(() => show(false));
        });
        document.addEventListener('keydown', event => { if (media.matches && event.key === 'Escape') show(false); });
        document.body.append(menu, mask);
      }
      const open = media.matches && document.body.classList.contains('dsh-phone-menu-open');
      const dialog = media.matches && !!rail.querySelector('.VOzbGW_overlay');
      rail.classList.toggle('dsh-phone-dialog-open', dialog);
      menu.hidden = !media.matches; rail.inert = media.matches && !open && !dialog;
      if (media.matches) rail.setAttribute('aria-hidden', String(!open && !dialog)); else { rail.removeAttribute('aria-hidden'); document.body.classList.remove('dsh-phone-menu-open'); }
    }
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const tools = card.querySelector('.uV2eYG_tools'), input = card.querySelector('textarea,[role=textbox][contenteditable]');
      if (!tools || !input || tools.querySelector('.dsh-phone-feed')) return;
      const button = document.createElement('button'), picker = document.createElement('input');
      button.type = 'button'; button.className = 'dsh-phone-feed'; button.textContent = '投喂技能';
      button.title = '选择技能 ZIP、Markdown 或 TXT，自动导入共享技能';
      button.style.cssText = 'border:0;border-radius:8px;padding:4px 7px;background:#eaf2ff;color:#2563eb;font:12px system-ui;white-space:nowrap';
      picker.type = 'file'; picker.accept = '.zip,.md,.txt,application/zip,application/x-zip-compressed,text/plain,text/markdown'; picker.hidden = true;
      const notice = document.createElement('small'); notice.setAttribute('role', 'status');
      notice.style.cssText = 'display:none;padding:4px 14px;color:#2563eb;overflow-wrap:anywhere';
      card.append(notice); tools.append(button, picker);
      const uploadButton = document.createElement('button'), uploadPicker = document.createElement('input');
      uploadButton.type = 'button'; uploadButton.className = 'dsh-phone-upload'; uploadButton.textContent = '上传';
      uploadButton.title = '选择上传图片或文件，文件支持技能包'; uploadButton.setAttribute('aria-label', '上传图片或文件');
      uploadButton.style.cssText = button.style.cssText;
      uploadPicker.type = 'file'; uploadPicker.multiple = true; uploadPicker.hidden = true; uploadPicker.className = 'dsh-phone-upload-picker';
      uploadPicker.accept = '.zip,.md,.txt,.csv,.tsv,.json,.jsonl,.xml,.yaml,.yml,.log,.js,.mjs,.cjs,.ts,.tsx,.jsx,.py,.sh,.html,.css,.java,.kt,.c,.cpp,.h,.sql,.ini,.toml,image/png,image/jpeg,image/webp,image/gif';
      tools.insertBefore(uploadButton, button); tools.append(uploadPicker);
      const imagePicker = document.createElement('input'), fileButton = document.createElement('button');
      imagePicker.type = 'file'; imagePicker.accept = 'image/png,image/jpeg,image/webp,image/gif'; imagePicker.multiple = true; imagePicker.hidden = true;
      imagePicker.className = 'dsh-phone-image-picker'; tools.append(imagePicker);
      const imageButton = document.createElement('button'); imageButton.type = 'button'; imageButton.className = 'dsh-phone-image-upload'; imageButton.textContent = '上传图片';
      imageButton.title = '从相册选择图片，可一次选择多张'; imageButton.hidden = true; tools.append(imageButton);
      fileButton.type = 'button'; fileButton.className = 'dsh-phone-document-upload'; fileButton.textContent = '上传文件';
      fileButton.title = '选择文档、图片或技能 ZIP，自动识别技能包'; fileButton.hidden = true; tools.append(fileButton);
      button.hidden = true;
      const appendDraft = text => {
        if (input instanceof HTMLTextAreaElement) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
          setter.call(input, input.value ? input.value + '\n\n' + text : text);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          // Feed Lexical's normal paste path, preserving reference chips and draft persistence.
          input.focus();
          const range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
          const clipboard = new DataTransfer(); clipboard.setData('text/plain', (input.textContent ? '\n\n' : '') + text);
          input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }));
        }
      };
      const closeUploadMenu = () => {
        if (card.querySelector('.dsh-phone-upload-actions')) input.dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', code:'Escape', bubbles:true, cancelable:true }));
      };
      const selectFile = picker => {
        if (input.disabled || input.readOnly) { notice.style.display = 'block'; notice.textContent = '请先选择工作区，并等当前任务结束后上传。'; return; }
        closeUploadMenu(); picker.click();
      };
      uploadButton.onclick = event => { event.stopPropagation(); card.querySelector('.uV2eYG_add')?.click(); };
      imageButton.onclick = event => { event.stopPropagation(); selectFile(imagePicker); };
      fileButton.onclick = event => { event.stopPropagation(); selectFile(uploadPicker); };
      const importSkillFile = async file => {
        const { prepareSkillFile, importPreparedSkill, skillImportDraft } = await import('/phone-skill-import.js');
        const rpc = async (action, extra = {}) => {
          const response = await fetch('/phone-import/manage', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'manage', payload: { action, ...extra } }) });
          const result = (await response.json()).result;
          if (!response.ok || !result?.ok) throw Error(result?.error?.message || '导入失败，请稍后重试');
          return result.value;
        };
        const upload = async file => {
          const response = await fetch('/phone-packs/upload', { method: 'POST', headers: { 'content-type': 'application/zip' }, body: file });
          const result = await response.json();
          if (!response.ok || !result.ok) throw Error(result.error || '技能包无法读取');
          return result;
        };
        const prepared = await prepareSkillFile(file, { rpc, upload });
        if (prepared.replacesExisting && !prepared.alreadyInstalled && !confirm('已有同名技能，是否用这份文档更新？')) return '已取消，原技能保留。';
        const result = await importPreparedSkill(prepared, { rpc });
        if (input.isConnected && !input.disabled && !input.readOnly) appendDraft(skillImportDraft(prepared, ''));
        return result.message;
      };
      const receiveFiles = async picker => {
        const files = Array.from(picker.files); if (!files.length) return;
        uploadButton.disabled = fileButton.disabled = imageButton.disabled = button.disabled = true; notice.style.display = 'block'; notice.textContent = '正在读取文件…';
        try {
          const { prepareChatFiles, chatDocumentText } = await import('/phone-skill-import.js');
          const prepared = await prepareChatFiles(files);
          if (!input.isConnected || input.disabled || input.readOnly) throw Error('会话状态已变化，请等任务结束后重新上传');
          const imported = [];
          for (const file of prepared.skillFiles) imported.push(await importSkillFile(file));
          if (prepared.documents.length) appendDraft(chatDocumentText(prepared.documents));
          if (prepared.images.length) {
            const transfer = new DataTransfer(); prepared.images.forEach(file => transfer.items.add(file));
            input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
          }
          notice.textContent = [...imported, prepared.images.length ? '图片已加入草稿，可预览或移除；请选支持看图的模型后发送。' : prepared.documents.length ? '文件原文已加入草稿，写下分析要求后发送。' : ''].filter(Boolean).join(' ');
          input.focus();
        } catch (error) { notice.textContent = error.message; }
        finally { uploadButton.disabled = fileButton.disabled = imageButton.disabled = button.disabled = false; picker.value = ''; }
      };
      uploadPicker.onchange = () => receiveFiles(uploadPicker);
      imagePicker.onchange = () => receiveFiles(imagePicker);
      button.onclick = event => { event.stopPropagation(); selectFile(picker); };
      picker.onchange = async () => {
        const file = picker.files[0]; if (!file) return;
        uploadButton.disabled = fileButton.disabled = imageButton.disabled = button.disabled = true;
        notice.style.display = 'block'; notice.textContent = '正在读取并导入技能…';
        try { notice.textContent = await importSkillFile(file); input.focus(); }
        catch (error) { notice.textContent = error.message; }
        finally { uploadButton.disabled = fileButton.disabled = imageButton.disabled = button.disabled = false; picker.value = ''; }
      };
    });
    // Both the labeled upload entry and the native + entry open the same menu.
    // Leave native workspace references and command handlers intact.
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const menu = card.querySelector('[data-trigger-menu]'), list = menu?.querySelector('[role=listbox]');
      if (!list || menu.querySelector('.dsh-phone-upload-actions') || !list.querySelector('._3e4SsG_itemAlias')?.textContent.includes('file')) return;
      const actions = document.createElement('div'); actions.className = 'dsh-phone-upload-actions'; actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', '上传');
      for (const [selector, label, hint] of [['.dsh-phone-image-upload', '上传图片', '相册 · 可选多张'], ['.dsh-phone-document-upload', '上传文件', '文档 · 自动识别技能 ZIP']]) {
        const target = card.querySelector(selector), action = document.createElement('button'); action.type = 'button'; action.disabled = target.disabled;
        const title = document.createElement('strong'), description = document.createElement('small'); title.textContent = label; description.textContent = hint;
        action.append(title, description); action.onmousedown = event => { event.preventDefault(); event.stopPropagation(); }; action.onclick = event => { event.stopPropagation(); target.click(); }; actions.append(action);
      }
      menu.insertBefore(actions, list);
    });
    document.querySelectorAll('.wSkVaW_headerUtilities button').forEach(button => {
      if (!/session log|会话日志/i.test(button.textContent)) return;
      button.classList.add('dsh-phone-log-button');
      if (!button.hasAttribute('aria-label')) button.setAttribute('aria-label', button.textContent.trim());
      if (!button.title) button.title = button.textContent.trim();
    });
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const tools = card.querySelector('.uV2eYG_tools');
      if (!tools) return;
      let more = card.querySelector('.dsh-phone-composer-more');
      if (media.matches && !more) {
        more = document.createElement('details'); more.className = 'dsh-phone-composer-more';
        const summary = document.createElement('summary'); summary.textContent = '⋯'; summary.setAttribute('aria-label', '会员用量');
        const options = document.createElement('div'); options.className = 'dsh-phone-composer-options';
        more.append(summary, options); tools.append(more);
      }
      if (!media.matches && more) { const notice = more.querySelector('.dsh-phone-chatgpt-plan'); if (notice) card.append(notice); more.remove(); }
    });
    if (window.__dshPeerRemote && !document.querySelector('.dsh-peer-badge')) {
      const badge = document.createElement('a'); badge.className = 'dsh-peer-badge';
      badge.textContent = '电脑 · ' + (window.__dshPeerName || '家里的电脑'); badge.title = badge.textContent + '，任务在电脑执行；点击返回手机';
      badge.href = 'http://127.0.0.1:3080/'; document.body.append(badge); document.body.classList.add('dsh-peer-remote');
    }
    document.body.classList.toggle('dsh-phone-mobile', media.matches);
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const usingPlan = card.querySelector('._7KE1Ra_trigger')?.title.includes(' · ChatGPT 会员');
      let notice = card.querySelector('.dsh-phone-chatgpt-plan');
      if (!usingPlan) { notice?.remove(); return; }
      if (notice) { const target = media.matches ? card.querySelector('.dsh-phone-composer-options') || card : card; if (notice.parentElement !== target) target.append(notice); return; }
      notice = document.createElement('small'); notice.className = 'dsh-phone-chatgpt-plan';
      notice.style.cssText = 'display:block;padding:4px 14px;color:#626b78';
      const usage = document.createElement('a'); usage.href = 'https://chatgpt.com/settings/usage'; usage.textContent = '管理用量';
      usage.style.cssText = 'color:#2563eb;margin-left:10px';
      notice.append(document.createTextNode('正在使用你的 ChatGPT 会员方案'), usage);
      (media.matches ? card.querySelector('.dsh-phone-composer-options') || card : card).append(notice);
    });
    document.querySelectorAll('[data-composer-card]').forEach(card => {
      const more = card.querySelector('.dsh-phone-composer-more');
      if (more) more.hidden = !card.querySelector('.dsh-phone-chatgpt-plan');
    });
    document.querySelectorAll('._7KE1Ra_root').forEach(root => {
      if (!media.matches) { ['left','width','height'].forEach(key=>root.style.removeProperty('--dsh-phone-model-'+key)); return; }
      const menu = root.querySelector('._7KE1Ra_menu'); if (!menu) return;
      const anchor = root.closest('[data-composer-card]') || root.parentElement;
      const bounds = anchor.getBoundingClientRect(), trigger = root.getBoundingClientRect();
      const viewport = window.visualViewport;
      const start = viewport?.offsetLeft || 0, width = viewport?.width || window.innerWidth;
      const left = Math.max(start+12, bounds.left+8), right = Math.min(start+width-12, bounds.right-8);
      root.style.setProperty('--dsh-phone-model-left', (left-trigger.left)+'px');
      root.style.setProperty('--dsh-phone-model-width', Math.max(160,right-left)+'px');
      root.style.setProperty('--dsh-phone-model-height', Math.max(120,Math.min(480,trigger.top-(viewport?.offsetTop||0)-20))+'px');
    });
    // Jet Hub's right-aligned quota panel crosses the left edge when its
    // trigger sits beside the upload button. Fit it to the visible composer.
    document.querySelectorAll('.dim-jh-badge,.dsh-phone-composer-more').forEach(root => {
      const prefix = '--dsh-phone-popover-';
      if (!media.matches) { ['left','width','height'].forEach(key => root.style.removeProperty(prefix+key)); return; }
      const viewport = window.visualViewport, start = viewport?.offsetLeft || 0, width = viewport?.width || window.innerWidth;
      const trigger = root.getBoundingClientRect(), card = root.closest('[data-composer-card]');
      const bounds = card?.getBoundingClientRect() || { left: start, right: start+width };
      const first = Math.max(start+12, bounds.left+8), last = Math.min(start+width-12, bounds.right-8);
      const panelWidth = Math.max(0, Math.min(root.matches('.dim-jh-badge') ? 360 : 270, last-first));
      const left = Math.max(first, Math.min(trigger.right-panelWidth, last-panelWidth));
      root.style.setProperty(prefix+'left', (left-trigger.left)+'px');
      root.style.setProperty(prefix+'width', panelWidth+'px');
      root.style.setProperty(prefix+'height', Math.max(80, Math.min(480, trigger.top-(viewport?.offsetTop || 0)-16))+'px');
    });
    document.querySelectorAll('.dim-jh-layout').forEach(layout => {
      const rail = layout.querySelector('.dim-jh-rail');
      if (!rail) return;
      let header = layout.querySelector('.dsh-phone-provider');
      if (!media.matches) { header?.remove(); layout.classList.remove('dsh-phone-choosing'); return; }
      const selected = rail.querySelector('.dim-jh-provider[aria-selected="true"]');
      if (!header) {
        header = document.createElement('div'); header.className = 'dsh-phone-provider';
        const title = document.createElement('span'); title.className = 'dsh-phone-selected';
        const toggle = document.createElement('button'); toggle.className = 'dim-jh-btn'; toggle.type = 'button';
        toggle.addEventListener('click', () => {
          layout.classList.toggle('dsh-phone-choosing');
          toggle.setAttribute('aria-expanded', String(layout.classList.contains('dsh-phone-choosing')));
          toggle.textContent = layout.classList.contains('dsh-phone-choosing') ? '返回账号' : '选择供应商';
        });
        header.append(title, toggle); layout.insertBefore(header, rail);
        rail.addEventListener('click', event => {
          if (!event.target.closest('.dim-jh-provider')) return;
          layout.classList.remove('dsh-phone-choosing'); toggle.setAttribute('aria-expanded', 'false'); toggle.textContent = '选择供应商';
        });
        layout.classList.add('dsh-phone-choosing'); toggle.setAttribute('aria-expanded', 'true'); toggle.textContent = '返回账号';
      }
      const label = selected?.querySelector('.dim-jh-providerLabel strong')?.textContent || '供应商账号';
      if (header.dataset.selected !== label) {
        const title = header.querySelector('.dsh-phone-selected'); title.replaceChildren();
        const icon = selected?.querySelector('.dim-jh-providerIcon'); if (icon) title.append(icon.cloneNode(true));
        title.append(document.createTextNode(label)); header.dataset.selected = label;
      }
    });
  };
  let pending = false;
  const queue = () => { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; adapt(); }); };
  new MutationObserver(queue).observe(document.body, { childList:true, subtree:true, attributes:true, attributeFilter:['aria-selected','title'] });
  media.addEventListener('change', queue); window.addEventListener('resize',queue); document.addEventListener('focusin',queue);
  window.visualViewport?.addEventListener('resize',queue); window.visualViewport?.addEventListener('scroll',queue); adapt();
})();
