// C-600 dotted-edge probe: does the baked low mesh have open edges or T-junction vertices (exact float32 weld)?
// usage: node crack-probe.mts [outDir]; writes <outDir>/crack-probe.json
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { model } from '@forgeax/engine-modeling';
import { LOW_NORMALS } from '../asset.ts';

const outDir = process.argv[2] ?? '/tmp/c4-turret-asset/out';
const m = model({ budget: { work: 4e9 } });
m.append(new Uint8Array(readFileSync('/tmp/c4-turret-asset/work/low-uv.fxem')));
const out = m.toMesh({ normals: LOW_NORMALS });
if (!out.ok) throw out.error;
const mesh = out.value.mesh as any;
const pos: Float32Array = mesh.attributes.position;
const idx = mesh.indices.data ?? mesh.indices;
// edge usage by position key (welding by coordinates)
const key = (i: number) => `${pos[i*3]!.toFixed(9)},${pos[i*3+1]!.toFixed(9)},${pos[i*3+2]!.toFixed(9)}`;
const edges = new Map<string, number>();
for (let t = 0; t < idx.length; t += 3) for (let k = 0; k < 3; k++) {
  const a = key(idx[t+k]), b = key(idx[t+(k+1)%3]);
  const e = a < b ? a + '|' + b : b + '|' + a;
  edges.set(e, (edges.get(e) ?? 0) + 1);
}
let open = 0, over = 0;
for (const v of edges.values()) { if (v === 1) open++; else if (v > 2) over++; }
// T-junctions: vertices lying on the interior of an open edge
const verts = new Map<string, number[]>();
for (let i = 0; i < pos.length / 3; i++) verts.set(key(i), [pos[i*3]!, pos[i*3+1]!, pos[i*3+2]!]);
const openEdges = [...edges].filter(([, v]) => v === 1).map(([e]) => e.split('|').map((s) => s.split(',').map(Number)) as number[][]);
const base = { triangles: idx.length / 3, uniqueEdges: edges.size, openEdges: open, edgesUsedByMoreThanTwoFaces: over };
let t = 0;
const pts = [...verts.values()];
const sample = openEdges.slice(0, 4000);
for (const [a, b] of sample) {
  const d = [b![0]! - a![0]!, b![1]! - a![1]!, b![2]! - a![2]!]; const L2 = d[0]!**2 + d[1]!**2 + d[2]!**2;
  for (const p of pts) {
    const s = ((p[0]! - a![0]!) * d[0]! + (p[1]! - a![1]!) * d[1]! + (p[2]! - a![2]!) * d[2]!) / L2;
    if (s <= 0.001 || s >= 0.999) continue;
    const q = [a![0]! + s * d[0]! - p[0]!, a![1]! + s * d[1]! - p[1]!, a![2]! + s * d[2]!- p[2]!];
    if (q[0]!**2 + q[1]!**2 + q[2]!**2 < 1e-8) { t++; break; }
  }
}
const commit = execSync('git rev-parse HEAD', { cwd: new URL('.', import.meta.url).pathname }).toString().trim();
writeFileSync(join(outDir, 'crack-probe.json'), JSON.stringify({ command: `node examples/c4carrier/case/crack-probe.mts ${outDir}`, commit, weld: 'exact float32 position', ...base, openEdgesChecked: sample.length, withTJunctionVertex: t }, null, 1));
