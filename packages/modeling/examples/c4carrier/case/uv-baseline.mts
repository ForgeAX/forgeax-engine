// usage: node uv-baseline.mts [outFile]
// Prints the turret UV regression numbers: islands, max stretch, utilization, texel density, thin islands, UV digest.
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { measureUv } from '@forgeax/engine-modeling';
import { buildTurretAsset, unwrapLow } from '../asset.ts';

const asset = buildTurretAsset();
const unwrapped = unwrapLow(asset.low);
const mesh = asset.low.editMesh;
const measured = measureUv(mesh);
if (!measured.ok) throw measured.error;
const boxes = new Map<number, { u0: number; v0: number; u1: number; v1: number }>();
const hash = createHash('sha256');
for (const f of mesh.faces()) {
  const id = measured.value.faceIsland[f] as number;
  const box = boxes.get(id) ?? { u0: 1e9, v0: 1e9, u1: -1e9, v1: -1e9 };
  for (const h of mesh.faceHalves(f)) {
    const c = mesh.corner('uv0', h) as Float32Array;
    hash.update(Buffer.from(c.buffer, c.byteOffset, 8));
    box.u0 = Math.min(box.u0, c[0] as number);
    box.v0 = Math.min(box.v0, c[1] as number);
    box.u1 = Math.max(box.u1, c[0] as number);
    box.v1 = Math.max(box.v1, c[1] as number);
  }
  boxes.set(id, box);
}
const thin = [...boxes.values()].filter((b) => {
  const w = (b.u1 - b.u0) * 1024;
  const h = (b.v1 - b.v0) * 1024;
  return Math.min(w, h) < 6 || Math.max(w, h) / Math.max(1e-9, Math.min(w, h)) >= 6;
}).length;
const metrics = (unwrapped.report.diagnostics ?? [])
  .map((d) => d.detail as { metrics?: Record<string, number> } | undefined)
  .find((d) => d?.metrics?.texelsPerMeter !== undefined)?.metrics as Record<string, number>;
const out = {
  islands: measured.value.islands.length,
  maxStretchLinf: Math.max(...measured.value.islands.map((i) => i.stretchLinf)),
  stretchL2: measured.value.stretchL2,
  utilization: metrics.rectUtilization,
  texelsPerMeter: metrics.texelsPerMeter,
  thin,
  flipped: measured.value.flipped,
  zeroArea: measured.value.zeroArea,
  overlapPairs: unwrapped.overlapPairs,
  faces: mesh.faceCount ?? undefined,
  uvSha256: hash.digest('hex').slice(0, 16),
};
const text = `${JSON.stringify(out)}\n`;
const target = process.argv[2];
if (target !== undefined) writeFileSync(target, text);
process.stdout.write(text);
