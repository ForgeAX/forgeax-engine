import { rhi } from '@forgeax/engine-rhi-null';
import { expect, it, vi } from 'vitest';
import { matchedMaterialsForRecordMode } from '../main-pass';
import { CPU_SETUP_SHADER, cpuSetupFixture } from './main-pass-cpu-setup-fixture';

it('selects all material lanes without projecting temporary handle arrays', async () => {
  const device = (await (await rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const module = (await rhi.createShaderModule(device, { code: CPU_SETUP_SHADER })).unwrap();
  const f = cpuSetupFixture(device, module);
  const entry = f.add({ entity: 1 });
  const opaque = { ...entry.source.material, materialHandle: 7 };
  const materials = [
    opaque,
    { ...opaque, materialHandle: 9, transparent: true },
    {
      ...opaque,
      materialHandle: 11,
      materialShaderId: 'forgeax::default-standard-pbr',
      paramSnapshot: { transmission: 1 },
    },
    { ...opaque, materialHandle: 13, surfaceModel: 'single-layer-medium' as const },
    { ...opaque, materialHandle: 9 },
    { ...opaque, materialHandle: undefined },
  ];
  Object.assign(entry.source, { materials });
  const projection = vi.spyOn(materials, 'map').mockImplementation(() => {
    throw new Error('material handle projection allocates a temporary array');
  });
  const c = { dispatch: [], validatedOrdered: [entry] };
  const dispatch = new Map([[entry.renderableIndex, new Set([9, 11, 99])]]);
  const selected = (
    mode: Parameters<typeof matchedMaterialsForRecordMode>[2],
    matched: Parameters<typeof matchedMaterialsForRecordMode>[1] = null,
  ) => [...(matchedMaterialsForRecordMode(c, matched, mode)?.get(entry.renderableIndex) ?? [])];
  try {
    expect(matchedMaterialsForRecordMode(c, dispatch, undefined)).toBe(dispatch);
    expect(selected('opaque')).toEqual([7, 0]);
    expect(selected('transparent')).toEqual([9]);
    expect(selected('oit-accumulate')).toEqual([9]);
    expect(selected('oit-residual')).toEqual([9]);
    expect(selected('transmission')).toEqual([]);
    expect(selected('transmission', dispatch)).toEqual([11]);
    expect(selected('opaque', dispatch)).toEqual([99]);
    expect(selected('single-layer-medium-nearest-layer', dispatch)).toEqual([13]);
    expect(selected('single-layer-medium-color')).toEqual([13]);
    expect(projection).not.toHaveBeenCalled();
  } finally {
    projection.mockRestore();
    f.dispose();
  }
});
