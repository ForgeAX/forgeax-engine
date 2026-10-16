import type { Result, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import { RhiError } from '@forgeax/engine-rhi';
import type { ShaderCatalog } from '@forgeax/engine-shader';
import { atmosphereAvailable } from '../environment/capability';

import {
  invokeDeviceCreateShaderModule,
  prepareLowLimitMaterialShaderEntry,
} from './material-shader-policy';
import { runShimStep } from './renderer-helpers';
import { isOrdinaryMaterialVariant } from './shader-prewarm-policy';

type AsyncCreateShaderModule = (
  device: RhiDevice,
  desc: { code: string; label?: string | undefined },
) => Promise<Result<ShaderModule, RhiError>>;

/**
 * Prewarm ordinary producer-declared material variants before the first frame.
 * Optional coverage/visible-surface variants compile through their selected draw.
 * Variant labels mirror the lazy material pipeline adapter's module lookup contract.
 */
export async function prewarmRequiredMaterialShaders({
  rhiDevice,
  registry,
  asyncCreateShaderModule,
  requiredMaterialShaders,
  seedShaderModule,
}: {
  readonly rhiDevice: RhiDevice;
  readonly registry: ShaderCatalog;
  readonly asyncCreateShaderModule: AsyncCreateShaderModule | undefined;
  readonly requiredMaterialShaders: readonly string[];
  readonly seedShaderModule: (label: string, module: ShaderModule) => void;
}): Promise<void> {
  for (const materialShaderId of requiredMaterialShaders) {
    const lookup = registry.findMaterialArtifact(materialShaderId);
    if (!lookup.ok) {
      throw new RhiError({
        code: 'shader-compile-failed',
        expected: `declared render feature material shader '${materialShaderId}' is present in the loaded manifest`,
        hint: `add material shader '${materialShaderId}' to the shader manifest or remove it from the feature declaration`,
      });
    }
    // Prewarm and lazy pipelines share a module label, so they must compile
    // the same capability-adjusted source on the replacement device.
    const entry = prepareLowLimitMaterialShaderEntry(
      lookup.value,
      rhiDevice.limits.maxSampledTexturesPerShaderStage,
    );
    const label = `module-${materialShaderId}`;
    const shaderResult = await runShimStep(
      () =>
        asyncCreateShaderModule
          ? asyncCreateShaderModule(rhiDevice, { code: entry.source, label })
          : invokeDeviceCreateShaderModule(rhiDevice, { code: entry.source, label }),
      'shader-compile-failed',
      `declared render feature material shader '${materialShaderId}' compiled`,
      `inspect the composed WGSL for '${materialShaderId}' and check device.features`,
    );
    if (!shaderResult.ok) throw shaderResult.error;
    seedShaderModule(label, shaderResult.value);

    const prewarmedSources = new Map<string, ShaderModule>([[entry.source, shaderResult.value]]);
    const manifestEntry = [...registry.materialShaderManifestEntries()].find(
      (candidate) => candidate.identifier === materialShaderId,
    );
    if (manifestEntry === undefined) continue;

    for (const variant of manifestEntry.variants) {
      if (!isOrdinaryMaterialVariant(variant)) continue;
      if (
        'ATMOSPHERE_AVAILABLE' in variant.defines &&
        variant.defines.ATMOSPHERE_AVAILABLE !==
          atmosphereAvailable(
            rhiDevice.caps.storageBuffer && rhiDevice.caps.backendKind !== 'wgpu-webgl2',
            rhiDevice.limits.maxSampledTexturesPerShaderStage,
          )
      )
        continue;
      const variantSource = prepareLowLimitMaterialShaderEntry(
        { ...entry, source: variant.composedWgsl },
        rhiDevice.limits.maxSampledTexturesPerShaderStage,
      ).source;
      const variantLabel = `module-${materialShaderId}#${variant.definesKey}`;
      if (variantLabel === label) continue;
      let variantModule = prewarmedSources.get(variantSource);
      if (variantModule === undefined) {
        const variantResult = await runShimStep(
          () =>
            asyncCreateShaderModule
              ? asyncCreateShaderModule(rhiDevice, {
                  code: variantSource,
                  label: variantLabel,
                })
              : invokeDeviceCreateShaderModule(rhiDevice, {
                  code: variantSource,
                  label: variantLabel,
                }),
          'shader-compile-failed',
          `declared render feature material shader variant '${variantLabel}' compiled`,
          `inspect the composed WGSL for '${materialShaderId}' variant '${variant.definesKey}' and check device.features`,
        );
        if (!variantResult.ok) throw variantResult.error;
        variantModule = variantResult.value;
        prewarmedSources.set(variantSource, variantModule);
      }
      seedShaderModule(variantLabel, variantModule);
    }
  }
}
