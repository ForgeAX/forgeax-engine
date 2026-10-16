import {
  BUILTIN_BASE,
  type Handle,
  handleGeneration,
  handleSlot,
  type MeshAsset,
  pack,
  type TagOf,
  toShared,
  toUnique,
  unwrapHandle,
} from '@forgeax/engine/types';
import { defineFeature } from '../../lab/feature';

type MeshTag = TagOf<MeshAsset>;

function acceptSharedMesh(handle: Handle<'MeshAsset', 'shared'>): number {
  return unwrapHandle(handle);
}

export default defineFeature({
  title: 'Typed Handle brand',
  catalog: 'Typed Handle',
  kind: 'headless',
  summary:
    'Handle<Target, unique|shared> is a branded number: the target tag and release mode are compile-time facts with zero runtime cost.',
  expect:
    'All checks pass; mixing unique/shared or mesh/texture handles is a TypeScript error enforced by @ts-expect-error lines in this module.',
  run(checks) {
    const raw = pack(5, 3);
    const shared = toShared<MeshTag>(raw);
    const unique = toUnique<'TextureAsset'>(raw);
    checks.ok('handle is a plain number at runtime', typeof shared === 'number');
    checks.equal('unwrapHandle is identity', unwrapHandle(shared), raw);
    checks.equal('slot decoded', handleSlot(shared), 5);
    checks.equal('generation decoded', handleGeneration(shared), 3);
    checks.equal('shared mesh accepted', acceptSharedMesh(shared), raw);
    checks.ok('builtin base is above user slots start', BUILTIN_BASE === 1024);
    // @ts-expect-error unique handle must not flow into a shared-mode parameter
    acceptSharedMesh(toUnique<'MeshAsset'>(raw));
    // @ts-expect-error texture handle must not flow into a mesh parameter
    acceptSharedMesh(toShared<'TextureAsset'>(raw));
    checks.ok('unique and shared brands differ only in types', Number(unique) === Number(shared));
    const mesh: MeshTag = 'MeshAsset';
    checks.equal('TagOf<MeshAsset> resolves to MeshAsset tag', mesh, 'MeshAsset');
  },
});
