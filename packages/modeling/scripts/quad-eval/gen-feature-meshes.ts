#!/usr/bin/env node
// Rewrites scripts/quad-eval/meshes/*.json (and .obj) from the kernel builders in feature-models.ts.
//   node scripts/quad-eval/gen-feature-meshes.ts [--check]
// --check exits 1 when a committed file differs from what the builders produce now (JSON by value).

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFandisk, buildPipeTee, buildTwistedBracket } from './feature-models.ts';
import type { EvalMesh } from './mesh.ts';

export const FEATURE_MESHES: readonly {
  readonly id: string;
  readonly build: () => EvalMesh;
}[] = [
  { id: 'f1-fandisk', build: buildFandisk },
  { id: 'f2-pipe-tee', build: buildPipeTee },
  { id: 'f3-twisted-bracket', build: buildTwistedBracket },
];

const round = (v: number): number => Math.round(v * 1e9) / 1e9;

export function meshJson(mesh: EvalMesh): string {
  const positions = mesh.positions.map((p) => p.map(round));
  return `${JSON.stringify({ positions, faces: mesh.faces })}\n`;
}

export function meshObj(mesh: EvalMesh): string {
  const lines = mesh.positions.map((p) => `v ${p.map(round).join(' ')}`);
  for (const f of mesh.faces) lines.push(`f ${f.map((i) => i + 1).join(' ')}`);
  return `${lines.join('\n')}\n`;
}

const dir = join(dirname(fileURLToPath(import.meta.url)), 'meshes');

function isSameJson(a: string, b: string): boolean {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
  } catch {
    return false;
  }
}

function main(): number {
  const check = process.argv.includes('--check');
  let stale = 0;
  for (const { id, build } of FEATURE_MESHES) {
    const mesh = build();
    for (const [ext, text] of [
      ['json', meshJson(mesh)],
      ['obj', meshObj(mesh)],
    ] as const) {
      const path = join(dir, `${id}.${ext}`);
      if (check) {
        let have = '';
        try {
          have = readFileSync(path, 'utf8');
        } catch {}
        // JSON is compared by value: the committed file is formatter-normalised, the OBJ is byte-exact.
        const same = ext === 'json' ? isSameJson(have, text) : have === text;
        if (!same) {
          stale++;
          process.stderr.write(`stale: ${path}\n`);
        }
      } else writeFileSync(path, text);
    }
    process.stdout.write(`${id}: ${mesh.positions.length} vertices, ${mesh.faces.length} faces\n`);
  }
  return stale > 0 ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main();
