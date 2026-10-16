import type { MaterialAsset, MaterialParameter, MaterialValue } from './asset.js';

/** World-space Hessian plane: dot(normal, position) + constant < 0 is clipped. */
export type ClippingPlane = readonly [x: number, y: number, z: number, constant: number];
export const MAX_CLIPPING_PLANES = 6;
export interface ClippingOptions {
  readonly planes: readonly ClippingPlane[];
  /** Clip the intersection of negative half-spaces instead of their union. */
  readonly intersection?: boolean;
  /** Like Three.js, local shadow clipping is opt-in. */
  readonly clipShadows?: boolean;
}

export class ClippingContractError extends Error {
  readonly code = 'clipping-invalid' as const;
  readonly expected = 'at most six finite nonzero-normal planes on a supported root material';
  readonly hint =
    'repair the named coefficients/count or select a Standard or Unlit root before cooking';
  constructor(readonly detail: { readonly field: string; readonly actual: unknown }) {
    super(`clipping-invalid: ${detail.field}`);
    this.name = 'ClippingContractError';
  }
}

/** Detach and normalize coefficients together, preserving the signed half-space. */
export function normalizeClippingPlanes(
  planes: readonly ClippingPlane[],
): readonly ClippingPlane[] {
  if (planes.length > MAX_CLIPPING_PLANES)
    throw new ClippingContractError({ field: 'planes.length', actual: planes.length });
  return planes.map((plane, index) => {
    const length = Math.hypot(plane[0], plane[1], plane[2]);
    if (
      plane.length !== 4 ||
      !plane.every(Number.isFinite) ||
      !Number.isFinite(length) ||
      length === 0
    ) {
      throw new ClippingContractError({ field: `planes[${index}]`, actual: plane });
    }
    const normalized: ClippingPlane = [
      Math.fround(plane[0] / length),
      Math.fround(plane[1] / length),
      Math.fround(plane[2] / length),
      Math.fround(plane[3] / length),
    ];
    if (!normalized.every(Number.isFinite))
      throw new ClippingContractError({ field: `planes[${index}]`, actual: plane });
    return normalized;
  });
}

/** Declare public clipping once on a root; children can override these ordinary values. */
export function withClipping(material: MaterialAsset, options: ClippingOptions): MaterialAsset {
  if (material.parent !== undefined)
    throw new ClippingContractError({ field: 'material.parent', actual: material.parent });
  const supported = new Set([
    'forgeax_material::standard',
    'forgeax::default-standard-pbr',
    'forgeax_material::pbr-skin',
    'forgeax::pbr-skin',
    'forgeax_material::unlit',
    'forgeax::default-unlit',
    'forgeax::default-shadow-caster',
  ]);
  if (
    material.passes === undefined ||
    material.passes.some((pass) => !supported.has(pass.program.module))
  )
    throw new ClippingContractError({ field: 'material.passes', actual: material.passes });
  const planes = normalizeClippingPlanes(options.planes);
  const parameters: MaterialParameter[] = [
    { name: 'clippingControl', type: 'vec4', default: [0, 0, 0, 0], optional: true },
  ];
  const values: Record<string, MaterialValue> = {
    clippingControl: [
      planes.length,
      options.intersection === true ? 1 : 0,
      options.clipShadows === true ? 1 : 0,
      0,
    ],
  };
  for (let index = 0; index < MAX_CLIPPING_PLANES; index++) {
    const name = `clippingPlane${'ABCDEF'[index]}`;
    parameters.push({ name, type: 'vec4', default: [0, 0, 0, 0], optional: true });
    values[name] = planes[index] ?? [0, 0, 0, 0];
  }
  const names = new Set(parameters.map((parameter) => parameter.name));
  return {
    ...material,
    parameters: [
      ...(material.parameters ?? []).filter((parameter) => !names.has(parameter.name)),
      ...parameters,
    ],
    values: { ...material.values, ...values },
  };
}
