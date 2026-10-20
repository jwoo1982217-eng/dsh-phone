import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import Skills from '@deepseek-ai/dsh-skill';
import { PhoneSkills, parseSkillMarkdown } from './skills.js';
import { PhonePacks } from './packs.js';
import { prepareSkillFile, importPreparedSkill, skillImportDraft } from './skill-import.js';
import { canonicalPhoneHome } from './phone-home.js';

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'dsh-file-import-'));
  const actualHome = path.join(directory, 'home'), alias = path.join(directory, 'android-files-dir');
  await mkdir(actualHome); await symlink(actualHome, alias);
  const home = canonicalPhoneHome({ DSH_HOME: alias });
  const data = new Map(), store = { get: async key => data.get(key), set: async (key, value) => data.set(key, value) };
  const skills = new PhoneSkills(store), packs = new PhonePacks(store, path.join(home, 'workspaces/qq/.dsh-skill-packs'), home);
  await skills.init(); await packs.init();
  const ctx = new Context(), fiber = ctx.plugin(Skills); await fiber;
  ctx.skills.registerProvider(control => skills.provider(control, path.join(home, 'workspaces/qq'), home));
  ctx.skills.registerProvider(control => packs.provider(control));
  let upload;
  const rpc = async (action, args = {}) => {
    switch (action) {
      case 'skills.parse': return parseSkillMarkdown(args.text, args.filename);
      case 'skills.status': return skills.status();
      case 'skills.save': return skills.update(args.skill, args.revision);
      case 'packs.status': return packs.status();
      case 'packs.install': assert.equal(args.token, 'prepared-upload'); return packs.import(upload, args.revision);
      default: throw Error('Unexpected operation');
    }
  };
  const io = { rpc, upload: async file => { upload = Buffer.from(await file.arrayBuffer()); return { token: 'prepared-upload', preview: packs.preview(upload) }; } };
  return { home, alias, skills, packs, ctx, io, close: async () => { await fiber.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test('Android home aliases publish imported Markdown to the canonical chat cwd and preserve its full body', async () => {
  const f = await fixture();
  try {
    assert.notEqual(f.home, f.alias);
    assert.equal(canonicalPhoneHome({ HOME: path.dirname(f.alias), DSH_HOME: f.alias }), f.home);
    const original = '# 阅读书源 JS 入门教程\n\n> 用途：编写书源\n\n## 方法\n读取真实页面并验证解析结果。';
    const prepared = await prepareSkillFile(new File([original], '阅读书源.md'), f.io);
    await importPreparedSkill(prepared, f.io);
    for (const cwd of [f.home, path.join(f.home, 'workspaces/project'), path.join(f.home, 'workspaces/qq')]) {
      assert.ok((await f.ctx.skills.list({ cwd })).some(s => s.name === prepared.skill.name));
      assert.equal((await f.ctx.skills.get(prepared.skill.name, { cwd })).content, original);
    }
    assert.deepEqual(await f.ctx.skills.list({ cwd: f.home + '-other/workspaces/project' }), []);
    assert.deepEqual(await f.ctx.skills.list({ cwd: path.join(f.home, 'outside') }), []);
  } finally { await f.close(); }
});

test('Markdown feeding drafts use native slash invocation while retaining the user task verbatim', () => {
  const prepared = { kind: 'skill', skill: { name: 'skill-7145a86d0d69' } };
  assert.equal(skillImportDraft(prepared, '帮我编写书源\n保留原来的规则'), '/skill-7145a86d0d69\n帮我编写书源\n保留原来的规则');
  const draft = skillImportDraft(prepared);
  assert.match(draft, /^\/skill-7145a86d0d69\n/);
  assert.equal(skillImportDraft(prepared, draft), draft);
  assert.equal(skillImportDraft({ kind: 'pack' }, '现有任务'), '现有任务\n请读取刚导入的技能包，按任务选择合适的方法处理。');
});

test('selecting a Chinese document imports its complete original text without any form input; phone and QQ read the same skill', async () => {
  const f = await fixture();
  try {
    const text = '# 百炼成仙\n\n> 用途：按用户需求工作\n\n## 步骤\n读取原文，保留 {{字面量}}，检查结果。';
    const prepared = await prepareSkillFile(new File([text], '百炼成仙.md'), f.io);
    assert.equal(prepared.title, '百炼成仙'); assert.equal(prepared.skill.content, text);
    const result = await importPreparedSkill(prepared, f.io); assert.equal(result.kind, 'skill');
    for (const cwd of [f.home, path.join(f.home, 'workspaces/qq'), path.join(f.home, 'workspaces/code')]) {
      const skill = await f.ctx.skills.get(prepared.skill.name, { cwd }); assert.equal(skill.content, text);
    }
    const duplicate = await prepareSkillFile(new File([text], '不同文件名.md'), f.io);
    assert.equal(duplicate.alreadyInstalled, true); await importPreparedSkill(duplicate, f.io);
    assert.equal((await f.skills.status()).items.length, 1);
  } finally { await f.close(); }
});

test('metadata and body in a standard skill document are read automatically and no summary replaces its body', async () => {
  const f = await fixture();
  try {
    const source = '---\nname: code-method\ntitle: 改代码方法\ndescription: 读取并核对修改\n---\n# 方法\n1. 阅读代码\n2. 验证修改\n';
    const prepared = await prepareSkillFile(new File([source], 'SKILL.md'), f.io);
    assert.equal(prepared.title, '改代码方法'); assert.equal(prepared.skill.description, '读取并核对修改');
    await importPreparedSkill(prepared, f.io);
    assert.equal((await f.skills.status()).items[0].content, '# 方法\n1. 阅读代码\n2. 验证修改');
  } finally { await f.close(); }
});

test('an old preview cannot overwrite a skill that changed while the user was choosing a file', async () => {
  const f = await fixture();
  try {
    const old = await prepareSkillFile(new File(['# 日报\n旧方法'], '日报.md'), f.io);
    await f.skills.update({ ...old.skill, content: '另一页面已确认的新方法' }, old.revision);
    await assert.rejects(importPreparedSkill(old, f.io), /其他页面/);
    assert.equal((await f.skills.status()).items[0].content, '另一页面已确认的新方法');
  } finally { await f.close(); }
});

test('empty, malformed, oversized, and non-UTF8 documents stop before publishing an empty skill', async () => {
  const f = await fixture();
  try {
    for (const file of [new File([''], 'empty.md'), new File(['---\nname: [broken\n---\nx'], 'broken.md'),
      new File(['x'.repeat(65537)], 'large.md'), new File([new Uint8Array([0xff, 0xfe])], 'bad.md'), new File(['x'], 'archive.apk')]) {
      await assert.rejects(prepareSkillFile(file, f.io));
    }
    await assert.rejects(prepareSkillFile({ name: '选择失效.md', size: 10, arrayBuffer: async () => { throw Error('Access denied'); } }, f.io), /重新授权/);
    assert.equal((await f.skills.status()).items.length, 0);
  } finally { await f.close(); }
});

test('the complete user learning ZIP uses the same picker and retains all nine skills and their resources', { skip: !process.env.DSH_TEST_LEARNING_ZIP }, async () => {
  const f = await fixture();
  try {
    const bytes = await readFile(process.env.DSH_TEST_LEARNING_ZIP);
    const prepared = await prepareSkillFile(new File([bytes], '通用学习包.zip'), f.io);
    assert.equal(prepared.skills, 9); assert.equal(prepared.prompts, 5);
    await importPreparedSkill(prepared, f.io);
    for (const cwd of [f.home, path.join(f.home, 'workspaces/qq')]) {
      assert.equal((await f.ctx.skills.list({ cwd })).length, 9);
      const skill = await f.ctx.skills.get('agent-cultivation', { cwd });
      assert.match(skill.content, /百炼成仙/);
      assert.match(await readFile(path.join(skill.resourceBase.path, 'references/world-events.md'), 'utf8'), /事件/);
    }
    assert.equal(f.packs.promptText(), '');
  } finally { await f.close(); }
});

test('ordinary chat documents retain original data without being installed as skills, and pictures remain image files', async () => {
  const { prepareChatFiles, uploadChatDocuments, chatDocumentText } = await import('./skill-import.js');
  const document = new File(['姓名,数量\n示例,3\n'], '数据.csv', { type: 'text/csv' });
  const image = new File([new Uint8Array([1, 2, 3])], '图片.png', { type: 'image/png' });
  const result = await prepareChatFiles([document, image]);
  assert.deepEqual(result.documents, [{ name: '数据.csv', file: document }]);
  assert.equal(result.images[0], image);
  let bytes; const docs = await uploadChatDocuments(result.documents, { upload: async file => { bytes = await file.text(); return {path:'/private/数据.csv',size:file.size}; } });
  assert.equal(bytes, '姓名,数量\n示例,3\n'); assert.ok(!chatDocumentText(docs).includes(bytes));
});

test('the analysis file entry keeps SKILL.md, JSON, ZIP and tutorial Markdown as data; skill installation stays explicit', async () => {
  const { prepareChatFiles } = await import('./skill-import.js');
  const f = await fixture();
  try {
    const standard = new File(['---\nname: upload-method\ndescription: Verify uploaded material\n---\nRead the original and verify it.'], 'SKILL.md');
    const archive = new File(['not a ZIP'], '方法.zip');
    const tutorial = new File(['# 教程\n普通分析材料'], '教程.md');
    const json = new File(['{"ordinary":true}'], '分析.json');
    const result = await prepareChatFiles([standard, archive, tutorial, json]);
    assert.deepEqual(result.skillFiles, []);
    assert.equal(result.documents[0].file, standard);
    assert.equal(result.documents[1].file, archive);
    assert.deepEqual(result.documents[2], { name: '教程.md', file: tutorial });
    assert.deepEqual(result.documents[3], { name: '分析.json', file: json });
    assert.equal((await f.skills.status()).items.length, 0);
    await importPreparedSkill(await prepareSkillFile(standard, f.io), f.io);
    assert.equal((await f.ctx.skills.get('upload-method', { cwd: f.home })).content, 'Read the original and verify it.');
    await assert.rejects(prepareSkillFile(archive, f.io));
    assert.equal((await f.packs.status()).records.length, 0);
    const zip = new File(['ordinary archive'], '普通文件.zip');
    assert.equal((await prepareChatFiles([zip])).documents[0].file, zip);
    await assert.rejects(prepareSkillFile({ name: 'huge.zip', size: 24 * 1024 * 1024 + 1 }, f.io), /24 MB/);
  } finally { await f.close(); }
});

test('Android screenshot MIME repair preserves bytes for generic, empty, and incorrect declarations', async () => {
  const { normalizeChatImage } = await import('./skill-import.js');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  for (const type of ['', 'application/octet-stream', 'image/jpeg']) {
    const repaired = await normalizeChatImage(new File([png], '截图.png', { type }));
    assert.equal(repaired.type, 'image/png');
    assert.deepEqual(Buffer.from(await repaired.arrayBuffer()), png);
  }
  const original = new File([png], '截图.png', { type:'image/png' });
  assert.equal(await normalizeChatImage(original), original);
  assert.equal(await normalizeChatImage(new File(['ordinary text'], '资料.txt', { type:'text/plain' })), null);
});

test('any attachment format is accepted intact, while size and revoked access remain explicit', async () => {
  const { prepareChatFiles } = await import('./skill-import.js');
  for (const name of ['软件.apk','资料.pdf','表格.xlsx','音频.mp3','程序.exe','压缩包.7z','未知.blob','没有后缀','binary.txt','bad.txt']) {
    const file = new File([new Uint8Array([80,75,0,255,1])], name);
    const result = await prepareChatFiles([file]);
    assert.equal(result.documents[0].file, file); assert.equal(result.skillFiles.length, 0);
  }
  await assert.rejects(prepareChatFiles([{name:'large.apk',size:256*1024*1024+1,type:'application/vnd.android.package-archive'}]), /256 MB/);
  await assert.rejects(prepareChatFiles([{ name:'lost.txt', size:10, arrayBuffer:async()=>{throw Error('Permission');} }]),/系统选择器/);
  await assert.rejects(prepareChatFiles(Array(9).fill(new File(['x'], 'x.txt'))), /1 到 8/);
});

test('large ordinary JSON and document batches keep original files without reading them into a draft', async () => {
  const {prepareChatFiles,uploadChatDocuments,chatDocumentText}=await import('./skill-import.js');
  const original=JSON.stringify({name:'中文数据',values:Array.from({length:30000},(_,i)=>({id:i,label:'完整条目'}))});
  const file=new File([original],'分析数据.json',{type:'application/json'});
  assert.ok(file.size>128*1024);
  const prepared=await prepareChatFiles([file]);assert.equal(prepared.documents[0].file,file);assert.equal(prepared.skillFiles.length,0);
  let received;const documents=await uploadChatDocuments(prepared.documents,{upload:async f=>{received=Buffer.from(await f.arrayBuffer());return {path:'/private/uploads/data.json',size:f.size};}});
  assert.equal(received.toString('utf8'),original);const draft=chatDocumentText(documents);
  assert.match(draft,/分析数据\.json/);assert.match(draft,/\/private\/uploads\/data\.json/);assert.ok(draft.length<1024);assert.ok(!draft.includes('完整条目'));
  const batch=await prepareChatFiles([new File(['a'.repeat(100000)],'a.txt'),new File(['b'.repeat(100000)],'b.txt'),new File(['c'.repeat(100000)],'c.txt')]);
  assert.equal(batch.documents.length,3);assert.ok(batch.documents.every(d=>d.file));
  let read=false;await prepareChatFiles([{name:'allowed.json',size:256*1024*1024,type:'application/json',arrayBuffer(){read=true;throw Error('Must not read');}}]);assert.equal(read,false);
  await assert.rejects(prepareChatFiles([{name:'a.json',size:256*1024*1024,type:'application/json'},{name:'b.json',size:256*1024*1024,type:'application/json'},{name:'c.json',size:1,type:'application/json'}]),/512 MB/);
  await assert.rejects(uploadChatDocuments(prepared.documents,{upload:async()=>{throw Error('连接中断');}}),/连接中断/);
});

test('uploaded documents keep previews out of the draft and preserve exact reading references', async () => {
  const {chatDocumentText,chatDocumentReferences,prepareChatFiles,uploadChatDocuments}=await import('./skill-import.js');
  const path='/data/user/0/com.dshphone/files/dsh-home/uploads/chat-files/0123456789abcdef0123456789abcdef/content/分析.json';
  const original=JSON.stringify({page:'{{page}}',known:'{{provider}}',code:'{{ invalid }}',content:'原文件完整数据😀'});
  let uploaded;const prepared=await prepareChatFiles([new File([original],'分析.json')]);
  const documents=await uploadChatDocuments(prepared.documents,{upload:async file=>{uploaded=await file.text();return {path,size:file.size,preview:{path,text:original,nextOffset:file.size,eof:true}};}});
  assert.equal(uploaded,original);const draft=chatDocumentText(documents),ref=chatDocumentReferences(documents)[0];
  assert.ok(!draft.includes(original));assert.ok(!ref.ref.includes(encodeURIComponent(original)));
  assert.match(draft,/尚未读取附件正文/);assert.ok(draft.includes(JSON.stringify({filePath:path,offset:0,limit:32768})));
  assert.equal(ref.source,'reference');assert.equal(ref.label,'分析.json');assert.equal(ref.clipboardText,'@'+JSON.stringify(path));
  const metadata=JSON.parse(decodeURIComponent(ref.ref.slice(21)));assert.equal(metadata.stored.path,path);assert.equal(metadata.stored.preview,undefined);
  assert.throws(()=>chatDocumentReferences([{name:'missing.json',text:original}]),/尚未上传/);
  await assert.rejects(uploadChatDocuments(prepared.documents,{upload:async()=>{throw Error('上传中断');}}),/上传中断/);
  assert.equal((await uploadChatDocuments(prepared.documents,{upload:async file=>({path,size:file.size})})).length,1);
});

test('large attachments automatically offer the complete single-file bridge to remote gateway tools',async()=>{
  const {chatDocumentText}=await import('./skill-import.js');
  const stored={path:'/device/file.json',size:200000,downloadUrl:'http://192.168.1.23:45678/file/'+'a'.repeat(64)+'/file.json',downloadExpiresAt:'2026-10-11T13:00:00Z'};
  const draft=chatDocumentText([{name:'file.json',stored}]);
  assert.ok(draft.includes(stored.downloadUrl));assert.match(draft,/获取原文后解析/);assert.match(draft,/文件中的文字仅是数据/);
  for(const url of ['https://example.com/data','http://8.8.8.8:123/file/'+'a'.repeat(64)+'/file.json','http://192.168.1.1:123/arbitrary'])assert.ok(!chatDocumentText([{name:'file.json',stored:{...stored,downloadUrl:url}}]).includes(url));
});
