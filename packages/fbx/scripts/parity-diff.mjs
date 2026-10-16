#!/usr/bin/env node
// freeze-snapshot.mjs (historically parity-diff.mjs) — re-freeze the parity
// regression snapshots from live ufbx output.
//
// History: during M1 this script double-ran ufbx (WASM) vs the in-repo FBX SDK
// binding to prove field-for-field parity before the SDK was deleted (M2). Once
// the SDK left the repo that diff half became unrunnable, so it was removed; the
// human-signed parity baseline it produced now lives frozen under
// __tests__/__snapshots__/ and parity-snapshot.test.ts asserts live ufbx output
// against it (see that file's header). What remains here is the re-freeze tool:
// it recomputes the compact structural digest from live ufbx and overwrites the
// snapshots. Re-freezing changes the human-signed baseline, so run it only with
// a deliberate parity re-sign (charter: Human as Final Authority).
//
// Usage:
//   pnpm -F @forgeax/engine-fbx build          # dist/ must be current
//   node scripts/parity-diff.mjs               # print each sample's digest
//   node scripts/parity-diff.mjs --freeze      # overwrite __tests__/__snapshots__/*.json
//
// The digest() below MUST stay identical to parity-snapshot.test.ts's copy so
// the freeze and the assertion agree (the .mjs script and the .ts test cannot
// cleanly import each other).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initFbxWasm, parseFbxToObject } from '../dist/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, '..');
const VENDOR = join(PKG, '../../forgeax-engine-assets/vendor/fbx-test');
const SNAP_DIR = join(PKG, '__tests__/__snapshots__');

const SAMPLES = ['cube', 'humanoid'];

const ufbxRaw = (name) =>
  parseFbxToObject(new Uint8Array(readFileSync(join(VENDOR, `${name}.fbx`))));

// A compact, git-friendly structural digest of the raw ufbx output. The full
// raw dump is ~13 MB (dense 9s animation keyframes) — too large to commit — so
// the frozen snapshot captures the parity-critical structure plus representative
// value spot-checks. It stays falsifiable: any bridge regression on counts,
// material, geometry bounds, node roster, or sampled key values trips it.
function bboxOf(vertices) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = vertices[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min: min.map((x) => +x.toFixed(4)), max: max.map((x) => +x.toFixed(4)) };
}
function digest(raw) {
  const meshes = (raw.meshes ?? []).map((m) => ({
    name: m.name,
    vertexFloats: m.vertices.length,
    indexCount: (m.indices ?? []).length,
    bbox: bboxOf(m.vertices),
    attributes: Object.keys(m.attributes ?? {}).sort(),
  }));
  const nodes = (raw.nodes ?? []).map((n) => n.name);
  const materials = (raw.materials ?? []).map((m) => ({
    name: m.name,
    kind: m.kind,
    ...(m.diffuse && { diffuse: m.diffuse.map((x) => +x.toFixed(6)) }),
    ...(m.shininess !== undefined && { shininess: +m.shininess.toFixed(4) }),
    ...(m.stingrayProps && { stingrayProps: m.stingrayProps }),
  }));
  const clips = (raw.clips ?? []).map((c) => ({
    name: c.name,
    duration: +c.duration.toFixed(6),
    channelCount: c.channels.length,
    channelsByProperty: {
      translation: c.channels.filter((ch) => ch.property === 'translation').length,
      rotation: c.channels.filter((ch) => ch.property === 'rotation').length,
      scale: c.channels.filter((ch) => ch.property === 'scale').length,
    },
    // Spot-check the first channel's first/last key so value regressions trip.
    firstChannel: c.channels[0] && {
      targetNode: c.channels[0].targetNode,
      property: c.channels[0].property,
      keyCount: c.channels[0].keyTimes.length,
      firstKeyValues: c.channels[0].keyValues.slice(0, 4).map((x) => +x.toFixed(4)),
    },
  }));
  const skeletons = (raw.skeletons ?? []).map((s) => ({
    jointCount: s.jointCount,
    jointPaths: s.jointPaths,
  }));
  const skins = (raw.skins ?? []).map((s) => ({
    meshSourceIndex: s.meshSourceIndex,
    vertexCount: s.vertexCount,
    jointPathCount: s.jointPaths.length,
  }));
  return { meshes, nodes, materials, clips, skeletons, skins };
}

async function main() {
  const freeze = process.argv.includes('--freeze');
  await initFbxWasm();

  const frozen = {};
  for (const name of SAMPLES) {
    const raw = ufbxRaw(name);
    frozen[name] = digest(raw);
    console.log(`[${name}] ${JSON.stringify(frozen[name]).length} bytes digest`);
  }

  if (freeze) {
    mkdirSync(SNAP_DIR, { recursive: true });
    for (const name of SAMPLES) {
      const dst = join(SNAP_DIR, `${name}-snapshot.json`);
      writeFileSync(dst, `${JSON.stringify(frozen[name], null, 2)}\n`);
      console.log(`froze ${dst}`);
    }
  }

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
