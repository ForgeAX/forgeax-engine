import type { BindGroupLayoutDescriptor, MaterialProgram } from '@forgeax/engine-types';
import { ShaderError } from '../errors.js';

/** Reflection checks declarations; it never chooses a resource's meaning. */
export function validateMaterialProgramBindings(
  program: MaterialProgram,
  groups: readonly BindGroupLayoutDescriptor[],
): ShaderError | undefined {
  const contract = program.bindings ?? 'render-material';
  const depthBinding =
    contract === 'group-0-resource' || contract === 'render-material-with-scene-depth'
      ? 0
      : contract === 'view-and-scene-depth' || contract === 'render-material-and-scene-depth'
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
