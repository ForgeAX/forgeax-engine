import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { API_INDEX_PATH, checkApiIndex, renderApiIndex } from '../sdk-api-index.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

test('committed API index matches the Engine sources', () => {
  assert.deepEqual(checkApiIndex(), []);
});

test('renders source signatures, component fields and gotcha references', () => {
  const index = renderApiIndex({
    sections: [['math', ['quat: fromEuler']]],
    gotchas: ['Order: {{pack/guid PACK_SOURCE_KEY_RE}}'],
  });
  assert.match(
    index,
    /`quat \{ fromEuler\(out: Quat, x: number, y: number, z: number, order: EulerOrder\): Quat; \.\.\. \}`/,
  );
  assert.match(index, /`PACK_SOURCE_KEY_RE = \/\^\[a-z0-9\]/);
  const scene = renderApiIndex({ sections: [['scene', ['Transform: pos']]], gotchas: [] });
  assert.match(scene, /`Transform \{ pos: array<f32, 3> = \[0, 0, 0\]; \.\.\. \}` component/);
});

test('fails on a renamed export or member instead of rendering a stale name', () => {
  assert.throws(
    () => renderApiIndex({ sections: [['math', ['quat: fromEulerAngles']]], gotchas: [] }),
    /math quat has no member fromEulerAngles/,
  );
  assert.throws(
    () => renderApiIndex({ sections: [['picking', ['screenToGround']]], gotchas: [] }),
    /@forgeax\/engine\/picking has no export screenToGround/,
  );
});

test('game onboarding links the API index', () => {
  for (const file of ['skills/forgeax-engine-sdk/SKILL.md', 'templates/AGENTS.md']) {
    assert.match(readFileSync(resolve(root, file), 'utf8'), /references\/api-index\.md/, file);
  }
  assert.ok(API_INDEX_PATH.startsWith('skills/forgeax-engine-sdk/references/'));
});
