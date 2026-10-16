import type {
  BindGroupLayout,
  PipelineLayout,
  Result,
  RhiDevice,
  ShaderModule,
} from '@forgeax/engine-rhi';
import { ok, type RhiError } from '@forgeax/engine-rhi';
import type { MaterialShaderManifestEntry, ShaderRegistry } from '@forgeax/engine-shader';
import type { ManifestEntry } from '@forgeax/engine-types';
import { atmosphereAvailable } from '../environment/capability';
import { type GpuDrivenPbrProgram, standardPbrProgramKey } from '../gpu-driven/pbr-program';
import { GPU_DRIVEN_VIEW_WGSL } from '../gpu-driven/view-gpu';
import {
  buildGpuDrivenPbrInstancesBindGroupLayout,
  buildGpuDrivenPbrPipelineLayout,
  buildGpuDrivenPbrSkinPipelineLayout,
  buildPbrSkinLayouts,
  buildSurfaceDirectInstancesBindGroupLayout,
  createHdrpSkinBindGroupLayoutDescriptor,
  type PbrPipelineLayoutBundle,
  SKIN_MATERIAL_SHADER_ID,
} from '../pbr-pipeline';
import type { RhiBackendPack } from './backend-contract';
import { assembleStandardPbrArtifact } from './material/assembly';
import {
  invokeDeviceCreateShaderModule,
  prepareLowLimitMaterialShaderEntry,
} from './material-shader-policy';
import { runShimStep, runShimSyncStep } from './renderer-helpers';
import {
  prewarmMaterialShaderVariants,
  STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
  selectGpuDrivenSceneIndexVariant,
  selectSkinPrewarmVariants,
  type VariantPrewarmAdmission,
} from './shader-prewarm-policy';

export type AsyncCreateShaderModule = (
  device: RhiDevice,
  desc: { code: string; label?: string | undefined },
) => Promise<Result<ShaderModule, RhiError>>;

export interface GpuDrivenPbrReadyModules {
  readonly pbrSkinModule: ShaderModule | null;
  readonly gpuDrivenPbrPrograms: ReadonlyMap<string, GpuDrivenPbrProgram>;
}

export interface GpuDrivenPbrReadyLayouts {
  readonly hdrpSkinPipelineLayout: PipelineLayout | null;
  readonly hdrpSkinProbePipelineLayout: PipelineLayout | null;
  readonly hdrpSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly pbrSkinPipelineLayout: PipelineLayout | null;
  readonly pbrSkinProbePipelineLayout: PipelineLayout | null;
  readonly pbrSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly gpuDrivenInstancesBindGroupLayout: BindGroupLayout | null;
  readonly gpuDrivenPbrPipelineLayout: PipelineLayout | null;
  readonly gpuDrivenPbrSkinPipelineLayout: PipelineLayout | null;
  readonly surfaceDirectInstancesBindGroupLayout: BindGroupLayout | null;
}

interface GpuDrivenPbrModuleInput {
  readonly registry: Pick<ShaderRegistry, 'materialProgram'>;
  readonly device: RhiDevice;
  readonly storageBufferCapable: boolean;
  readonly asyncCreateShaderModule: AsyncCreateShaderModule | undefined;
  readonly immediateCreateShaderModule?: RhiBackendPack['createShaderModuleImmediate'];
  readonly pbrSkinEntry: ManifestEntry | undefined;
  readonly pbrManifestEntry: MaterialShaderManifestEntry | undefined;
  readonly pbrSkinManifestEntry: MaterialShaderManifestEntry | undefined;
  readonly extendedLightingShaderAvailable: boolean;
  readonly directionalPcssAvailable: boolean;
  readonly projectorAvailable: boolean;
  readonly seedShaderModule: (label: string, module: ShaderModule) => void;
  readonly admitsVariant: VariantPrewarmAdmission;
}

function createShader(
  input: Pick<GpuDrivenPbrModuleInput, 'device' | 'asyncCreateShaderModule'>,
  code: string,
  label: string,
): Promise<Result<ShaderModule, RhiError>> {
  return input.asyncCreateShaderModule
    ? input.asyncCreateShaderModule(input.device, { code, label })
    : Promise.resolve(invokeDeviceCreateShaderModule(input.device, { code, label }));
}

