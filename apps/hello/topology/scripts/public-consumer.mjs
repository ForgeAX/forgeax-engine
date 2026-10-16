#!/usr/bin/env node
// Public consumer contract for the focused Points/Lines carrier.
//
// This script deliberately imports only public package barrels. It is the
// carrier red test until src/main.ts exposes both frozen evidence lanes.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Lines,
  Materials,
  Points,
  admitPointsLines,
} from '@forgeax/engine-render';
import { buildMeshAttributeMapForUvSets } from '@forgeax/engine-geometry';

const here = resolve(fileURLToPath(new URL('.', import.meta.url)));
const mainSource = readFileSync(resolve(here, '..', 'src', 'main.ts'), 'utf8');
const lanes = ['webgpu', 'wgpu-webgl2'];
const forbidden = [
  'constructRuntimeRendererHost',
  'encoder',
  'graph key',
  'shaderModule',
  'backendKind ===',
];

function assert(condition, message) {
  if (!condition) throw new Error(`[public-consumer] ${message}`);
}

function authoringMesh(topology) {
  const positions = new Float32Array(
    topology === 'point-list'
      ? [-0.25, 0, 0, 0.25, 0, 0]
      : [-0.5, 0, 0, 0.5, 0, 0],
  );
  return {
    kind: 'mesh',
    vertices: positions,
    attributes: {
      ...buildMeshAttributeMapForUvSets(1),
      position: positions,
    },
    submeshes: [{
      indexOffset: 0,
      indexCount: 0,
      vertexCount: positions.length / 3,
      topology,
      materialSlot: 0,
    }],
    materialSlots: [{ slotName: 'public-points-lines' }],
  };
}

const material = Materials.unlit([0.1, 0.9, 1, 1]);
const pointMesh = authoringMesh('point-list');
const lineMesh = authoringMesh('line-list');
const pointAdmission = admitPointsLines({
  entity: 1,
  points: { sizePx: 4, shape: 0 },
  mesh: pointMesh,
  material,
});
const lineAdmission = admitPointsLines({
  entity: 2,
  lines: { width: 4 },
  mesh: lineMesh,
  material,
});

assert(Points.name === 'Points', 'public Points component is unavailable');
assert(Lines.name === 'Lines', 'public Lines component is unavailable');
assert(pointAdmission.ok, 'public Points authoring was refused');
assert(lineAdmission.ok, 'public Lines authoring was refused');
for (const lane of lanes) {
  assert(mainSource.includes(`evidenceLane=${lane}`), `missing focused route for ${lane}`);
}
for (const token of forbidden) {
  assert(!mainSource.includes(token), `private implementation token leaked: ${token}`);
}

console.log(JSON.stringify({
  lanes,
  authoring: {
    pointComponent: Points.name,
    lineComponent: Lines.name,
    material: 'Materials.unlit',
    pointAdmission: pointAdmission.value,
    lineAdmission: lineAdmission.value,
  },
}));
