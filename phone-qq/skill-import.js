// One file picker for phone chats and QQ. Read existing instructions; never invent
// a replacement body, run attachments, or ask the user to retype file metadata.
export async function prepareSkillFile(file, { rpc, upload }) {
  if (!file) throw Error('请先选择技能文件');
  if (/\.zip$/i.test(file.name)) {
    if (file.size > 24 * 1024 * 1024) throw Error('技能 ZIP 最多 24 MB');
    const result = await upload(file);
    const state = await rpc('packs.status');
    return {
      kind: 'pack', title: file.name, token: result.token,
      skills: result.preview.skills.length, prompts: result.preview.prompts.length,
      revision: state.revision,
      alreadyInstalled: state.records.some(record => record.id === result.preview.id),
    };
  }
  if (!/\.(?:md|txt)$/i.test(file.name)) throw Error('请选择 ZIP、Markdown 或 TXT 技能文件');
  if (file.size > 64 * 1024) throw Error('单个技能文档最多 64 KB；多个技能和附件请选择 ZIP');
  let bytes, text;
  try { bytes = await file.arrayBuffer(); }
  catch { throw Error('无法读取文件，请在文件选择器中重新授权选择；云端文件请先下载到手机'); }
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw Error('技能文档须为 UTF-8 文本，请重新选择文件'); }
  const skill = await rpc('skills.parse', { text, filename: file.name });
  const state = await rpc('skills.status');
  const existing = state.items.find(item => item.name === skill.name);
  return {
    kind: 'skill', title: skill.title || skill.name, skill,
    revision: state.revision, replacesExisting: !!existing,
    alreadyInstalled: !!existing && existing.enabled && existing.title === skill.title
      && existing.description === skill.description && existing.content === skill.content,
  };
}

export async function importPreparedSkill(prepared, { rpc }) {
  if (!prepared) throw Error('请先选择技能文件');
  if (prepared.kind === 'pack') {
    const value = await rpc('packs.install', { token: prepared.token, revision: prepared.revision });
    return { kind: 'pack', value, message: `已导入 ${prepared.skills} 个技能、${prepared.prompts} 张提示卡。DSH 聊天和 QQ 共用；提示卡可按需要单独启用。` };
  }
  if (prepared.kind !== 'skill') throw Error('导入预览无效，请重新选择文件');
  const value = await rpc('skills.save', { skill: { ...prepared.skill, enabled: true }, revision: prepared.revision });
  return { kind: 'skill', value, message: `“${prepared.title}”已导入并启用，DSH 聊天和 QQ 都能使用。` };
}

export function skillImportDraft(prepared, current = '') {
  if (prepared.kind === 'skill') {
    // A leading /name uses DSH's native skill invocation: the host supplies
    // the exact saved body before the model responds, including in old chats.
    const command = `/${prepared.skill.name}`;
    if (current === command || current.startsWith(command + '\n') || current.startsWith(command + ' ')) return current;
    return `${command}\n${current || '请按这个技能的方法处理我的任务。'}`;
  }
  return `${current}${current ? '\n' : ''}请读取刚导入的技能包，按任务选择合适的方法处理。`;
}

export function importPreviewText(prepared) {
  if (prepared.kind === 'pack') return `${prepared.title}\n自动识别 ${prepared.skills} 个技能、${prepared.prompts} 张提示卡，保留配套文件。${prepared.alreadyInstalled ? '\n这个技能包已导入，不会重复添加。' : ''}\n点击下方按钮即可导入，无需填写名称和步骤。`;
  return `${prepared.title}\n${prepared.skill.description}\n正文已完整读取（${new TextEncoder().encode(prepared.skill.content).length} 字节）。${prepared.alreadyInstalled ? '\n已保存相同内容，不会添加重复技能。' : prepared.replacesExisting ? '\n导入将更新已有同名技能。' : ''}\n点击下方按钮即可导入，无需填写表单。`;
}

// Android photo/document providers and clipboard sources can supply a generic
// or incorrect MIME. Preserve image bytes and fix only the browser metadata.
export async function normalizeChatImage(file) {
  const supported = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!/^image\//i.test(file.type) && file.type && file.type !== 'application/octet-stream' && !/\.(png|jpe?g|webp|gif)$/i.test(file.name)) return null;
  let bytes;
  try { bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer()); }
  catch { throw Error('无法读取图片，请在系统选择器中重新选择'); }
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  const type = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((n,i) => bytes[i] === n) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : ['GIF87a','GIF89a'].includes(ascii(0,6)) ? 'image/gif'
    : ascii(0,4) === 'RIFF' && ascii(8,12) === 'WEBP' ? 'image/webp' : null;
  if (!type) return supported.includes(file.type) ? file : null; // Host still fully decodes and validates.
  if (type === file.type) return file;
  const suffix = { 'image/png':'png', 'image/jpeg':'jpg', 'image/webp':'webp', 'image/gif':'gif' }[type];
  return new File([file], file.name || `截图.${suffix}`, { type, lastModified: file.lastModified });
}

// Only explicit skill formats are routed to the validated skill importer.
// Ordinary documents remain task material, including other Markdown files.
export async function prepareChatFiles(files) {
  const documents = [], images = [], skillFiles = [];
  if (!files.length || files.length > 8) throw Error('一次请选择 1 到 8 个文件');
  let total = 0;
  for (const file of files) {
    if (/\.zip$/i.test(file.name) || /^SKILL\.md$/i.test(file.name)) {
      if (file.size > (/\.zip$/i.test(file.name) ? 24 * 1024 * 1024 : 64 * 1024)) throw Error('技能 ZIP 最多 24 MB，单个 SKILL.md 最多 64 KB');
      skillFiles.push(file); continue;
    }
    const image = await normalizeChatImage(file);
    if (image) { images.push(image); continue; }
    if (!/\.(?:md|txt|csv|tsv|json|jsonl|xml|yaml|yml|log|js|mjs|cjs|ts|tsx|jsx|py|sh|html|css|java|kt|c|cpp|h|sql|ini|toml)$/i.test(file.name)) {
      throw Error('目前支持文本、表格 CSV、代码、图片和技能 ZIP');
    }
    total += file.size;
    if (file.size > 128 * 1024 || total > 256 * 1024) throw Error('单个文档最多 128 KB，一次文档合计最多 256 KB');
    let bytes, text;
    try { bytes = await file.arrayBuffer(); }
    catch { throw Error('无法读取文件，请在系统选择器中重新选择；云端文件请先下载到手机'); }
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw Error('文档须为 UTF-8 文本'); }
    if (text.includes('\0')) throw Error('这个文件包含二进制内容，请选择文本或图片');
    documents.push({ name: file.name, text });
  }
  return { documents, images, skillFiles };
}

export function chatDocumentText(documents) {
  return documents.map(file => `【上传文件：${file.name}】\n以下是文件原文，作为本次分析材料：\n${file.text}\n【文件结束】`).join('\n\n');
}
