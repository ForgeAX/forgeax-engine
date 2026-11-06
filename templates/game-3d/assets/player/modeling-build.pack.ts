import type {} from '@forgeax/engine/devkit/plugin-build';
import type { Plugin } from '@forgeax/engine/plugin';
import { createMeshJobCooker } from '@forgeax/engine/modeling';
import { CONVOY_JOB } from './convoy-job.ts';
import { definePack, definePackageId, AssetGuid } from '@forgeax/engine/pack/source';
import { ok } from '@forgeax/engine/types';

const packageId = definePackageId('019fb7ce-4a00-7000-8000-000000000000');
export const build: Plugin = {
  name: 'game-3d/modeling-build', inject: ['nativeCookers'],
  apply(ctx) { ctx.effect(() => ctx.nativeCookers!.register(createMeshJobCooker([CONVOY_JOB], { timeoutMs: 180000 }))); },
};
export default definePack({
  schemaVersion: '2.0.0', plugins: true, packageId,
  build: () => ok({ 'plugin/build': { kind: 'plugin', module: { specifier: './modeling-build.pack.ts', export: 'build' } } }),
});
export const MODELING_BUILD_GUID = AssetGuid.format(AssetGuid.derive(packageId, 'plugin/build'));
