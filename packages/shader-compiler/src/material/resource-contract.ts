import {
  type BindGroupLayoutDescriptor,
  err,
  MATERIAL_POST_PROCESS_SCENE_INPUTS,
  type MaterialProgram,
  type MaterialProgramSystemInputs,
  ok,
  type Result,
} from '@forgeax/engine-types';
import { ShaderError } from '../errors.js';
import type { MaterialSourceCatalog } from './source-catalog.js';

/** Trusted module provenance grants the role; reflection only checks its actual interface. */
export function materialSystemInputs(
  sources: MaterialSourceCatalog,
  closure: readonly string[],
  groups: readonly BindGroupLayoutDescriptor[],
): Result<MaterialProgramSystemInputs | undefined, ShaderError> {
  const module = 'forgeax_material::water_waves';
  if (!closure.includes(module)) return ok(undefined);
  const water = sources.get(module);
  const entries =
    groups
      .find((group) => group.label === '@group(2)')
      ?.entries.filter((entry) => entry.binding >= 16 && entry.binding <= 24) ?? [];
  if (entries.length === 0) return ok(undefined);
  const valid =
    water?.ok === true &&
    water.value.provenance === 'engine' &&
    entries.every((entry) => {
      switch (entry.binding) {
        case 16:
        case 17:
        case 22:
        case 23:
        case 24:
          return entry.buffer?.type === 'read-only-storage';
        case 18:
          return (
            entry.texture?.viewDimension === '2d-array' &&
            entry.texture.multisampled !== true &&
            (entry.texture.sampleType === 'float' ||
              entry.texture.sampleType === 'unfilterable-float')
          );
        case 19:
          return entry.sampler !== undefined && entry.sampler.type !== 'comparison';
        case 20:
        case 21:
          return entry.buffer?.type === 'uniform';
        default:
          return false;
      }
    });
  return valid
    ? ok({ water: 'water-frame/3' })
    : err(
        new ShaderError({
          code: 'shader-compile-failed',
          expected: 'the trusted water_waves module and its read-only water-frame/3 interface',
          message: 'material Water system inputs do not match their engine-owned resource contract',
          hint: 'import the Engine Water module and re-cook instead of declaring system bindings in project WGSL',
        }),
      );
}

/** Reflection checks declarations; it never chooses a resource's meaning. */
export function validateMaterialProgramBindings(
  program: MaterialProgram,
  groups: readonly BindGroupLayoutDescriptor[],
  systemInputs?: MaterialProgramSystemInputs,
): ShaderError | undefined {
  const contract = program.bindings ?? 'render-material';
  if (contract === 'post-process') {
    const validatePostProcessBindings = () => {
      const entries = groups[0]?.entries ?? [];
      const view = entries.find(
        (entry) => entry.binding === MATERIAL_POST_PROCESS_SCENE_INPUTS.view,
      );
      const color = entries.find(
        (entry) => entry.binding === MATERIAL_POST_PROCESS_SCENE_INPUTS.color,
      );
      const depth = entries.find(
        (entry) => entry.binding === MATERIAL_POST_PROCESS_SCENE_INPUTS.depth,
      );
      const passInputs = entries.find(
        (entry) => entry.binding === MATERIAL_POST_PROCESS_SCENE_INPUTS.passInputs,
      );
      if (
        program.sceneDepth !== 'before-pass' ||
        entries.length !== 4 ||
        view?.buffer?.type !== 'uniform' ||
        passInputs?.buffer?.type !== 'uniform' ||
        color?.texture?.viewDimension !== '2d' ||
        (color.texture.sampleType !== 'float' &&
          color.texture.sampleType !== 'unfilterable-float') ||
        depth?.texture?.viewDimension !== '2d' ||
        depth.texture.sampleType !== 'depth' ||
        color.texture.multisampled === true ||
        depth.texture.multisampled === true ||
        groups
          .slice(2)
          .some(
            (group) =>
              group.entries.length > 0 &&
              (systemInputs?.water !== 'water-frame/3' ||
                group.label !== '@group(2)' ||
                group.entries.some((entry) => entry.binding < 16 || entry.binding > 24)),
          )
      ) {
        return new ShaderError({
          code: 'shader-compile-failed',
          expected:
            'post-process View/color/depth/pass inputs at group(0) bindings 0/1/2/3 and ordinary material values at group(1)',
          message: `material ${program.module} has an incompatible fullscreen input ABI`,
          hint: 'declare a single-sample before-pass scene-depth input and repair the reflected post-process binding contract',
        });
      }
      return undefined;
    };
    return validatePostProcessBindings();
  }
  const validateDepthBindings = () => {
    const depthBinding =
      contract === 'group-0-resource' || contract === 'render-material-with-scene-depth'
        ? 0
        : contract === 'view-and-scene-depth' ||
            contract === 'render-material-and-scene-depth' ||
            contract === 'render-standard-material-and-scene-depth' ||
            contract === 'render-lit-material-and-scene-depth'
          ? 1
          : undefined;
    const depths =
      groups[0]?.entries.filter(
        (entry) => entry.binding <= 1 && entry.texture?.sampleType === 'depth',
      ) ?? [];
    const declaresDepth = depthBinding !== undefined;
    if (
      (program.sceneDepth !== undefined) !== declaresDepth ||
      (depths.length > 0 &&
        (!declaresDepth || depths.some((entry) => entry.binding !== depthBinding)))
    ) {
      return new ShaderError({
        code: 'shader-compile-failed',
        expected:
          'an explicit matching binding contract and sceneDepth version for scene-depth access',
        message: `material ${program.module} has inconsistent scene-depth declarations`,
        hint: 'declare program.bindings and program.sceneDepth (read-only or before-pass), then re-cook; resource names do not select a layout',
      });
    }

    return undefined;
  };
  const depthFailure = validateDepthBindings();
  if (depthFailure !== undefined) return depthFailure;
  const viewOnly = contract === 'view-only' || contract === 'view-and-scene-depth';
  const depthOnly =
    contract === 'group-0-resource' || contract === 'render-material-with-scene-depth';
  if (
    (contract === 'group-0' && groups.some((group) => group.entries.length > 0)) ||
    ((viewOnly || contract === 'group-0-resource') &&
      groups.slice(1).some((group) => group.entries.length > 0)) ||
    (depthOnly &&
      groups[0]?.entries.some(
        (entry) => entry.binding !== 0 || entry.texture?.sampleType !== 'depth',
      ))
  ) {
    return new ShaderError({
      code: 'shader-compile-failed',
      expected: 'reflected bindings contained in the declared material interface',
      message: `material ${program.module} uses resources outside ${contract}`,
      hint: 'repair the authored program.bindings declaration and re-cook',
    });
  }
  return undefined;
}
