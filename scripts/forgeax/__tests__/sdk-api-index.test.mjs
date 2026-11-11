import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  API_FILE_MAX_BYTES,
  API_INDEX_FILE,
  apiDomain,
  checkApiIndex,
  renderApiIndex,
  renderApiReference,
  writeApiReference,
} from '../sdk-api-index.mjs';

const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

test('generated API index validates Engine source signatures', () => {
  assert.deepEqual(checkApiIndex(), []);
});

test('renders source signatures, component fields and gotcha references', () => {
  const index = renderApiIndex({
    domains: [
      apiDomain([['math', ['quat: fromEuler']]], ['Order: {{pack/guid PACK_SOURCE_KEY_RE}}']),
    ],
  });
  assert.match(
    index,
    /`quat \{ fromEuler\(out: Quat, x: number, y: number, z: number, order: EulerOrder\): Quat; \.\.\. \}`/,
  );
  assert.match(index, /`PACK_SOURCE_KEY_RE = \/\^\[a-z0-9\]/);
  const scene = renderApiIndex({ domains: [apiDomain([['scene', ['Transform: pos']]])] });
  assert.match(scene, /`Transform \{ pos: array<f32, 3> = \[0, 0, 0\]; \.\.\. \}` component/);
});

test('lists Camera exposure and every Atmosphere field', () => {
  const index = renderApiIndex();
  assert.match(
    index,
    /`Camera \{[^`]*exposureMode: f32; compensationEv: f32 = 0; rangeEv: array<f32, 2> = \[-8, 8\]; rates: array<f32, 2> = \[3, 1\];/,
  );
  assert.match(index, /`CAMERA_EXPOSURE_MODE_AUTO = 1`, `CAMERA_EXPOSURE_MODE_MANUAL = 0`/);
  assert.match(index, /`exposure` is then the fallback multiplier/);
  const atmosphere = /`Atmosphere \{ ([^`]*) \}` component/.exec(index)?.[1] ?? '';
  assert.doesNotMatch(atmosphere, /\.\.\./);
  for (const field of ['planetRadius', 'mieAnisotropy', 'sunAngularRadius: f32 = 0.004675'])
    assert.ok(atmosphere.includes(field), field);
});

test('lists enum codes beside their names', () => {
  const index = renderApiIndex();
  assert.match(index, /`CAMERA_EXPOSURE_MODE_AUTO = 1`, `CAMERA_EXPOSURE_MODE_MANUAL = 0`/);
  assert.match(index, /`FogModeValue = \{ exp: 0, exp2: 1, linear: 2 \}`/);
  assert.match(index, /mode: enum FogModeValue = FogModeValue\.exp;/);
  assert.match(index, /`Fog \{[^`]*skyOpacity: f32 = 1;/);
  // Values that are not codes stay bare.
  assert.match(index, /`Time`, `FixedTime`/);
});

test('fails on a renamed export or member instead of rendering a stale name', () => {
  assert.throws(
    () => renderApiIndex({ domains: [apiDomain([['math', ['quat: fromEulerAngles']]])] }),
    /math quat has no member fromEulerAngles/,
  );
  assert.throws(
    () => renderApiIndex({ domains: [apiDomain([['picking', ['screenToGround']]])] }),
    /@forgeax\/engine\/picking has no export screenToGround/,
  );
});

test('game onboarding links the API index', () => {
  for (const file of ['skills/forgeax-engine-sdk/SKILL.md', 'templates/AGENTS.md']) {
    assert.match(readFileSync(resolve(root, file), 'utf8'), /references\/api-index\.md/, file);
  }
});

test('splits the reference into a directory and small domain files it links', () => {
  const files = renderApiReference();
  const index = files[API_INDEX_FILE];
  const linked = [...index.matchAll(/\]\((api\/[a-z0-9-]+\.md)\)/g)].map((match) => match[1]);
  assert.deepEqual(
    linked.sort(),
    Object.keys(files)
      .filter((path) => path !== API_INDEX_FILE)
      .sort(),
  );
  assert.ok(linked.length >= 3);
  for (const [path, content] of Object.entries(files)) {
    assert.ok(Buffer.byteLength(content) <= API_FILE_MAX_BYTES, `${path} is too large`);
    if (path !== API_INDEX_FILE) assert.ok(content.includes(`](../${API_INDEX_FILE})`), path);
  }
  // Each facade section lands in exactly one domain file.
  const sections = Object.values(files).flatMap((content) =>
    [...content.matchAll(/^## `@forgeax\/engine\/[^`]+`$/gm)].map((match) => match[0]),
  );
  assert.equal(new Set(sections).size, sections.length);
  assert.match(files['api/render.md'], /`PointLight \{/);
  // Every geometry factory keeps its signature, not just its name.
  for (const factory of ['createSphereGeometry(radius: number', 'createTorusGeometry(radius'])
    assert.ok(files['api/geometry.md'].includes(factory), factory);
  assert.doesNotMatch(files['api/geometry.md'], /Also: `createSphereGeometry`/);
  // The playthrough helper has its own domain file with every PlayContext member.
  for (const member of ['step<T>(', 'waitFor<T>(', 'advance<T>(', 'look(dx: number', 'screenshot('])
    assert.ok(files['api/play.md'].includes(member), member);
  assert.match(files['api/play.md'], /`PlayAdvanceOptions \{ stepSeconds\?: number/);
  assert.match(
    files['api/render.md'],
    /Light units: `PointLight` \/ `SpotLight` `intensity` is candela/,
  );
});

test('explicitly selected documents must exist and match source generation', () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'forgeax-api-index-'));
  try {
    assert.match(checkApiIndex(directory).join('\n'), /missing or stale/);
    writeApiReference(directory);
    assert.deepEqual(checkApiIndex(directory), []);
    writeFileSync(resolve(directory, 'api/render.md'), '# Stale index');
    assert.match(checkApiIndex(directory).join('\n'), /api\/render\.md: missing or stale/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
