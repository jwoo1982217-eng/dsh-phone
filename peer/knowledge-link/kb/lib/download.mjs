import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
// Explicit setup only: curl uses the host TLS/network stack when Node fetch cannot connect.
export async function downloadModel(c) {
  const host=process.env.KB_MODEL_HOST||'https://huggingface.co';
  if(!/^https:\/\//.test(host))throw new Error('模型下载必须使用 HTTPS');
  const files=['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','vocab.txt','onnx/model_quantized.onnx'];
  const base=path.join(c.cacheDir,c.model,c.revision==='main'?'':c.revision);
  let receipt=[];
  for(const name of files){
    const file=path.join(base,name);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    if(!fs.existsSync(file)){
      const url=`${host.replace(/\/$/,'')}/${c.model}/resolve/${c.revision}/${name}`,tmp=file+'.download-'+process.pid;
      process.stderr.write('[model] '+name+'\n');
      try{
        await new Promise((resolve,reject)=>{
          const child=spawn('curl',['--fail','--location','--silent','--show-error','--retry','2','--connect-timeout','20','--max-time','180','--output',tmp,url],{stdio:['ignore','ignore','pipe']});
          let err='';child.stderr.on('data',b=>{err+=b.toString().slice(0,2000);});child.on('error',reject);child.on('close',code=>code===0?resolve():reject(new Error(`模型下载失败 ${name}: ${err}`)));
        });
        if(fs.statSync(tmp).size===0)throw new Error('模型文件为空');if(name.endsWith('.json'))JSON.parse(fs.readFileSync(tmp,'utf8'));
        fs.chmodSync(tmp,0o600);fs.renameSync(tmp,file);
      }finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
    }
    receipt.push({name,size:fs.statSync(file).size,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});
  }
  fs.writeFileSync(path.join(base,'kb-model-receipt.json'),JSON.stringify({model:c.model,revision:c.revision,files:receipt},null,2)+'\n',{mode:0o600});
  return receipt;
}
