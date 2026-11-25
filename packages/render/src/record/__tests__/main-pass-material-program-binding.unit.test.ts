import { expect, it, vi } from 'vitest';
import type { GpuDrivenStandardPbrFrameResources } from '../../render-pipeline';
import { defaultMaterialSnapshot } from '../../render-system-extract';
import { publishMaterialBindingPreparer } from '../main-pass';
import type { _InternalRenderPipelineContext } from '../render-context';

const direct = 'game::medium-direct';
const scene = 'game::medium-scene';

function fixture(withPair = true) {
  const world = {};
  const bindingWorld = {};
  const material = {
    ...defaultMaterialSnapshot(1),
    materialShaderId: direct,
    materialProgramKeys: { Forward: direct, Shadow: 'game::medium-shadow' },
    ...(withPair
      ? {
          materialSceneIndexProgramKeys: {
            Forward: { pass: 'forward' as const, specializationKey: scene },
            Shadow: { pass: 'shadow' as const, specializationKey: 'game::medium-shadow-scene' },
          },
        }
      : {}),
  };
  const buffer = {};
  const c = {
    runtime: {},
    world,
    materialSlots: [material],
    materialBindings: [{ entityKey: 17, world: bindingWorld }],
    pipelineState: { materialUniformBuffer: { buffer } },
  } as unknown as _InternalRenderPipelineContext;
  const resources = {} as GpuDrivenStandardPbrFrameResources;
  const groups = new Map([
    [direct, { entries: [{ binding: 0 }, { binding: 1 }] }],
    [scene, { entries: [{ binding: 0 }, { binding: 2 }] }],
  ]);
  const resolve = vi.fn(
    (
      _slot: number,
      row: typeof material,
      _entity: number | undefined,
      _world: unknown,
      address: { byteOffset: number },
      key: string = row.materialShaderId,
    ) => {
      address.byteOffset = 256;
      return groups.get(key);
    },
  );
  const publish = (selected?: ReadonlySet<number>) =>
    publishMaterialBindingPreparer(c, resources, selected, resolve as never);
  return { c, resources, material, resolve, publish, groups, bindingWorld };
}

it('binds the accepted forward scene program with its exact physical group1 layout', () => {
  const f = fixture();
  f.publish();
  const prepared = f.resources.prepareMaterialBinding(0);
  expect(prepared).toMatchObject({ group: f.groups.get(scene), byteOffset: 256 });
  expect(f.resolve).toHaveBeenCalledWith(
    0,
    f.material,
    17,
    f.bindingWorld,
    expect.objectContaining({ byteOffset: 256 }),
    scene,
    undefined,
  );
});

it('uses the program selected by the raster pass even when its layout differs from Forward', () => {
  const f = fixture();
  const depth = 'game::depth-scene';
  const group = { entries: [{ binding: 46 }] };
  f.groups.set(depth, group);
  f.publish();
  expect(f.resources.prepareMaterialBinding(0, 3, depth)?.group).toBe(group);
  expect(f.resolve).toHaveBeenCalledWith(
    0,
    f.material,
    17,
    f.bindingWorld,
    expect.objectContaining({ byteOffset: 256 }),
    depth,
    3,
  );
  expect(f.resources.prepareMaterialBinding(0)?.group).toBe(f.groups.get(scene));
});

it('keeps ordinary direct programs on their existing binding authority', () => {
  const f = fixture(false);
  f.publish();
  expect(f.resources.prepareMaterialBinding(0)?.group).toBe(f.groups.get(direct));
});

it('rejects a missing accepted forward pair without installing the shadow program', () => {
  const f = fixture();
  const programs = f.material.materialSceneIndexProgramKeys;
  if (programs === undefined) throw new Error('Missing fixture scene programs');
  Reflect.deleteProperty(programs, 'Forward');
  f.publish();
  expect(f.resources.prepareMaterialBinding(0)).toBeUndefined();
  expect(f.resolve).not.toHaveBeenCalled();
});

it('preserves membership rejection and retries the original resolver after a failure', () => {
  const f = fixture();
  f.publish(new Set());
  expect(f.resources.prepareMaterialBinding(0)).toBeUndefined();
  expect(f.resolve).not.toHaveBeenCalled();
  f.publish();
  f.resolve.mockImplementationOnce(() => {
    throw new Error('binding not ready');
  });
  expect(() => f.resources.prepareMaterialBinding(0)).toThrow('binding not ready');
  expect(f.resources.prepareMaterialBinding(0)?.group).toBe(f.groups.get(scene));
});

it('reuses the accepted group and observes a real program publication switch', () => {
  const f = fixture();
  f.publish();
  const first = f.resources.prepareMaterialBinding(0)?.group;
  expect(f.resources.prepareMaterialBinding(0)?.group).toBe(first);
  const next = 'game::medium-scene-next';
  const group = { entries: [{ binding: 0 }, { binding: 3 }] };
  f.groups.set(next, group);
  const programs = f.material.materialSceneIndexProgramKeys;
  if (programs === undefined) throw new Error('Missing fixture scene programs');
  Object.assign(f.material, {
    materialSceneIndexProgramKeys: {
      ...programs,
      Forward: { pass: 'forward', specializationKey: next },
    },
  });
  f.publish();
  expect(f.resources.prepareMaterialBinding(0)?.group).toBe(group);
});
