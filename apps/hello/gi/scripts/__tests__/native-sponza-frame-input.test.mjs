import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('Native Sponza draws its attached source using the current public frame input', () => {
  const source = readFileSync(new URL('../native-sponza.mjs', import.meta.url), 'utf8');
  const contract = readFileSync(
    new URL('../../../../../packages/render/src/render-contract.ts', import.meta.url),
    'utf8',
  );
  assert.match(contract, /readonly source: RenderWorldLease;/);
  assert.match(source, /const attached = renderer\.attach\(world\);/);
  assert.match(source, /const lease = attached\.value;/);
  const draw = source.match(/const submitted = renderer\.draw\(\{([\s\S]*?)\}\);/);
  assert.ok(draw, 'Keep the maintained native draw call directly observable');
  assert.match(draw[1], /\bsource:\s*lease\s*,/);
  assert.match(draw[1], /\bgeometryLane:\s*["']direct["']/);
  assert.doesNotMatch(draw[1], /\b(?:leases|camera|environment)\s*:/);
});

test('Native Sponza initializes the existing hardware control from its closed CLI option', () => {
  const source = readFileSync(new URL('../native-sponza.mjs', import.meta.url), 'utf8');
  assert.match(source, /initialHardwareRayTracing\(option\("hardware-ray-tracing", "on"\)\)/);
  assert.match(source, /let hardwareRayTracing = requestedHardwareRayTracing;/);
  assert.match(source, /field: \{ \.\.\.diffuseGi.field, hardwareRayTracing \}/);
  assert.match(source, /hardwareRayTracing = !hardwareRayTracing;/);
});
