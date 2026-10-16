'use strict';
// Frame boundaries per facebook/zstd doc/zstd_compression_format.md.
// Node 24 may return partial output for a truncated frame, so check structure first.
function frameEnd(buf,start) {
  const need=(at,n)=>{if(at+n>buf.length)throw new Error('帧尚未写完整');};
  need(start,4);const magic=buf.readUInt32LE(start);
  if((magic&0xfffffff0)===0x184d2a50){need(start,8);const end=start+8+buf.readUInt32LE(start+4);need(start,end-start);return {end,skip:true};}
  if(magic!==0xfd2fb528)throw new Error('不是有效 zstd 帧');
  need(start+4,1);const desc=buf[start+4];if(desc&8)throw new Error('zstd 保留位非法');
  const single=!!(desc&32),fcs=desc>>6,dict=[0,1,2,4][desc&3];
  const fcsSize=fcs===0?(single?1:0):[0,2,4,8][fcs];
  let off=start+5+(single?0:1)+dict;need(off,fcsSize);
  let contentSize;
  if(fcsSize){contentSize=0n;for(let i=0;i<fcsSize;i++)contentSize+=BigInt(buf[off+i])<<BigInt(i*8);if(fcsSize===2)contentSize+=256n;}
  off+=fcsSize;
  while(true){need(off,3);const header=buf.readUIntLE(off,3);off+=3;const type=(header>>1)&3,size=header>>>3;if(type===3||size>131072)throw new Error('zstd block 非法');const length=type===1?1:size;need(off,length);off+=length;if(header&1)break;}
  if(desc&4){need(off,4);off+=4;}
  return {end:off,contentSize};
}
module.exports={frameEnd};
