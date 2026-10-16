import { deriveVertexLayoutProjection } from '@forgeax/engine-geometry';
import { expect, it } from 'vitest';
import { resolveMaterialShaderVariantSet } from '../../assembly/factory';
import { resolveGeometryMaterialVariantSet } from '../main-pass-geometry';

it.each([
  false,
  true,
])('preserves the sprite region ABI through geometry and backend selection (boot artifact: %s)', (bootArtifact) => {
  const projection = deriveVertexLayoutProjection({
    position: new Float32Array(12),
    uv: new Float32Array(8),
  });
  const variants = [
    { defines: { STORAGE_BUFFER_AVAILABLE: true, PER_INSTANCE_REGION: true } },
    { defines: { STORAGE_BUFFER_AVAILABLE: true, PER_INSTANCE_REGION: false } },
    { defines: { STORAGE_BUFFER_AVAILABLE: false, PER_INSTANCE_REGION: true } },
    { defines: { STORAGE_BUFFER_AVAILABLE: false, PER_INSTANCE_REGION: false } },
  ];
  const requested = resolveGeometryMaterialVariantSet(
    'forgeax::sprite',
    projection,
    '',
    bootArtifact,
  );
  expect(requested.ok).toBe(true);
  if (!requested.ok) throw requested.error;
  expect(requested.value).toBe('');
  expect(resolveMaterialShaderVariantSet(requested.value, variants, 'webgpu', true)).toBe('');
  expect(resolveMaterialShaderVariantSet(requested.value, variants, 'wgpu-webgl2', false)).toBe(
    'PER_INSTANCE_REGION=true+STORAGE_BUFFER_AVAILABLE=false',
  );
  expect(
    resolveGeometryMaterialVariantSet('forgeax::sprite', projection, undefined, bootArtifact),
  ).toMatchObject({ ok: true, value: undefined });
});
