import { AnimationPlayer, AnimationTargetId } from '@forgeax/engine-animation';
import { bakeSources } from '@forgeax/engine-modeling';
import { AssetGuid, definePack, definePackageId } from '@forgeax/engine-pack/source';
import { Materials, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { Skin } from '@forgeax/engine-skinning';
import { ok } from '@forgeax/engine-types';
import { ACTUATOR_DEFAULTS, actuatorBake, actuatorPath, actuatorRig, buildActuatorDetail, buildActuatorShell, SHELL_NORMALS } from './actuator.ts';

const packageId = definePackageId('01900000-0000-7000-8000-0000000c0112');
const guid = (key: string) => AssetGuid.format(AssetGuid.derive(packageId, key));

/**
 * Case C-112 as an ordinary procedural asset: the game-ready shell as one skinned mesh
 * (rigid barrel, rod end and clamps; automatically weighted boot) with `skeleton/`,
 * `skin/`, `scene/` and `animation-clip/actuator` (the full stroke out and back),
 * `mesh/actuator-detail` (the high-poly source), the baked `texture/actuator-normal` and
 * `texture/actuator-ao` as `modeling-bake` cook sources (baked by the NativeCooker outside
 * the build timeout; register `createBakeCooker()` in the build plugin), and one Standard
 * material per shell slot wearing both maps.
 */
export default definePack({
  schemaVersion: '2.0.0',
  packageId,
  // The components rig.finish() writes into the skinned scene/actuator.
  sceneComponents: [AnimationPlayer, AnimationTargetId, ChildOf, MeshFilter, MeshRenderer, Name, Skin, Transform],
  parameters: [
    { name: 'stroke', type: 'f32', default: 0.12, minimum: 0.08, maximum: 0.16 },
    { name: 'rest', type: 'f32', default: 0.25, minimum: 0.2, maximum: 0.4 },
    { name: 'folds', type: 'u32', default: 8, minimum: 5, maximum: 10 },
    { name: 'budget', type: 'u32', default: 1500, minimum: 800, maximum: 4000 },
    { name: 'resolution', type: 'u32', default: 512, minimum: 64, maximum: 2048 },
  ],
  build: ({ values }) => {
    const p = { ...ACTUATOR_DEFAULTS, stroke: values.stroke as number, rest: values.rest as number, folds: values.folds as number, budget: values.budget as number, resolution: values.resolution as number };
    const shell = buildActuatorShell(p);
    const detail = buildActuatorDetail(p);
    const rigged = actuatorRig(shell, p).finish({ key: 'actuator', packageId, form: 'skinned', normals: SHELL_NORMALS, path: actuatorPath(p), duration: 4 });
    if (!rigged.ok) return rigged;
    const high = detail.finish({ key: 'actuator-detail', normals: SHELL_NORMALS });
    if (!high.ok) return high;
    const maps = bakeSources({ base: shell, detail, ...actuatorBake(p), mips: true, key: 'actuator' });
    if (!maps.ok) return maps;
    const baked = (baseColor: [number, number, number, number], metallic: number, roughness: number) =>
      Materials.standard({ baseColor, metallic, roughness, normalTexture: { texture: guid('texture/actuator-normal') }, occlusionTexture: { texture: guid('texture/actuator-ao') } });
    return ok({
      ...rigged.value,
      ...high.value,
      ...maps.value,
      'material/actuator-paint': baked([0.62, 0.36, 0.12, 1], 0.2, 0.45),
      'material/actuator-steel': baked([0.42, 0.45, 0.5, 1], 0.85, 0.35),
      'material/actuator-rubber': baked([0.08, 0.08, 0.09, 1], 0, 0.8),
    });
  },
});
