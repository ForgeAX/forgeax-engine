#!/usr/bin/env node
// Dawn-node smoke: three back-lit leaves. The opaque control must stay dark,
// the transmissive leaf must glow green, and the masked leaf must match the
// control on its masked half and the transmissive leaf on its open half.
// FALSIFY=no-transmission zeroes every factor; the smoke must then fail.
// A second white-furnace scene proves energy conservation: white panels at
// factors 0, 0.5 and 1 under a uniform Skylight must match the opaque white
// control. FALSIFY=additive keeps the full front diffuse on top of the
// transmission lobe (Unreal's raster two-sided foliage composite) and must fail.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReferencePng } from '../../../shared/png-codec.mjs';
import { emitSmokeReceipt, smokeFrameBudget } from '../../../shared/scripts/smoke-receipt.mjs';
import { height, patch, runFoliage, width } from './dawn-harness.mjs';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetFrames = smokeFrameBudget();
const falsify = process.env.FALSIFY;
if (falsify !== undefined && falsify !== 'no-transmission' && falsify !== 'additive') {
  console.error(`[smoke] unknown FALSIFY=${falsify}; expected no-transmission or additive`);
  process.exit(2);
}
const run = await runFoliage({
  appRoot,
  mode: falsify === 'no-transmission' ? 'no-transmission' : 'transmission',
  frames: targetFrames,
});
const pngOut = process.env.SMOKE_PNG_OUT ?? resolve(appRoot, 'artifacts', falsify ? `smoke-${falsify}.png` : 'smoke-frame.png');
mkdirSync(dirname(pngOut), { recursive: true });
writeFileSync(pngOut, writeReferencePng(run.pixels, width, height));

const opaque = patch(run.pixels, [85, 105, 75, 105]);
const leaf = patch(run.pixels, [150, 170, 75, 105]);
const maskedClosed = patch(run.pixels, [202, 212, 75, 105]);
const maskedOpen = patch(run.pixels, [238, 248, 75, 105]);
const fmt = (p) => `luma=${p.luma.toFixed(4)} rgb=[${p.r.toFixed(3)},${p.g.toFixed(3)},${p.b.toFixed(3)}]`;
console.log(`[smoke] opaque ${fmt(opaque)}`);
console.log(`[smoke] leaf ${fmt(leaf)}`);
console.log(`[smoke] masked-closed ${fmt(maskedClosed)}`);
console.log(`[smoke] masked-open ${fmt(maskedOpen)}`);

const failures = [];
if (run.backend !== 'webgpu') failures.push(`backend=${run.backend}`);
if (run.frames < targetFrames) failures.push(`frames=${run.frames} < ${targetFrames}`);
if (run.errors.length > 0) failures.push(`engine errors=${run.errors.map((error) => error.code).join(',')}`);
if (opaque.luma > 0.05) failures.push(`opaque control is lit from behind: ${fmt(opaque)}`);
if (leaf.luma < opaque.luma + 0.15) failures.push(`transmissive leaf is not back-lit: ${fmt(leaf)} vs opaque ${fmt(opaque)}`);
if (!(leaf.g > leaf.r && leaf.g > leaf.b * 1.5)) failures.push(`transmitted light is not leaf-green: ${fmt(leaf)}`);
if (Math.abs(maskedClosed.luma - opaque.luma) > 0.03) failures.push(`masked half transmits: ${fmt(maskedClosed)} vs opaque ${fmt(opaque)}`);
if (maskedOpen.luma < maskedClosed.luma + 0.15) failures.push(`texture mask has no effect: open ${fmt(maskedOpen)} closed ${fmt(maskedClosed)}`);
console.log(`[smoke] backend=${run.backend} frames=${run.frames} png=${pngOut}`);
run.dispose();

const furnace = await runFoliage({
  appRoot,
  scene: 'furnace',
  furnaceMode: falsify === 'additive' ? 'additive' : 'split',
  frames: targetFrames,
});
const furnacePng = resolve(dirname(pngOut), falsify ? `furnace-${falsify}.png` : 'furnace-frame.png');
writeFileSync(furnacePng, writeReferencePng(furnace.pixels, width, height));
// Panel centres at world x -2.85, -0.95, 0.95, 2.85 project to these columns.
const [control, ...split] = [72, 131, 190, 249].map((x) => patch(furnace.pixels, [x - 8, x + 8, 75, 105]));
console.log(`[smoke] furnace control ${fmt(control)}`);
for (const [index, factor] of [0, 0.5, 1].entries()) console.log(`[smoke] furnace factor=${factor} ${fmt(split[index])}`);
if (furnace.frames < targetFrames) failures.push(`furnace frames=${furnace.frames} < ${targetFrames}`);
if (furnace.errors.length > 0) failures.push(`furnace engine errors=${furnace.errors.map((error) => error.code).join(',')}`);
if (control.luma < 0.4 || control.luma > 0.8) failures.push(`furnace control is outside the unsaturated band: ${fmt(control)}`);
for (const [index, factor] of [0, 0.5, 1].entries())
  if (Math.abs(split[index].luma - control.luma) > 0.02)
    failures.push(`furnace factor=${factor} does not conserve energy: ${fmt(split[index])} vs control ${fmt(control)}`);
console.log(`[smoke] furnace png=${furnacePng}`);
furnace.dispose();
if (failures.length > 0) {
  console.error(`[smoke] FAIL - ${failures.join('; ')}`);
  process.exit(1);
}
emitSmokeReceipt('hello-foliage-transmission/smoke', Math.min(run.frames, furnace.frames));
console.log('[smoke] PASS - back-lit leaves transmit tinted diffuse light, the opaque control stays dark, the texture mask gates transmission, and the white furnace conserves energy at every factor');
process.exit(0);
