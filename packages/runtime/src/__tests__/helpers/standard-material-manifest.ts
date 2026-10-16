export interface StandardMaterialShaderVariant {
  readonly definesKey: string;
  readonly defines: {
    readonly CLUSTER_FORWARD_AVAILABLE: boolean;
    readonly STORAGE_BUFFER_AVAILABLE: boolean;
    readonly TRANSMISSION_AVAILABLE: boolean;
    readonly VERTEX_COLOR_AVAILABLE: boolean;
  };
  readonly composedWgsl: string;
}

function variantKey(defines: StandardMaterialShaderVariant['defines']): string {
  const entries = Object.entries(defines).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return entries.every(([, value]) => value)
    ? ''
    : entries.map(([key, value]) => `${key}=${value}`).join('+');
}

export function standardMaterialShaderVariants(
  composedWgsl = '/* stub */',
): readonly StandardMaterialShaderVariant[] {
  const variants: StandardMaterialShaderVariant[] = [];
  for (const cluster of [false, true]) {
    for (const storage of [false, true]) {
      for (const vertexColor of [false, true]) {
        for (const transmission of [false, true]) {
          const defines = {
            CLUSTER_FORWARD_AVAILABLE: cluster,
            STORAGE_BUFFER_AVAILABLE: storage,
            TRANSMISSION_AVAILABLE: transmission,
            VERTEX_COLOR_AVAILABLE: vertexColor,
          } as const;
          variants.push({
            definesKey: variantKey(defines),
            defines,
            composedWgsl,
          });
        }
      }
    }
  }
  return variants;
}
