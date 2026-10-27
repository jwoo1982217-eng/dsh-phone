/** Build version-specific APK-owned OFM rules. Never transplant older release logic. */
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {gunzipSync} from 'node:zlib';import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));
const sourceRoot=process.env.DSH_OFM_SOURCE ?? path.join(root,'our-free-model');
const source=name=>fs.readFileSync(path.join(sourceRoot,name),'utf8');
const fixture=name=>JSON.parse(gunzipSync(fs.readFileSync(path.join(root,'phone-compat/fixtures',name))));
const data=fixture('legacy-compatible-data.json.gz');
const upstream=fixture('upstream-2.5.7.json.gz');
const hash=text=>crypto.createHash('sha256').update(text).digest('hex');
function fn(text,name,indent='    ',exported=false){const start=text.indexOf(indent+(exported?'export ':'')+'function '+name+'(');const end=text.indexOf('\n'+indent+'}',start)+indent.length+2;if(start<0||end<=start)throw Error('Missing reviewed function: '+name);return text.slice(start,end);}
function mount(text){const start=text.indexOf("  let channelPack = { state: 'pending', error: '' }");const end=text.indexOf('\n  const logAdmissionRejection',start);if(start<0||end<start)throw Error('Missing reviewed channel mount');return text.slice(start,end);}
function add(rule,before,after){rule.variants??={};for(const value of[before,after]){const h=hash(value);if(rule.variants[h]!==undefined&&rule.variants[h]!==after)throw Error('Conflicting reviewed recipe');rule.variants[h]=after;}}
if(JSON.parse(source('package.json')).version!=='2.5.7')throw Error('Expected reviewed source version 2.5.7');
const client=source('client.js'),index=source('index.js');
data.format=3;data.reviewedVersions=['2.1.0','2.5.1','2.5.3','2.5.7'];
if(source('src/host-channels.js')!==data.hostChannels)throw Error('Host channel adapter requires independent review');
const latest = { ...data, functions: {}, mount: {}, gate: {}, externalModule: {} };
add(latest.mount,mount(upstream['index.js']),mount(index));
add(latest.gate,fn(upstream['src/vault.js'],'detectSealedHost','',true),fn(source('src/vault.js'),'detectSealedHost','',true));
add(latest.externalModule,upstream['src/open-external.js'],source('src/open-external.js'));
for(const name of['useEacLogin','EacAuth','useChannelRpc']){latest.functions[name]={};add(latest.functions[name],fn(upstream['client.js'],name),fn(client,name));}
data.versionRules={'2.5.7':latest};
latest.sharedPush=fn(client,'sharedPushSource');
for(const rule of data.freeCopy){const key=/^        '([^']+)'/.exec(rule.after)[1];const entries=[...upstream['client.js'].matchAll(new RegExp("        '"+key.replaceAll('.','\\.')+"': [^\\n]+",'g'))].map(m=>m[0]);const language=data.freeCopy.indexOf(rule)%2;const before=entries[language];if(!before)throw Error('Missing reviewed 2.5.7 free copy');if(!rule.before.includes(before))rule.before.push(before);}
const assets=path.join(root,'app/src/main/assets');fs.writeFileSync(path.join(assets,'dsh-ofm-compat-data.json'),JSON.stringify(data)+'\n');fs.copyFileSync(path.join(root,'phone-compat/runtime.mjs'),path.join(assets,'dsh-ofm-compat.mjs'));
console.log('Built reviewed per-version OFM compatibility (2.5.1/2.5.3/2.5.7; legacy 2.1.0)');
