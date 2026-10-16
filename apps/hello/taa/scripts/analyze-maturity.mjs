#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] ?? 'artifacts/taa-maturity');
const read = name => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
const write = (name, value) => writeFileSync(resolve(root, name), value);
const q = (a, p) => [...a].sort((a,b)=>a-b)[Math.ceil(a.length*p)-1];
const data = read('performance.json');
const pairs = [];
for (const width of [1920,2560,3840]) for (const scale of [0.5,0.67,0.75]) {
  const a = data.windows.filter(w=>w.width===width && w.name.startsWith('native-') && w.name.endsWith(`vs-${scale}`));
  const b = data.windows.filter(w=>w.width===width && w.name.startsWith(`scale-${scale}-`));
  if (a.length!==2 || b.length!==2) throw new Error(`incomplete ABBA ${width}/${scale}`);
  const summarize = windows => Object.fromEntries(['envelopeMs','resolveMs','cpuMs'].map(key=>[key,{ p50:q(windows.flatMap(w=>w.frames.map(f=>f[key])),.5),p95:q(windows.flatMap(w=>w.frames.map(f=>f[key])),.95) }]));
  const native=summarize(a),reduced=summarize(b);
  pairs.push({width,height:a[0].height,scale,native,reduced,gpuP50Gain:1-reduced.envelopeMs.p50/native.envelopeMs.p50,gpuP95Gain:1-reduced.envelopeMs.p95/native.envelopeMs.p95,nativeWindowP50:a.map(w=>w.summary.gpuP50),reducedWindowP50:b.map(w=>w.summary.gpuP50)});
}
write('performance-summary.json',JSON.stringify({definition:'ABBA A1+A2 and B1+B2 pooled descriptive quantiles, 120 frames per mode; no pass sums and no independent-sample significance claim',hardware:data.hardware,pairs},null,2)+'\n');
const nativeCosts = [1920,2560,3840].map(width => {
  const summarize = prefix => {
    const windows = data.windows.filter(w => w.width === width && w.name.startsWith(prefix));
    if (windows.length !== 2 || windows.some(w => w.frames.length !== 60)) throw new Error(`incomplete native AA ABBA ${width}/${prefix}`);
    return Object.fromEntries(['envelopeMs','resolveMs','cpuMs'].map(key => {
      const values = windows.flatMap(w=>w.frames.map(f=>f[key])).filter(Number.isFinite);
      if (values.length !== 120 && key !== 'resolveMs') throw new Error(`missing native cost observation ${width}/${prefix}/${key}`);
      return [key, values.length === 0 ? null : {p50:q(values,.5),p95:q(values,.95)}];
    }));
  };
  return {width,height:data.windows.find(w=>w.width===width).height,noAA:summarize('no-aa-'),taa:summarize('taa-')};
});
write('native-aa-cost.json',JSON.stringify({definition:'same native scene/output ABBA no-AA A1/A2 and TAA B1/B2; 120 frames per mode; complete interval envelope',pairs:nativeCosts},null,2)+'\n');
write('performance-summary.csv','width,height,scale,native_gpu_p50_ms,native_gpu_p95_ms,reduced_gpu_p50_ms,reduced_gpu_p95_ms,gpu_p50_gain,gpu_p95_gain,native_cpu_p50_ms,reduced_cpu_p50_ms,native_resolve_p50_ms,reduced_resolve_p50_ms\n'+pairs.map(p=>[p.width,p.height,p.scale,p.native.envelopeMs.p50,p.native.envelopeMs.p95,p.reduced.envelopeMs.p50,p.reduced.envelopeMs.p95,p.gpuP50Gain,p.gpuP95Gain,p.native.cpuMs.p50,p.reduced.cpuMs.p50,p.native.resolveMs.p50,p.reduced.resolveMs.p50].join(',')).join('\n')+'\n');
const max = Math.max(...pairs.flatMap(p=>[p.native.envelopeMs.p50,p.reduced.envelopeMs.p50]));
const svg=['<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="610" viewBox="0 0 1000 610"><rect width="1000" height="610" fill="white"/><g font-family="sans-serif" font-size="15" fill="#17212b"><text x="20" y="28">Complete GPU frame interval: pooled ABBA p50 (milliseconds)</text><text x="20" y="51">Native TAA (gray) / fixed TAAU (blue); gaps included</text>'];
for (const [i,p] of pairs.entries()) {
 const y=80+i*54;
 svg.push(`<text x="20" y="${y+16}">${p.width} × ${p.height}, ${p.scale}</text>`);
 for (const [j,[mode,color]] of [['native','#637587'],['reduced','#1984a6']].entries()) {
  const v=p[mode].envelopeMs.p50,w=v/max*620;
  svg.push(`<rect x="240" y="${y+j*20}" width="${w}" height="16" fill="${color}"/><text x="${250+w}" y="${y+j*20+13}">${v.toFixed(3)}</text>`);
 }
}
svg.push('<text x="20" y="585">See CSV/raw ticks for p95, CPU, resolve cost and between-window variation.</text></g></svg>');
write('performance.svg',svg.join('\n'));
console.log(JSON.stringify(pairs.map(p=>({width:p.width,scale:p.scale,gain:p.gpuP50Gain,p95Gain:p.gpuP95Gain})),null,2));

