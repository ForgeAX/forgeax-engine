// Local close-up comparison (never published: it contains sheet pixels). For each region
// it renders the Pack with an orthographic sheet view at the sheet's own scale, crops the
// same region of the reference sheet, and writes sheet | model | 50 % overlay.
//
//   node examples/maid-whale/calibrate/compare.mjs <engine-worktree> <pack> <sheet.png> <out-dir>
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodePng, encodePng } from './png.mjs';

/** Regions: [name, view, [u0, u1], [v0, v1]] in view meters (u per the kernel view frame). */
export const REGIONS = [
  ['head-front', 'front', [-0.2, 0.24], [0.58, 0.96]],
  ['head-side', 'right', [-0.2, 0.24], [0.58, 0.96]],
  ['hand-l-front', 'front', [0.1, 0.28], [0.26, 0.44]],
  ['hand-r-front', 'front', [-0.28, -0.1], [0.26, 0.44]],
  ['legs-front', 'front', [-0.16, 0.16], [-0.01, 0.2]],
  ['legs-side', 'right', [-0.16, 0.16], [-0.01, 0.2]],
  ['torso-front', 'front', [-0.26, 0.26], [0.3, 0.66]],
  ['torso-side', 'right', [-0.16, 0.16], [0.3, 0.66]],
  ['torso-back', 'back', [-0.26, 0.26], [0.3, 0.66]],
  ['skirt-front', 'front', [-0.26, 0.26], [0.0, 0.46]],
  ['skirt-side', 'right', [-0.2, 0.2], [0.0, 0.46]],
  ['skirt-back', 'back', [-0.26, 0.26], [0.0, 0.46]],
  ['hair-front', 'front', [-0.3, 0.34], [0.26, 1.0]],
  ['hair-side', 'right', [-0.2, 0.36], [0.26, 1.0]],
  ['hair-back', 'back', [-0.3, 0.3], [0.26, 1.0]],
  ['tail-front', 'front', [-0.02, 0.42], [-0.02, 0.42]],
  ['tail-side', 'right', [-0.08, 0.45], [-0.02, 0.42]],
  ['tail-back', 'back', [-0.12, 0.36], [-0.03, 0.44]],
];
const UPSCALE = 2;

export function compare(engineArg, source, sheetPath, outArg) {
  const engine = resolve(engineArg);
  const project = join(engine, 'packages/modeling');
  const ref = JSON.parse(readFileSync(join(project, 'examples/maid-whale/reference.json'), 'utf8'));
  const sheet = decodePng(readFileSync(sheetPath));
  const ppm = ref.scale.pxPerMeter;
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });
  const cli = join(engine, 'packages/engine/dist/bin/forgeax.mjs');
  const written = [];
  for (const [name, view, [u0, u1], [v0, v1]] of REGIONS.filter(([n]) => !process.env.ONLY || process.env.ONLY.split(',').includes(n))) {
    const w = Math.round((u1 - u0) * ppm * UPSCALE);
    const h = Math.round((v1 - v0) * ppm * UPSCALE);
    // World frame whose view-plane center is the region center (depth: the whole figure).
    const uc = (u0 + u1) / 2;
    const frame = view === 'front' ? [uc - 0.01, v0, -0.5, uc + 0.01, v1, 0.5] : view === 'back' ? [-uc - 0.01, v0, -0.5, -uc + 0.01, v1, 0.5] : [-0.5, v0, -uc - 0.01, 0.5, v1, -uc + 0.01];
    const args = ['model', 'render', '--source', source, '--views', JSON.stringify([view]), '--annotate', 'false', '--scale', String(ppm * UPSCALE), '--width', String(w), '--height', String(h), '--frame', JSON.stringify(frame), '--timeout-ms', '600000', '--json'];
    const parsed = JSON.parse(spawnSync(process.execPath, [cli, ...args], { cwd: project, encoding: 'utf8', maxBuffer: 256 << 20 }).stdout);
    if (!parsed.ok) throw new Error(`${name}: ${JSON.stringify(parsed.error)}`);
    const model = decodePng(readFileSync(join(project, parsed.value.views[0].image)));
    const frameOf = ref.views[view].image;
    const rgba = new Uint8Array(w * 3 * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = u0 + (x + 0.5) / (ppm * UPSCALE);
        const v = v1 - (y + 0.5) / (ppm * UPSCALE);
        const sx = Math.min(sheet.width - 1, Math.max(0, Math.floor(frameOf.axisX + u * ppm)));
        const sy = Math.min(sheet.height - 1, Math.max(0, Math.floor(frameOf.groundY - v * ppm)));
        const s = sheet.rgba.subarray((sy * sheet.width + sx) * 4, (sy * sheet.width + sx) * 4 + 3);
        const m = model.rgba.subarray((y * model.width + x) * 4, (y * model.width + x) * 4 + 3);
        const row = y * w * 3;
        rgba.set([...s, 255], (row + x) * 4);
        rgba.set([...m, 255], (row + w + x) * 4);
        rgba.set([...[0, 1, 2].map((k) => (s[k] + m[k]) >> 1), 255], (row + 2 * w + x) * 4);
      }
    }
    const file = join(out, `${name}.png`);
    writeFileSync(file, encodePng({ width: w * 3, height: h, rgba }));
    written.push(file);
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [engine, source, sheet, out] = process.argv.slice(2);
  for (const f of compare(engine, source, sheet, out)) console.log(f);
}