export async function buildGpuDrivenPbrReadyModules(
  input: GpuDrivenPbrModuleInput,
): Promise<GpuDrivenPbrReadyModules> {
  let pbrSkinModule: ShaderModule | null = null;
  const gpuDrivenPbrPrograms = new Map<string, GpuDrivenPbrProgram>();
  if (input.pbrSkinEntry !== undefined && input.pbrSkinEntry.wgsl.length > 0) {
    const result = await runShimStep(
      () => createShader(input, input.pbrSkinEntry?.wgsl ?? '', 'pbr-skin'),
      'shader-compile-failed',
      'skinned PBR shader module compiled',
      'inspect manifest pbr-skin entry composed wgsl; check device.features',
    );
    if (!result.ok) throw result.error;
    pbrSkinModule = result.value;
    input.seedShaderModule(`module-${SKIN_MATERIAL_SHADER_ID}`, pbrSkinModule);
  }
  if (
    input.storageBufferCapable &&
    input.device.caps.compute &&
    input.device.caps.indirectDrawing
  ) {
    const result = await runShimStep(
      () => createShader(input, GPU_DRIVEN_VIEW_WGSL, 'gpu-driven-view'),
      'shader-compile-failed',
      'GPU-driven view shader module compiled',
      'inspect the GPU-driven view compute WGSL and check device.features',
    );
    if (!result.ok) throw result.error;
    input.seedShaderModule('gpu-driven-view', result.value);
  }
  if (input.storageBufferCapable) {
    for (const [materialId, entry] of [
      ['forgeax::default-standard-pbr', input.pbrManifestEntry],
      ['forgeax::pbr-skin', input.pbrSkinManifestEntry],
    ] as const) {
      for (const color of [false, true]) {
        const variant = selectGpuDrivenSceneIndexVariant(
          entry,
          input.extendedLightingShaderAvailable,
          input.directionalPcssAvailable,
          input.projectorAvailable,
          color,
          atmosphereAvailable(
            input.storageBufferCapable,
            input.device.limits.maxSampledTexturesPerShaderStage,
          ),
        );
        if (variant === undefined || entry === undefined) continue;
        const key = standardPbrProgramKey(materialId, color);
        const artifact = assembleStandardPbrArtifact(
          materialId,
          input.registry.materialProgram(variant.composedWgsl),
          color,
        );
        if (key === undefined || artifact === undefined) continue;
        const result = await runShimStep(
          () => createShader(input, artifact.program.source, `gpu-driven-${key}`),
          'shader-compile-failed',
          'GPU-driven Standard PBR program compiled',
          'inspect the selected scene-index and vertex-color variant with its slot-3 ABI',
        );
        if (!result.ok) throw result.error;
        gpuDrivenPbrPrograms.set(key, { module: result.value, artifact });
        input.seedShaderModule(`gpu-driven-${key}`, result.value);
        // The raster adapter resolves this same variant through the lazy
        // material label. Seed it so the first GPU-driven frame never waits on
        // a pending module, unless the adapter would compile a patched source.
        const source = artifact.program.source;
        const adapterSource = prepareLowLimitMaterialShaderEntry(
          { source },
          input.device.limits.maxSampledTexturesPerShaderStage,
        ).source;
        if (adapterSource === source)
          input.seedShaderModule(`module-${materialId}#${variant.definesKey}`, result.value);
      }
    }
  }
  // Synchronous module backends prepare optional material lanes at first use.
  // Async-only backends prewarm admitted lanes before publishing readiness.
  if (input.immediateCreateShaderModule === undefined) {
    // Device capabilities are fixed for this ready generation. Keep both scene
    // topology/color/reflection lanes and every supported material lane warm;
    // compiling unreachable capability combinations delays even an unlit boot.
    const skinVariants = selectSkinPrewarmVariants(
      input.pbrSkinManifestEntry,
      input.storageBufferCapable,
      input.extendedLightingShaderAvailable,
      input.directionalPcssAvailable,
      input.projectorAvailable,
      (input.device.limits.maxSampledTexturesPerShaderStage ?? 0) >=
        STANDARD_PBR_REQUIRED_SAMPLED_TEXTURES,
      atmosphereAvailable(
        input.storageBufferCapable,
        input.device.limits.maxSampledTexturesPerShaderStage,
      ),
    );
    await prewarmMaterialShaderVariants(
      SKIN_MATERIAL_SHADER_ID,
      skinVariants,
      new Map(
        input.pbrSkinEntry === undefined || pbrSkinModule === null
          ? []
          : [[input.pbrSkinEntry.wgsl, pbrSkinModule]],
      ),
      (variant, label) =>
        runShimStep(
          () => createShader(input, variant.composedWgsl, label),
          'shader-compile-failed',
          `pbr-skin variant ${variant.definesKey || '<default>'} compiled`,
          'inspect the selected pbr-skin storage/cluster/color variant and device.features',
        ),
      (label, module) => {
        input.seedShaderModule(label, module);
        if (label === `module-${SKIN_MATERIAL_SHADER_ID}#`)
          input.seedShaderModule(`module-${SKIN_MATERIAL_SHADER_ID}`, module);
      },
      input.admitsVariant,
    );
  }
  return { pbrSkinModule, gpuDrivenPbrPrograms };
}

