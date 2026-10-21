import type { MaterialAsset } from '@forgeax/engine-types';
import type { MaterialRenderProjection } from './runtime-shader';

function sameContract(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>;
  const b = right as Record<string, unknown>;
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameContract(a[key], b[key]))
  );
}

/** Only structural admission compares contracts. Numeric writes never enter this path. */
export function runtimeMaterialProgramProjection(
  previous: MaterialAsset,
  next: MaterialAsset,
  projection: MaterialRenderProjection | undefined,
): MaterialRenderProjection | undefined {
  if (projection === undefined) return undefined;
  if (
    !sameContract(previous.parameters, next.parameters) ||
    !sameContract(previous.surface, next.surface)
  )
    return undefined;
  const previousPasses = new Map(previous.passes?.map((pass) => [pass.name, pass]));
  for (const pass of next.passes ?? []) {
    const old = previousPasses.get(pass.name);
    if (
      old === undefined ||
      !sameContract(old.program, pass.program) ||
      !sameContract(old.outputs, pass.outputs)
    )
      return undefined;
  }
  return projection;
}
