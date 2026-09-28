// Generates the PNG app icons (no dependencies). Run: node make-icons.js
const fs = require('fs'), zlib = require('zlib');
function crc32(buf){let c,crc=0xffffffff;for(let n=0;n<buf.length;n++){c=(crc^buf[n])&0xff;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crc=(crc>>>8)^c;}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td));return Buffer.concat([len,td,crc]);}
function png(size, maskable){
  const bg=[15,17,21], ring=[255,138,61], track=[42,46,56], dot=[77,166,255];
  const raw=Buffer.alloc((size*4+1)*size); const S=4; // supersampling
  const cx=size/2, cy=size/2, scale=maskable?0.72:0.9;
  const R=size*0.36*scale/0.9, W=size*0.11*scale/0.9, rDot=size*0.1*scale/0.9;
  for(let y=0;y<size;y++){raw[y*(size*4+1)]=0;for(let x=0;x<size;x++){
    let acc=[0,0,0];
    for(let sy=0;sy<S;sy++)for(let sx=0;sx<S;sx++){
      const px=x+(sx+.5)/S-cx, py=y+(sy+.5)/S-cy, d=Math.hypot(px,py);
      let col=bg;
      if(Math.abs(d-R)<W/2){let a=Math.atan2(px,-py);if(a<0)a+=2*Math.PI;col=a<Math.PI*1.5?ring:track;}
      else if(d<rDot)col=dot;
      acc[0]+=col[0];acc[1]+=col[1];acc[2]+=col[2];}
    const o=y*(size*4+1)+1+x*4;
    raw[o]=acc[0]/S/S;raw[o+1]=acc[1]/S/S;raw[o+2]=acc[2]/S/S;raw[o+3]=255;}}
  const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(size,0);ihdr.writeUInt32BE(size,4);ihdr[8]=8;ihdr[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
fs.writeFileSync('icons/icon-192.png',png(192));
fs.writeFileSync('icons/icon-512.png',png(512));
fs.writeFileSync('icons/maskable-512.png',png(512,true));
fs.writeFileSync('icons/apple-touch-icon.png',png(180));
console.log('icons written');