export function buildGpuDrivenPbrReadyLayouts(
  device: RhiDevice,
  storageBufferCapable: boolean,
  pbrLayouts: PbrPipelineLayoutBundle,
): GpuDrivenPbrReadyLayouts {
  let pbrSkinPipelineLayout: PipelineLayout | null = null;
  let pbrSkinProbePipelineLayout: PipelineLayout | null = null;
  let pbrSkinMeshBindGroupLayout: BindGroupLayout | null = null;
  let gpuDrivenInstancesBindGroupLayout: BindGroupLayout | null = null;
  let gpuDrivenPbrPipelineLayout: PipelineLayout | null = null;
  let gpuDrivenPbrSkinPipelineLayout: PipelineLayout | null = null;
  let surfaceDirectInstancesBindGroupLayout: BindGroupLayout | null = null;
  const skinResult = runShimSyncStep(
    () => ok(buildPbrSkinLayouts(device, { storageBuffer: storageBufferCapable }, pbrLayouts)),
    'webgpu-runtime-error',
    'buildPbrSkinLayouts succeeded',
    'check device.limits.maxBindingsPerBindGroup (need >=14) and maxBindGroupsPerPipelineLayout',
  );
  if (skinResult.ok) {
    pbrSkinPipelineLayout = skinResult.value.pipelineLayout;
    pbrSkinProbePipelineLayout = skinResult.value.probePipelineLayout;
    pbrSkinMeshBindGroupLayout = skinResult.value.meshArrayBgl;
  }
  if (storageBufferCapable) {
    const layoutResult = runShimSyncStep(
      () => {
        const instances = buildGpuDrivenPbrInstancesBindGroupLayout(device, {
          storageBuffer: true,
        });
        const surfaceDirect = buildSurfaceDirectInstancesBindGroupLayout(device, {
          storageBuffer: true,
        });
        const rigid = buildGpuDrivenPbrPipelineLayout(device, pbrLayouts, instances);
        const skin =
          pbrSkinMeshBindGroupLayout === null
            ? null
            : buildGpuDrivenPbrSkinPipelineLayout(
                device,
                { ...pbrLayouts, meshArrayBgl: pbrSkinMeshBindGroupLayout },
                instances,
              );
        return ok({ instances, rigid, skin, surfaceDirect });
      },
      'webgpu-runtime-error',
      'build GPU-driven PBR pipeline layouts succeeded',
      'check the dedicated scene-index slot-3 storage layout and four-slot pipeline layouts',
    );
    if (layoutResult.ok) {
      gpuDrivenInstancesBindGroupLayout = layoutResult.value.instances;
      gpuDrivenPbrPipelineLayout = layoutResult.value.rigid;
      gpuDrivenPbrSkinPipelineLayout = layoutResult.value.skin;
      surfaceDirectInstancesBindGroupLayout = layoutResult.value.surfaceDirect;
    }
  }
  let hdrpSkinPipelineLayout: PipelineLayout | null = null;
  let hdrpSkinProbePipelineLayout: PipelineLayout | null = null;
  let hdrpSkinMeshBindGroupLayout: BindGroupLayout | null = null;
  {
    const skinBglResult = device.createBindGroupLayout(
      createHdrpSkinBindGroupLayoutDescriptor(storageBufferCapable),
    );
    if (skinBglResult.ok) {
      const skinPlResult = device.createPipelineLayout({
        label: 'hdrp-skin-pl',
        bindGroupLayouts: [
          pbrLayouts.viewBgl,
          pbrLayouts.materialBgl,
          skinBglResult.value,
          pbrLayouts.instancesBgl,
        ],
      });
      if (skinPlResult.ok) {
        hdrpSkinPipelineLayout = skinPlResult.value;
        hdrpSkinMeshBindGroupLayout = skinBglResult.value;
        if (storageBufferCapable)
          hdrpSkinProbePipelineLayout = device
            .createPipelineLayout({
              label: 'hdrp-skin-probe-pl',
              bindGroupLayouts: [
                pbrLayouts.viewBgl,
                pbrLayouts.materialBgl,
                skinBglResult.value,
                pbrLayouts.probeInstancesBgl,
              ],
            })
            .unwrap();
      }
    }
  }

  return {
    hdrpSkinPipelineLayout,
    hdrpSkinProbePipelineLayout,
    hdrpSkinMeshBindGroupLayout,
    pbrSkinPipelineLayout,
    pbrSkinProbePipelineLayout,
    pbrSkinMeshBindGroupLayout,
    gpuDrivenInstancesBindGroupLayout,
    gpuDrivenPbrPipelineLayout,
    gpuDrivenPbrSkinPipelineLayout,
    surfaceDirectInstancesBindGroupLayout,
  };
}
