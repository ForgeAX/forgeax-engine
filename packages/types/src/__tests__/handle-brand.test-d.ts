// handle-brand.test-d - type-level Handle<T extends string, M> brand SSOT
// assertions (feat-20260517-handle-type-unify M1 / D-6 rewrite).
//
// Pairs with packages/ecs/src/__tests__/handle.test-d.ts (regression net for
// the cross-mode rejection invariant) + packages/runtime/src/__tests__/
// asset-registry.test-d.ts (M3, AC-06/13/14 register-side surface).
//
// Imports refer to the file-relative `../handle` SSOT (M1 lives at
// packages/types/src/handle.ts) instead of the top-level `../index` barrel —
// during M1 the barrel still re-exports the legacy 1-arg form from index.ts
// (M2 t10 deletes that line; until then `export * from './handle'` silently
// omits the conflicting `Handle` name per TS spec re-export collision rules
// - see plan-strategy decision D-2 / orchestrator note "path A").
//
// Coverage map (anchors plan-strategy decision D-1 / D-6):
// - Handle<T,M> double-axis brand identity (cross-tag + cross-mode rejection)
// - Handle<T,M> extends number (u32 runtime storage invariant)
// - plain `number` does not extend Handle<...> (untagged u32 rejection)
// - AssetTagMap interface - 15 closed members aligned with Asset.kind 15 tags
// - TagOf<T extends Asset> distributive conditional - 15 tag mappings + 1 never tail
// - toUnique / toShared / unwrapHandle factory return type assertions
//
// Charter mapping: F1 (single-entry IDE autocomplete from
// `@forgeax/engine-types`) + P3 (cross-mode rejection is a TS compile-time
// failure red line) + P4 (consistent abstraction: 3 helpers + brand + map
// co-located).

import { describe, expectTypeOf, it } from 'vitest';
import {
  type AssetTagMap,
  type Handle,
  type SharedHandle,
  type TagOf,
  toShared,
  toUnique,
  type UniqueHandle,
  unwrapHandle,
} from '../handle';
import type {
  AnimationClip,
  Asset,
  AudioClipAsset,
  EquirectAsset,
  FontAsset,
  IesProfileAsset,
  MaterialAsset,
  MeshAsset,
  RenderPipelineAsset,
  SamplerAsset,
  SceneAsset,
  SkeletonAsset,
  SkinAsset,
  TextureAsset,
} from '../index';

describe('Handle<T extends string, M> double-axis brand identity', () => {
  it('Handle<MeshAsset, unmanaged> is not equal to Handle<TextureAsset, unmanaged> (cross-tag rejection)', () => {
    expectTypeOf<Handle<'MeshAsset', 'shared'>>().not.toEqualTypeOf<
      Handle<'TextureAsset', 'shared'>
    >();
  });

  it('Handle<MaterialAsset, unmanaged> is not equal to Handle<SamplerAsset, unmanaged>', () => {
    expectTypeOf<Handle<'MaterialAsset', 'shared'>>().not.toEqualTypeOf<
      Handle<'SamplerAsset', 'shared'>
    >();
  });

  it('Handle<MeshAsset, managed> is not equal to Handle<MeshAsset, unmanaged> (cross-mode rejection)', () => {
    expectTypeOf<Handle<'MeshAsset', 'unique'>>().not.toEqualTypeOf<
      Handle<'MeshAsset', 'shared'>
    >();
  });

  it('Handle<String, managed> is distinct from Handle<MeshAsset, managed>', () => {
    expectTypeOf<Handle<'String', 'unique'>>().not.toEqualTypeOf<Handle<'MeshAsset', 'unique'>>();
  });

  it('Handle<T, M> extends number (u32 runtime storage)', () => {
    expectTypeOf<Handle<'MeshAsset', 'shared'>>().toExtend<number>();
    expectTypeOf<Handle<'TextureAsset', 'shared'>>().toExtend<number>();
    expectTypeOf<Handle<'SamplerAsset', 'shared'>>().toExtend<number>();
    expectTypeOf<Handle<'MaterialAsset', 'shared'>>().toExtend<number>();
    expectTypeOf<Handle<'SceneAsset', 'shared'>>().toExtend<number>();
    expectTypeOf<Handle<'String', 'unique'>>().toExtend<number>();
  });

  it('plain `number` does not extend Handle<T,M> (brand guards against untagged u32)', () => {
    expectTypeOf<number>().not.toExtend<Handle<'MeshAsset', 'shared'>>();
    expectTypeOf<number>().not.toExtend<Handle<'String', 'unique'>>();
  });
});

