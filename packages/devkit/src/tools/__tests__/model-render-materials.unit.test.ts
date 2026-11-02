import type { MaterialAsset, TextureAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { materialBindingOf, planMaterials } from '../model-render.js';

const GREEN = '01900000-0000-7000-8000-00000000a0f4';
const FOREIGN = '01900000-0000-7000-8000-0000000000ff';
const texture = { kind: 'texture' } as TextureAsset;
const material = (values: Record<string, unknown>, extra: object = {}) =>
  ({ kind: 'material', values, ...extra }) as unknown as MaterialAsset;

describe('model.render --materials planning', () => {
  it('binds slots that have a Pack material and falls back to the palette for the rest', () => {
    const plan = planMaterials(['paint', 'trim'], {
      materials: { paint: material({ baseColor: [1, 1, 1, 1] }) },
      textures: {},
    });
    if ('ok' in plan) throw new Error('plan failed');
    expect(materialBindingOf(['paint', 'trim', 'paint'], plan)).toEqual([
      { slot: 'paint', source: 'pack' },
      { slot: 'trim', source: 'palette' },
    ]);
  });

  it('without a Pack every slot is palette, and the render-owned slots are reserved', () => {
    const plan = planMaterials(['paint'], undefined);
    if ('ok' in plan) throw new Error('plan failed');
    expect(materialBindingOf(['paint', 'highlight', 'xray', 'Default'], plan)).toEqual([
      { slot: 'paint', source: 'palette' },
      { slot: 'highlight', source: 'reserved' },
      { slot: 'xray', source: 'reserved' },
      { slot: 'Default', source: 'palette' },
    ]);
  });

  it('never binds a Pack material to the reserved slots; Default is an ordinary name', () => {
    const plan = planMaterials(['highlight', 'xray', 'Default'], {
      materials: { highlight: material({}), xray: material({}), Default: material({}) },
      textures: {},
    });
    if ('ok' in plan) throw new Error('plan failed');
    expect(materialBindingOf(['highlight', 'xray', 'Default'], plan)).toEqual([
      { slot: 'highlight', source: 'reserved' },
      { slot: 'xray', source: 'reserved' },
      { slot: 'Default', source: 'pack' },
    ]);
  });

  it('ignores Pack outputs without a slot, even when they hold unresolvable GUIDs', () => {
    const plan = planMaterials(['paint'], {
      materials: {
        paint: material({ baseColor: [1, 1, 1, 1] }),
        elsewhere: material({ baseColorTexture: FOREIGN }),
        constructor: material({}),
      },
      textures: {},
    });
    if ('ok' in plan) throw new Error('plan failed');
    expect([...plan.packed.keys()]).toEqual(['paint']);
  });

  it('accepts same-Pack texture GUIDs in bare and sampler forms', () => {
    const plan = planMaterials(['a', 'b'], {
      materials: {
        a: material({ baseColorTexture: GREEN }),
        b: material({ baseColorTexture: { texture: GREEN, coordinates: { set: 0 } } }),
      },
      textures: { [GREEN]: texture },
    });
    expect('ok' in plan).toBe(false);
  });

  it('fails a bound material holding any other GUID with the slot and GUID', () => {
    const cases: [string, MaterialAsset][] = [
      ['texture', material({ baseColorTexture: FOREIGN })],
      ['nested', material({ baseColorTexture: { texture: GREEN, sampler: FOREIGN } })],
      ['parent', { kind: 'material', parent: FOREIGN } as unknown as MaterialAsset],
      ['module', material({}, { passes: [{ program: { module: FOREIGN } }] })],
    ];
    for (const [name, asset] of cases) {
      const plan = planMaterials(['paint'], {
        materials: { paint: asset },
        textures: { [GREEN]: texture },
      });
      expect(plan, name).toMatchObject({
        ok: false,
        error: {
          code: 'model-render-material-load-failed',
          detail: { slot: 'paint', guid: FOREIGN },
        },
      });
    }
  });
});
