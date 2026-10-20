import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
const home=process.env.DSH_HOME||path.join(os.homedir(),'.dsh');
const runtime=JSON.parse(fs.readFileSync(path.join(home,'knowledge/runtime.json'),'utf8'));
if(runtime.version!==1||!path.isAbsolute(runtime.cli)||!path.isAbsolute(runtime.config))throw Error('请先启用DSH本机记忆检索');
const r=spawnSync(process.execPath,[runtime.cli,...process.argv.slice(2),'--config',runtime.config],{stdio:'inherit',env:process.env});
if(r.error)throw r.error;process.exitCode=r.status??1;