describe('AssetTagMap — 11-member closed map aligned with Asset.kind tags', () => {
  it('mesh -> MeshAsset', () => {
    expectTypeOf<AssetTagMap['mesh']>().toEqualTypeOf<'MeshAsset'>();
  });

  it('texture -> TextureAsset', () => {
    expectTypeOf<AssetTagMap['texture']>().toEqualTypeOf<'TextureAsset'>();
  });

  it('sampler -> SamplerAsset', () => {
    expectTypeOf<AssetTagMap['sampler']>().toEqualTypeOf<'SamplerAsset'>();
  });

  it('material -> MaterialAsset', () => {
    expectTypeOf<AssetTagMap['material']>().toEqualTypeOf<'MaterialAsset'>();
  });

  it('scene -> SceneAsset', () => {
    expectTypeOf<AssetTagMap['scene']>().toEqualTypeOf<'SceneAsset'>();
  });

  it('equirect -> EquirectAsset', () => {
    expectTypeOf<AssetTagMap['equirect']>().toEqualTypeOf<'EquirectAsset'>();
  });

  it('audio -> AudioClipAsset', () => {
    expectTypeOf<AssetTagMap['audio']>().toEqualTypeOf<'AudioClipAsset'>();
  });

  it('skin -> SkinAsset', () => {
    expectTypeOf<AssetTagMap['skin']>().toEqualTypeOf<'SkinAsset'>();
  });

  it('skeleton -> SkeletonAsset', () => {
    expectTypeOf<AssetTagMap['skeleton']>().toEqualTypeOf<'SkeletonAsset'>();
  });

  it('animation-clip -> AnimationClip', () => {
    expectTypeOf<AssetTagMap['animation-clip']>().toEqualTypeOf<'AnimationClip'>();
  });

  it('render-pipeline -> RenderPipelineAsset (feat-20260601 N+1 member)', () => {
    expectTypeOf<AssetTagMap['render-pipeline']>().toEqualTypeOf<'RenderPipelineAsset'>();
  });

  it('particle-effect -> ParticleEffectAsset', () => {
    expectTypeOf<AssetTagMap['particle-effect']>().toEqualTypeOf<'ParticleEffectAsset'>();
  });

  it('ies-profile -> IesProfileAsset', () => {
    expectTypeOf<AssetTagMap['ies-profile']>().toEqualTypeOf<'IesProfileAsset'>();
  });
});

describe('TagOf<T extends Asset> distributive conditional — 11+1 (never tail)', () => {
  it('TagOf<MeshAsset> = MeshAsset', () => {
    expectTypeOf<TagOf<MeshAsset>>().toEqualTypeOf<'MeshAsset'>();
  });

  it('TagOf<TextureAsset> = TextureAsset', () => {
    expectTypeOf<TagOf<TextureAsset>>().toEqualTypeOf<'TextureAsset'>();
  });

  it('TagOf<SamplerAsset> = SamplerAsset', () => {
    expectTypeOf<TagOf<SamplerAsset>>().toEqualTypeOf<'SamplerAsset'>();
  });

  it('TagOf<MaterialAsset> = MaterialAsset (pass-based single interface, kind: material)', () => {
    expectTypeOf<TagOf<MaterialAsset>>().toEqualTypeOf<'MaterialAsset'>();
  });

  it('TagOf<SceneAsset> = SceneAsset', () => {
    expectTypeOf<TagOf<SceneAsset>>().toEqualTypeOf<'SceneAsset'>();
  });

  it('TagOf<EquirectAsset> = EquirectAsset', () => {
    expectTypeOf<TagOf<EquirectAsset>>().toEqualTypeOf<'EquirectAsset'>();
  });

  it('TagOf<SkinAsset> = SkinAsset', () => {
    expectTypeOf<TagOf<SkinAsset>>().toEqualTypeOf<'SkinAsset'>();
  });

  it('TagOf<SkeletonAsset> = SkeletonAsset', () => {
    expectTypeOf<TagOf<SkeletonAsset>>().toEqualTypeOf<'SkeletonAsset'>();
  });

  it('TagOf<AnimationClip> = AnimationClip', () => {
    expectTypeOf<TagOf<AnimationClip>>().toEqualTypeOf<'AnimationClip'>();
  });

  it('TagOf<AudioClipAsset> = AudioClipAsset', () => {
    expectTypeOf<TagOf<AudioClipAsset>>().toEqualTypeOf<'AudioClipAsset'>();
  });

  it('TagOf<FontAsset> = FontAsset', () => {
    expectTypeOf<TagOf<FontAsset>>().toEqualTypeOf<'FontAsset'>();
  });

  it('TagOf<RenderPipelineAsset> = RenderPipelineAsset (feat-20260601 N+1 member)', () => {
    expectTypeOf<TagOf<RenderPipelineAsset>>().toEqualTypeOf<'RenderPipelineAsset'>();
  });

  it('TagOf<IesProfileAsset> = IesProfileAsset', () => {
    expectTypeOf<TagOf<IesProfileAsset>>().toEqualTypeOf<'IesProfileAsset'>();
  });

  it('TagOf<Asset> distributes over the 16 members', () => {
    expectTypeOf<TagOf<Asset>>().toEqualTypeOf<
      | 'PluginAsset'
      | 'MeshAsset'
      | 'TextureAsset'
      | 'EquirectAsset'
      | 'SamplerAsset'
      | 'MaterialAsset'
      | 'SceneAsset'
      | 'AudioClipAsset'
      | 'IesProfileAsset'
      | 'TerrainAsset'
      | 'NavigationMeshAsset'
      | 'SkinAsset'
      | 'SkeletonAsset'
      | 'AnimationClip'
      | 'AnimationGraph'
      | 'FontAsset'
      | 'RenderPipelineAsset'
      | 'TilesetAsset'
      | 'VideoAsset'
      | 'ParticleEffectAsset'
    >();
  });
});

describe('Factory helpers — toUnique / toShared / unwrapHandle return-type narrow', () => {
  it('toUnique<T>(raw) returns Handle<T, managed>', () => {
    const h = toUnique<'String'>(0);
    expectTypeOf(h).toEqualTypeOf<Handle<'String', 'unique'>>();
    expectTypeOf(h).toEqualTypeOf<UniqueHandle<'String'>>();
  });

  it('toShared<T>(raw) returns Handle<T, unmanaged>', () => {
    const h = toShared<'MeshAsset'>(0);
    expectTypeOf(h).toEqualTypeOf<Handle<'MeshAsset', 'shared'>>();
    expectTypeOf(h).toEqualTypeOf<SharedHandle<'MeshAsset'>>();
  });

  it('unwrapHandle<T,M>(h) returns plain number (brand erased)', () => {
    const h = toShared<'MeshAsset'>(7);
    const raw = unwrapHandle(h);
    expectTypeOf(raw).toEqualTypeOf<number>();
  });
});
