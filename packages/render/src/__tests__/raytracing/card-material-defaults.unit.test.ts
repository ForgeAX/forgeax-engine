import type { RaySurfaceProgram } from '@forgeax/engine-shader';
import { type MaterialAsset, ok, resolveMaterialAsset } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { packMaterialProgramRow } from '../../material-row';
import {
  createReferenceSurfaceMaterialBindings,
  referenceSurfaceMaterialSnapshot,
} from '../../raytracing/material-bindings';
import { queryTestDevice } from './global-sdf-query-device.fixture';

const normal = {
  texture: '00000000-0000-4000-8000-000000000007',
  coordinates: { set: 1, transform: { offset: [0.25, 0.5] as const } },
};
const replacement = { texture: '00000000-0000-4000-8000-000000000008' };
const program: RaySurfaceProgram = {
  context: 'card-capture',
  wgsl: '',
  contract: 'binding-only-test',
  sourceClosureDigest: 'binding-only-test',
  paramSchema: [
    { name: 'baseColor', type: 'color', default: [0.5, 0.5, 0.5, 1] },
    { name: 'normalTexture', type: 'texture2d' },
  ],
};

function material(values?: MaterialAsset['values']) {
  // The actual material resolver validates defaults without copying them into values.
  const asset = resolveMaterialAsset('proxy', {
    proxy: {
      kind: 'material',
      parameters: [
        { name: 'baseColor', type: 'color', default: [0.5, 0.5, 0.5, 1] },
        { name: 'normalTexture', type: 'texture', default: normal },
      ],
      passes: [{ name: 'Forward', program: { module: 'forgeax_material::standard' } }],
      ...(values === undefined ? {} : { values }),
    },
  }).unwrap().asset;
  return { asset, program };
}

it('retains a resolved default normal texture and its UV coordinates in Card reference bindings', async () => {
  const input = material();
  expect(input.asset.values).toEqual({});
  const device = await queryTestDevice();
  const texture = device
    .createTexture({ size: { width: 2, height: 2 }, format: 'rgba8unorm', usage: 4 })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const sampler = device.createSampler({}).unwrap();
  const resolve = vi.fn(() => ok({ view, sampler }));
  const bindings = createReferenceSurfaceMaterialBindings(device, input, 2, resolve);
  expect(bindings.ok).toBe(true);
  expect(resolve).toHaveBeenCalledExactlyOnceWith(normal);
  expect(referenceSurfaceMaterialSnapshot(input).textureCoordinates?.get('normalTexture')).toEqual(
    normal.coordinates,
  );
  if (bindings.ok) device.destroyBuffer(bindings.value.uniform);
  device.destroyTexture(texture);
});

it('converts the authored default color once at the same Card runtime boundary as an explicit value', () => {
  const a = referenceSurfaceMaterialSnapshot(material());
  const b = referenceSurfaceMaterialSnapshot(material({ baseColor: [0.5, 0.5, 0.5, 1] }));
  expect(a.paramSnapshot?.baseColor).toEqual(b.paramSnapshot?.baseColor);
  expect(a.paramSnapshot?.baseColor).toEqual([
    0.21404114048223255, 0.21404114048223255, 0.21404114048223255, 1,
  ]);
});

it('uses an explicit texture override and preserves an explicitly cleared missing binding', async () => {
  const device = await queryTestDevice();
  const texture = device
    .createTexture({ size: { width: 2, height: 2 }, format: 'rgba8unorm', usage: 4 })
    .unwrap();
  const view = device.createTextureView(texture, {}).unwrap();
  const sampler = device.createSampler({}).unwrap();
  const resolve = vi.fn(() => ok({ view, sampler }));
  const changed = createReferenceSurfaceMaterialBindings(
    device,
    material({ normalTexture: replacement }),
    2,
    resolve,
  );
  expect(changed.ok).toBe(true);
  expect(resolve).toHaveBeenCalledExactlyOnceWith(replacement);
  if (changed.ok) device.destroyBuffer(changed.value.uniform);
  resolve.mockClear();
  // A manually lowered explicit absence must never resurrect the authored default.
  const cleared = createReferenceSurfaceMaterialBindings(
    device,
    { ...material(), asset: { ...material().asset, values: { normalTexture: null } } },
    2,
    resolve,
  );
  expect(cleared.ok).toBe(false);
  expect(resolve).not.toHaveBeenCalled();
  device.destroyTexture(texture);
});

it('preserves the existing numeric vector prefix overlay and its untouched declared tail', () => {
  const schema = [{ name: 'tint', type: 'vec4', default: [1, 2, 3, 4] }] as const;
  const input = {
    asset: {
      kind: 'material' as const,
      parameters: [{ name: 'tint', type: 'vec4' as const, default: [1, 2, 3, 4] }],
      values: { tint: [9, 8] },
    },
    program: { ...program, paramSchema: schema },
  };
  const snapshot = referenceSurfaceMaterialSnapshot(input);
  expect(snapshot.paramSnapshot?.tint).toEqual([9, 8]);
  const bytes = packMaterialProgramRow(schema, snapshot, 16);
  expect(bytes).toBeDefined();
  if (!bytes) throw Error('The actual vector row must be packable');
  expect(Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, 4))).toEqual([9, 8, 3, 4]);
});
