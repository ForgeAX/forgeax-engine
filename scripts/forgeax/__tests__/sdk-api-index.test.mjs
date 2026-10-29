import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkApiIndex, renderApiIndex } from '../sdk-api-index.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

test('generated API index validates Engine source signatures', () => {
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
});

test('an explicitly selected document must exist and match source generation', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'forgeax-api-index-'));
  const file = resolve(directory, 'api-index.md');
  try {
    assert.match(checkApiIndex(file).join('\n'), /missing or stale/);
    writeFileSync(file, renderApiIndex());
    assert.deepEqual(checkApiIndex(file), []);
    writeFileSync(file, '# Stale index');
    assert.match(checkApiIndex(file).join('\n'), /missing or stale/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
