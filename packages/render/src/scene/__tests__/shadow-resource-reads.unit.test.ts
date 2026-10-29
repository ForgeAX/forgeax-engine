import { World } from '@forgeax/engine-ecs';
import type { ParamSchemaEntry, ShaderBindingReads } from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import { MaterialResource } from '../../material-resource';
import { worldRenderResources } from '../../publication/resource-scope';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../../render-system-extract';
import { ShadowMaterialContent } from '../material-shadow-content';

function snapshot(
  schema: readonly ParamSchemaEntry[],
  reads: readonly ShaderBindingReads[] | undefined,
): MaterialSnapshot {
  return {
    ...defaultMaterialSnapshot(),
    passes: [
      {
        name: 'shadow',
        program: { module: 'test::shadow-resource-reads' },
        renderState: { tags: { LightMode: 'ShadowCaster' } },
      },
    ],
    materialParamSchema: schema,
    ...(reads === undefined
      ? {}
      : {
          materialEntryPoints: {
            shadow: [{ name: 'vs_main', stage: 'vertex', bindings: reads }],
          },
        }),
  };
}

function capture(value: MaterialSnapshot): readonly string[] {
  const world = new World();
  const selected: string[] = [];
  const prepared = vi.fn((_material: MaterialSnapshot, name: string) => {
    selected.push(name);
    return undefined;
  });
  new ShadowMaterialContent().add(
    new MaterialResource(value),
    value,
    worldRenderResources(world),
    prepared,
  );
  return selected;
}

it('keeps an empty selected resource domain empty without assuming binding zero is numeric', () => {
  const schema: ParamSchemaEntry[] = [
    { name: 'tint', type: 'vec4' },
    { name: 'map', type: 'texture2d' },
  ];
  expect(capture(snapshot(schema, [{ group: 1, binding: 0 }]))).toEqual([]);
  expect(capture(snapshot(schema, [{ group: 2, binding: 2 }]))).toEqual([]);
  // A sampler-only schema has a real resource at zero and no numeric UBO.
  expect(
    capture(snapshot([{ name: 'plainSampler', type: 'sampler' }], [{ group: 1, binding: 0 }])),
  ).toEqual(['plainSampler']);
  expect(capture(snapshot([], [{ group: 1, binding: 0 }]))).toEqual([]);
});

it('keeps unknown read contracts conservative and retains ordered resource selection', () => {
  const schema: ParamSchemaEntry[] = [
    { name: 'tint', type: 'vec4' },
    { name: 'first', type: 'texture2d' },
    { name: 'second', type: 'texture2d' },
  ];
  expect(capture(snapshot(schema, undefined))).toEqual(['first', 'first', 'second', 'second']);
  expect(
    capture(
      snapshot(schema, [
        { group: 1, binding: 4 },
        { group: 1, binding: 1 },
      ]),
    ),
  ).toEqual(['first', 'second']);
  expect(capture(snapshot(schema, [{ group: 1, binding: 99 }]))).toEqual([]);
});

it('continues deriving the live borrowed schema after the Pass read contract is prepared', () => {
  const schema: ParamSchemaEntry[] = [{ name: 'first', type: 'texture2d' }];
  const material = snapshot(schema, [{ group: 1, binding: 2 }]);
  expect(capture(material)).toEqual(['first']);
  schema[0] = { name: 'next', type: 'texture2d' };
  expect(capture(material)).toEqual(['next']);
});
