export const COMPONENT_TYPE = {
  I8: 5120,
  U8: 5121,
  I16: 5122,
  U16: 5123,
  U32: 5125,
  F32: 5126,
} as const;
export type ComponentTypeId = (typeof COMPONENT_TYPE)[keyof typeof COMPONENT_TYPE];

const STORAGE = {
  [COMPONENT_TYPE.I8]: Int8Array,
  [COMPONENT_TYPE.U8]: Uint8Array,
  [COMPONENT_TYPE.I16]: Int16Array,
  [COMPONENT_TYPE.U16]: Uint16Array,
  [COMPONENT_TYPE.U32]: Uint32Array,
  [COMPONENT_TYPE.F32]: Float32Array,
} as const;

const SHAPE: Readonly<Record<string, readonly [number, number]>> = {
  SCALAR: [1, 1],
  VEC2: [2, 1],
  VEC3: [3, 1],
  VEC4: [4, 1],
  MAT2: [2, 2],
  MAT3: [3, 3],
  MAT4: [4, 4],
};

export function accessorStorage(type: unknown) {
  return typeof type === 'number' && Object.hasOwn(STORAGE, type)
    ? STORAGE[type as ComponentTypeId]
    : undefined;
}

export function accessorShape(type: unknown): readonly [number, number] | undefined {
  return typeof type === 'string' && Object.hasOwn(SHAPE, type) ? SHAPE[type] : undefined;
}

/** Draco attributes are scalars/vectors; matrices keep their padded accessor path. */
export function accessorVectorSize(type: unknown): number | undefined {
  const shape = accessorShape(type);
  return shape?.[1] === 1 ? shape[0] : undefined;
}
