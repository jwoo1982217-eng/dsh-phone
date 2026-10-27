import {createRequire} from 'node:module';
import path from 'node:path';
import {installHttp1Only} from './transport.mjs';
export const name='phone-network-stability';
export function apply(ctx) {
  if(!process.env.DSH_HOME)throw Error('DSH_HOME 尚未就绪');
  const require=createRequire(path.join(process.env.DSH_HOME,'profiles/phone/package.json'));
  const release=installHttp1Only(require('undici'));
  ctx.on('dispose',release);
  console.info('[phone-network-stability] HTTP/1.1 enabled; existing routing and TLS verification retained');
}
