import { renderMaterialContext } from '../src/extract/material-context';
import {
  logicalRenderFeatureTargets,
  type RenderFeatureTargetHandle,
  resolveStandardRenderFeatureTargets,
} from '../src/features/targets';

export const modes = [
  'material-stable',
  'material-domains',
  'material-mutable',
  'material-borrowed',
  'targets-stable',
  'targets-domains',
  'targets-borrowed',
];

/** Complete public helper calls, including current input selection and logical projection. */
export function createCase(mode: string) {
  const materialInputs = (['webgpu', 'wgpu-native', 'wgpu-webgl2', 'null'] as const).flatMap(
    (backendKind) =>
      [false, true].flatMap((storageBuffer) =>
        [undefined, 20, 21, 26, 27, 31, 32, 64].flatMap((maxSampledTexturesPerShaderStage) =>
          [false, true].map((visibleSurface) => ({
            caps: { backendKind, storageBuffer },
            limits:
              maxSampledTexturesPerShaderStage === undefined
                ? {}
                : { maxSampledTexturesPerShaderStage },
            visibleSurface,
          })),
        ),
      ),
  );
  const stableMaterial = {
    caps: { backendKind: 'webgpu' as const, storageBuffer: true },
    limits: { maxSampledTexturesPerShaderStage: 32 },
    visibleSurface: false,
  };
  const borrowedMaterial = {
    ...stableMaterial,
    caps: {
      backendKind: 'borrowed-backend',
      storageBuffer: true,
    } as unknown as typeof stableMaterial.caps,
  };
  const targetInputs = [false, true].flatMap((cloudHistory) =>
    [false, true].map((msaa) => ({
      tonemap: 'none',
      antialias: msaa ? 'msaa' : 'none',
      storageBuffer: true,
      multisample: true,
      colorAttachmentFormat: 'bgra8unorm-srgb' as const,
      cloudHistory,
    })),
  );
  const materialRing: unknown[] = new Array(32);
  const targetRing: unknown[] = new Array(32);
  const logicalRing: unknown[] = new Array(32);
  let checksum = 0;
  const material = mode.startsWith('material-');
  const borrowedTarget = {
    name: 'borrowed',
    kind: 'scene-color' as const,
    format: 'rgba16float' as const,
    sampleCount: 1 as 1 | 4,
  };
  const borrowedTargets = [borrowedTarget] as unknown as readonly RenderFeatureTargetHandle[];
  if (!modes.includes(mode)) throw new Error(`Unknown projection mode: ${mode}`);
  return {
    run: function projectionTarget(index: number): number {
      if (material) {
        const input =
          mode === 'material-domains'
            ? (materialInputs[index % materialInputs.length] as (typeof materialInputs)[number])
            : mode === 'material-borrowed'
              ? borrowedMaterial
              : stableMaterial;
        if (mode === 'material-mutable') {
          stableMaterial.caps.storageBuffer = (index & 1) === 0;
          stableMaterial.limits.maxSampledTexturesPerShaderStage = index & 2 ? 20 : 32;
        }
        const result = renderMaterialContext(input.caps, input.limits, input.visibleSurface);
        materialRing[index & 31] = result;
        const context = result.materialContext;
        if (context === undefined) throw new Error('Missing material domain');
        checksum =
          context.backend.length +
          context.capability.length +
          Number(context.visibleSurface === true);
      } else {
        const input = targetInputs[
          mode === 'targets-stable' ? 0 : index % targetInputs.length
        ] as (typeof targetInputs)[number];
        borrowedTarget.sampleCount = (index & 1) === 0 ? 1 : 4;
        const targets =
          mode === 'targets-borrowed'
            ? borrowedTargets
            : resolveStandardRenderFeatureTargets(input);
        const logical = logicalRenderFeatureTargets(targets);
        targetRing[index & 31] = targets;
        logicalRing[index & 31] = logical;
        checksum = 0;
        for (let rowIndex = 0; rowIndex < logical.length; rowIndex++) {
          const row = logical[rowIndex] as (typeof logical)[number];
          checksum += row.name.length + row.format.length + row.sampleCount;
        }
      }
      return checksum;
    },
    inspect() {
      return { checksum, retainedResultSlots: 32 };
    },
  };
}