// Independent position oracle over the actual completed/replayed frame bytes.
const centroid = pixels => {
  let count = 0, x = 0, y = 0;
  for (let i = 0; i < 64 * 64; i++) if (pixels[i * 4] > 50) {
    count++; x += i % 64; y += Math.floor(i / 64);
  }
  if (count === 0) throw new Error('missing deformation surface');
  return {count, x: x / count, y: y / count};
};
const positions = [];
for (const kind of ['morph','skin']) for (const scale of [1,0.5]) {
  const label = `deformation-${kind}-${scale}`;
  const facts = read(`${label}.json`);
  const before = centroid(readFileSync(resolve(root, `${label}-stationary-live.rgba`)));
  const after = centroid(readFileSync(resolve(root, `${label}-changed-live.rgba`)));
  const expected = facts[1].oracleVelocityX * 64;
  const dx = after.x - before.x, dy = after.y - before.y;
  if (Math.abs(dx - expected) > 1 || Math.abs(dy) > 1) throw new Error(`deformation position oracle failed: ${label}`);
  // A missing/unchanged deformation would violate the same nonzero oracle.
  if (Math.abs(expected) <= 1) throw new Error('position falsifier lost its signal');
  positions.push({kind,scale,before,after,expectedOutputPixelDeltaX:expected,actualOutputPixelDeltaX:dx,actualOutputPixelDeltaY:dy,temporal:facts[1].lanes,decision:facts[1].decision,replay:facts[1].comparison});
}
write('deformation-position.json', JSON.stringify({threshold:'one output pixel quantization; nonzero displacement falsifier',positions},null,2)+'\n');
// The hotspot uses the same nearest-rank descriptive quantiles as the matrix.
const hotspot = read('hotspot.json');
const hotspotPairs = [1920,2560,3840].map(width => {
  const windows = hotspot.windows.filter(window => window.width === width);
  const summarize = mode => {
    const selected = windows.filter(window => window.name.startsWith(mode));
    if (selected.length !== 2 || selected.some(window => window.frames.length !== 60)) throw new Error(`incomplete hotspot ABBA ${width}/${mode}`);
    return {
      ...Object.fromEntries(['gpuMs','cpuMs','resolveMs'].map(key => [key, {
        p50: q(selected.flatMap(window => window.frames.map(frame => frame[key])), .5),
        p95: q(selected.flatMap(window => window.frames.map(frame => frame[key])), .95),
      }])),
      windows: selected.map(window => ({name: window.name, gpuP50: q(window.frames.map(frame => frame.gpuMs), .5), gpuP95: q(window.frames.map(frame => frame.gpuMs), .95)})),
    };
  };
  const array = summarize('array'), bounds = summarize('bounds');
  return {width, height: windows[0].height, array, bounds, gain: {p50: 1-bounds.gpuMs.p50/array.gpuMs.p50, p95: 1-bounds.gpuMs.p95/array.gpuMs.p95}};
});
write('hotspot-summary.json',JSON.stringify({definition:'ABBA pooled nearest-rank quantiles, 120 frames per mode; complete interval envelope',pairs:hotspotPairs},null,2)+'\n');
