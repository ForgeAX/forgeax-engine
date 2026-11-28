// L4 ready cases for the feature models F1-F3 (see feature-models.ts). The reference is the committed
// triangle mesh; sharp edges come from the evaluator's 30 degree dihedral rule on that reference.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CaseEntry } from './cases.ts';
import { type EvalMesh, parseMesh } from './mesh.ts';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'meshes');

export function loadFeatureMesh(id: string): EvalMesh {
  const parsed = parseMesh(JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')));
  if (!parsed.ok) throw new Error(`committed feature mesh ${id} is invalid`);
  return parsed.mesh;
}

const ready = (id: string, title: string, notes: readonly string[]): CaseEntry => ({
  status: 'ready',
  id,
  title,
  build: () => {
    const mesh = loadFeatureMesh(id);
    return { reference: mesh, identity: mesh, notes };
  },
});

export const FEATURE_CASES: readonly CaseEntry[] = [
  ready(
    'f1-fandisk',
    'F1 fandisk-style part: chamfer ridge, filleted concave step, cylinder hole',
    [
      'kernel-generated triangle mesh, committed under scripts/quad-eval/meshes; genus 1',
      'reference and identity producer are the same mesh (it is an input to quad baselines, not a quad layout)',
    ],
  ),
  ready('f2-pipe-tee', 'F2 flanged pipe tee with eight bolt holes', [
    'kernel mesh booleans of cylinders; genus 8',
    'reference and identity producer are the same mesh (it is an input to quad baselines, not a quad layout)',
  ]),
  ready('f3-twisted-bracket', 'F3 twisted L-bracket sweep with a hole, mixed crease angles', [
    'kernel sweep (60 deg twist over 8 stations) plus a cylinder boolean; genus 1',
    'reference and identity producer are the same mesh (it is an input to quad baselines, not a quad layout)',
  ]),
];
