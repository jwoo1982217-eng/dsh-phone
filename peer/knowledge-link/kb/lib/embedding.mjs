import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import * as ort from '../vendor/ort/ort.wasm.bundle.min.mjs';
// The browser build avoids desktop-only native ONNX bindings. All assets are local.
globalThis[Symbol.for('onnxruntime')]=ort;
const {BertTokenizer}=await import('../assets/tokenizers.mjs');
const model=new URL('../assets/model/',import.meta.url);
export async function createEmbedder(c){
 let tokenizer,session;
 async function load(){if(session)return;ort.env.wasm.numThreads=1;ort.env.wasm.wasmPaths=new URL('../vendor/ort/',import.meta.url).href;
 tokenizer=new BertTokenizer(JSON.parse(fs.readFileSync(new URL('tokenizer.json',model))),JSON.parse(fs.readFileSync(new URL('tokenizer_config.json',model))));
 session=await ort.InferenceSession.create(fs.readFileSync(new URL('onnx/model_quantized.onnx',model)),{executionProviders:['wasm']});}
 return {async embed(texts,kind='document'){await load();const vectors=[];
 for(let i=0;i<texts.length;i+=3){const values=texts.slice(i,i+3).map(t=>kind==='query'?c.queryPrefix+t:t);const input=tokenizer(values,{padding:true,truncation:true,max_length:512});const feeds={};for(const name of session.inputNames){const v=input[name];feeds[name]=new ort.Tensor(v.type,v.data,v.dims);}const output=await session.run(feeds);const t=output.last_hidden_state, [batch,length,dim]=t.dims;
 if(dim!==512||batch!==values.length)throw Error('本地模型输出维度无效');for(let n=0;n<batch;n++){const v=Array.from(t.data.subarray(n*length*dim,n*length*dim+dim));const norm=Math.hypot(...v);if(!Number.isFinite(norm)||!norm)throw Error('本地模型向量无效');vectors.push(v.map(x=>x/norm));}}
 return vectors;},async dispose(){if(session){await session.release();session=null;}}};
}
