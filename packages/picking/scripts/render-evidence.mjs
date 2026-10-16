import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import UPNG from 'upng-js';
import { halfToFloat } from '../../rhi-debug/dist/index.mjs';

const directory = resolve(process.argv[2] ?? 'artifacts/skinned-triangle-picking/browser');
const cards=[];
for(const name of ['rest','posed']) {
  const metadata=JSON.parse(readFileSync(`${directory}/${name}-image.json`));
  const facts=JSON.parse(readFileSync(`${directory}/${name}-inspection.json`));
  const input=readFileSync(`${directory}/${name}.rgba16f`);
  const view=new DataView(input.buffer,input.byteOffset,input.byteLength);
  const pixels=new Uint8Array(metadata.width*metadata.height*4);
  for(let y=0;y<metadata.height;y++) for(let x=0;x<metadata.width;x++) {
    const at=y*metadata.bytesPerRow+x*8;
    for(let c=0;c<3;c++) {
      const linear=Math.min(1,Math.max(0,halfToFloat(view.getUint16(at+c*2,true))));
      const srgb=linear<=0.0031308?linear*12.92:1.055*linear**(1/2.4)-0.055;
      pixels[(y*metadata.width+x)*4+c]=Math.round(srgb*255);
    }
    pixels[(y*metadata.width+x)*4+3]=255;
  }
  writeFileSync(`${directory}/${name}-readback.png`,Buffer.from(UPNG.encode([pixels.buffer],metadata.width,metadata.height,0)));
  const circles=facts.picks.map(p=>`<circle cx="${p.pixel[0]+0.5}" cy="${p.pixel[1]+0.5}" r="1.1"/>`).join('');
  cards.push(`<article><h2>${name === 'rest' ? 'Rest pose' : 'Current blended pose'}</h2><div class="image"><img src="${name}-readback.png"><svg viewBox="0 0 128 128">${circles}</svg></div><p>${facts.hits} hits + ${facts.misses} misses = ${facts.checked} checked pixels</p><p>GPU replay max error: ${facts.replayDelta} · Deleted draw control: ${facts.falsifierDelta}</p></article>`);
}
const html=`<!doctype html><meta charset="utf-8"><title>Current skin triangle picking</title><style>body{margin:0;background:#0f1720;color:#e8eef5;font:16px system-ui;padding:28px;width:1100px;box-sizing:border-box}h1{margin:0 0 8px;font-size:28px}h2{font-size:20px;margin:16px 0 12px}.cards{display:flex;gap:24px}.image{position:relative;width:510px;height:510px;background:black;border:1px solid #344456}.image img{width:100%;height:100%;image-rendering:pixelated}.image svg{position:absolute;inset:0;width:100%;height:100%;fill:#00dda9;stroke:white;stroke-width:.3}p{margin:8px 0;color:#b9c7d6;font-size:14px}footer{margin-top:18px;color:#91a7bb;font-size:13px}</style><h1>Exact triangle picking follows the current skeleton</h1><p>Browser WebGPU · Two joints · Four-influence weights · Hierarchy + inverse binds + non-uniform scale</p><div class="cards">${cards.join('')}</div><footer>Actual 128 × 128 linear-HDR readback, displayed in sRGB at 4× scale. Green markers are verified CPU triangle hits.<br>60 completed frames. Near-edge samples are excluded from raster comparison. Palette and vertex inputs were inspected from the same RHI tape.</footer>`;
writeFileSync(`${directory}/evidence.html`,html);
const browser=await chromium.launch({channel:process.env.FORGEAX_CHROME_CHANNEL ?? 'chrome',headless:true, chromiumSandbox: true});
try {
  const page=await browser.newPage({viewport:{width:1100,height:760},deviceScaleFactor:1});
  await page.goto(pathToFileURL(`${directory}/evidence.html`).href);
  await page.screenshot({path:`${directory}/comparison.png`,fullPage:true});
} finally {await browser.close();}
