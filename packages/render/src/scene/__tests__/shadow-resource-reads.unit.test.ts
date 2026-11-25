import { World } from '@forgeax/engine-ecs';
import {
  type AssetHandle,
  type ParamSchemaEntry,
  ParamSchemaProjectionOwner,
  type ShaderBindingReads,
} from '@forgeax/engine-types';
import { expect, it, vi } from 'vitest';
import {
  captureMaterialSnapshot,
  deriveOwnedMaterialParameters,
  MaterialResource,
} from '../../material-resource';
import { worldRenderResources } from '../../publication/resource-scope';
import { defaultMaterialSnapshot, type MaterialSnapshot } from '../../render-system-extract';
import { ShadowMaterialContent, sameShadowMaterial } from '../material-shadow-content';

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
          materialProgramInputs: {
            shadow: { entryPoints: [{ name: 'vs_main', stage: 'vertex', bindings: reads }] },
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

it('a volatile caster prevents whole-atlas retention while each view still captures all fields', () => {
  const material: MaterialSnapshot = {
    ...snapshot(
      [
        { name: 'movie', type: 'texture2d' },
        { name: 'next', type: 'texture2d' },
      ],
      undefined,
    ),
    videoTextureFields: new Map([['movie', 3 as AssetHandle<'video'>]]),
  };
  const resource = new MaterialResource(material);
  const scope = worldRenderResources(new World());
  const provider = vi.fn((_material: MaterialSnapshot, _name: string) => undefined);
  const atlas = new ShadowMaterialContent(undefined, 'whole-atlas');
  atlas.add(resource, material, scope, provider);
  expect(atlas.requiresAtlasRedraw).toBe(true);
  expect(atlas.same(atlas)).toBe(false);
  expect(provider.mock.calls.map((call) => call[1])).toEqual(['movie']);

  provider.mockClear();
  const view = new ShadowMaterialContent();
  view.add(resource, material, scope, provider);
  expect(view.requiresAtlasRedraw).toBe(false);
  expect(provider.mock.calls.map((call) => call[1])).toContain('next');
  expect(view.same(atlas)).toBe(false);
  expect(atlas.same(view)).toBe(false);
});

it('continues deriving the live borrowed schema after the Pass read contract is prepared', () => {
  const schema: ParamSchemaEntry[] = [{ name: 'first', type: 'texture2d' }];
  const material = snapshot(schema, [{ group: 1, binding: 2 }]);
  expect(capture(material)).toEqual(['first']);
  schema[0] = { name: 'next', type: 'texture2d' };
  expect(capture(material)).toEqual(['next']);
});

it('reads the actual sampler at binding zero when a material changes its handle', () => {
  const base = snapshot([{ name: 'source', type: 'sampler' }], [{ group: 1, binding: 0 }]);
  const material = (handle: number) => ({
    ...base,
    samplerHandles: new Map([['source', handle as AssetHandle<'sampler'>]]),
  });
  expect(sameShadowMaterial(material(3), material(3))).toBe(true);
  expect(sameShadowMaterial(material(3), material(7))).toBe(false);
});

it('reuses an admitted shadow declaration across numeric edits and still resolves live assets', () => {
  const schema = new ParamSchemaProjectionOwner().admit({
    ownerId: 'shadow',
    revision: 1,
    schema: [
      { name: 'tint', type: 'vec4' },
      { name: 'mask', type: 'texture2d' },
    ],
  }).schema;
  const first = captureMaterialSnapshot(snapshot(schema, [{ group: 1, binding: 2 }]));
  const source = MaterialResource.from(first);
  const second = deriveOwnedMaterialParameters(source, first, { tint: [0.5, 0.5, 0.5, 1] });
  if (second === undefined) throw new Error('Expected an owned numeric projection');
  const scope = worldRenderResources(new World());
  const resolved: MaterialSnapshot[] = [];
  for (const resource of [source, second]) {
    new ShadowMaterialContent().add(resource, resource.snapshot, scope, (current, name) => {
      expect(name).toBe('mask');
      resolved.push(current);
      return undefined;
    });
  }
  expect(resolved).toEqual([first, second.snapshot]);
});
