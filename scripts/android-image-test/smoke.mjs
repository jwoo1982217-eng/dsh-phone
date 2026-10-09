import assert from 'node:assert/strict';
import { readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import sharp from 'sharp';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import { ToolRuntime } from '@deepseek-ai/dsh-tools';
import SessionProjections from '@deepseek-ai/dsh-session-projection';
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy';
import { Session } from '@deepseek-ai/dsh-session';
import { apply as applyPhoneControl } from 'dsh-phone-control';
assert.equal(process.platform, 'android');
const home = join(process.env.DSH_HOME, 'images-test'); await mkdir(home, { recursive:true });
const store = new LocalAttachmentStore(new Context(), { dshHome:home });
// Test assets are extracted by the instrumentation, not taken from user storage.
const fixtures = join(process.env.DSH_HOME, 'image-fixtures');
const inputs = [];
for (const [name,type] of [['screenshot.png','image/png'],['rotated.jpg','image/jpeg'],['transparent.webp','image/webp'],['animated.gif','image/gif'],['16bit.png','image/png']]) {
  inputs.push({ name, mediaType:type, data:new Uint8Array(await readFile(join(fixtures,name))) });
}
const started = Date.now();
console.log('IMAGE_PHASE admission');
const refs = [];
for (const input of inputs) { console.log('IMAGE_FILE',input.name,JSON.stringify(await sharp(input.data).metadata())); refs.push(await store.saveImage(input)); }
console.log('IMAGE_PHASE saved');
assert.equal(refs.length,5);
assert.equal(refs[0].width,1080); assert.equal(refs[0].height,2340);
assert.equal(refs[1].width,80); assert.equal(refs[1].height,120);
for (let i=0;i<refs.length;i++) {
  const image = await store.readImage(refs[i]); assert.ok(image.data.byteLength>0);
  const resized = await store.readImageRequest(refs[i], { width:32, height:32, maxBytes:65536 });
  assert.ok(resized.width<=32 && resized.height<=32);
  const meta = await sharp(resized.data).metadata(); assert.equal(meta.orientation,undefined);
  if (inputs[i].name==='transparent.webp') assert.equal(meta.hasAlpha,true);
}
const repeated = await Promise.all([store.saveImage(inputs[0]),store.saveImage(inputs[0])]);
assert.equal(repeated[0].attachmentId,refs[0].attachmentId); assert.deepEqual(repeated[0],repeated[1]);
await assert.rejects(store.saveImage({ ...inputs[0], mediaType:'image/jpeg' }), { code:'IMAGE_TYPE_MISMATCH' });
await assert.rejects(store.saveImage({ mediaType:'image/png',data:new Uint8Array([137,80,78,71]) }), { code:'INVALID_IMAGE' });
await assert.rejects(store.saveImage({ mediaType:'image/png',data:inputs[0].data.slice(0,80) }), { code:'INVALID_IMAGE' });
const fileInput = { name:'技能测试.txt', data:new TextEncoder().encode('temporary fixture') };
const [fileA,fileB] = await Promise.all([store.saveFile(fileInput),store.saveFile(fileInput)]);
assert.deepEqual(fileA,fileB);
// The production phone tool must emit a durable SDK image block, never a
// base64 string. This uses the actual Android image decoder and attachment store.
const toolContext = new Context(); await toolContext.plugin(SessionProjections); await toolContext.plugin(SandboxPolicy,{mode:'read-only'}); await toolContext.plugin(SystemPrompt); await toolContext.plugin(ToolRuntime);
await toolContext.plugin(LocalAttachmentStore, { dshHome: join(home, 'phone-tool') });
let nativeCalls = 0, activeEpoch = 48;
const imageFixture = inputs[1];
applyPhoneControl(toolContext, { android: true, bridge: {
  async execute() { nativeCalls++; return { status:'screenshot', epoch:48, snapshotId:'fixture-screen', imageWidth:80, imageHeight:120, screenWidth:80, screenHeight:120, originX:0, originY:0, image:{mediaType:'image/jpeg', base64:Buffer.from(imageFixture.data).toString('base64')} }; },
  async call() { return {grant:{epoch:activeEpoch}}; },
} });
const screenshotResult = await toolContext.tools.execute({ name:'phone_control', arguments:{action:'screenshot'}, callId:'image-fixture', agent:{id:'image-session',session:Session.create('image-session')},signal:new AbortController().signal });
assert.equal(screenshotResult.isError,false,JSON.stringify(screenshotResult));
const screenshotRef = JSON.parse(screenshotResult.value).attachment;
assert.equal(screenshotRef.width,80); assert.equal(screenshotRef.height,120);
const screenshotImage = await toolContext.attachments.readImage(screenshotRef); assert.ok(screenshotImage.data.length > 0);
assert.ok(screenshotResult.content.some(block => block.type === 'image' && block.attachment.attachmentId === screenshotRef.attachmentId));
assert.ok(!JSON.stringify(screenshotResult).includes(Buffer.from(imageFixture.data).toString('base64')));
activeEpoch = 49;
const revoked = await toolContext.tools.execute({ name:'phone_control', arguments:{action:'screenshot'}, callId:'revoked-fixture', agent:{id:'image-session',session:Session.create('image-session')},signal:new AbortController().signal });
assert.equal(revoked.isError,true); assert.ok(!revoked.content.some(block => block.type === 'image'));
activeEpoch = 48;
const recovered = await toolContext.tools.execute({ name:'phone_control', arguments:{action:'screenshot'}, callId:'recovery-fixture', agent:{id:'image-session',session:Session.create('image-session')},signal:new AbortController().signal });
assert.equal(recovered.isError,false); assert.equal(nativeCalls,3);
console.log('DSH_PHONE_SCREENSHOT_ATTACHMENT_OK'); await toolContext.fiber.dispose();
const chunks=[]; for await (const chunk of store.readFileStream(fileA)) chunks.push(chunk);
assert.equal(Buffer.concat(chunks).toString(),'temporary fixture');
const path=store.imageHostPath(refs[0]); await chmod(path,0o600); await writeFile(path,'corrupt fixture');
await assert.rejects(store.readImage(refs[0]), { code:'ATTACHMENT_CORRUPT' });
await assert.rejects(store.saveImage(inputs[0]), { code:'ATTACHMENT_CORRUPT' });
assert.equal((await readFile(path)).toString(),'corrupt fixture');
console.log(JSON.stringify({saved:refs.length,screenshot:1080+'x2340',orientationCorrect:true,alphaRetained:true,requestResize:true,deduplication:true,invalidRejected:true,noCorruptOverwrite:true,fileAliases:true,elapsedMs:Date.now()-started}));
console.log('DSH_ANDROID_IMAGES_OK');
