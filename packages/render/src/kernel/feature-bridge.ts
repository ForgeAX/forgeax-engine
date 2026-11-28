// Bridge adapting declarative `@forgeax/engine-render` `RenderFeature<FrameData>` instances
// onto `KernelRenderFeature<KernelStandardPipelineFrame>` so user-authored engine RenderFeatures
// execute cleanly on any RenderKernel backend (Metal, DX12, Vulkan, Dawn WebGPU, WebGL2 WASM).

import type { World } from '@forgeax/engine-ecs';
import {
  type BindingSetId,
  type KernelAssetApi,
  type KernelError,
  type KernelGraphTextureHandle,
  type KernelPipelineTargets,
  type KernelRenderFeature,
  type KernelRenderFeatureStage,
  type KernelRenderGraphBuilderLike,
  type KernelStandardPipelineFrame,
  ok,
  type Result,
  type ShaderProgramId,
} from '@forgeax/engine-render-kernel';
import type {
  RenderFeatureFullscreenProgramDeclaration,
  RenderFeaturePlan,
} from '../features/plan';
import type { RenderFeature, RenderFeaturePlacement } from '../features/types';

export interface AdaptedRenderFeatureRuntime {
  readonly identity: string;
  readonly stage: KernelRenderFeatureStage;
  readonly kernelFeature: KernelRenderFeature<KernelStandardPipelineFrame>;
  prepareForFrame(world: World, frameNumber: number, width: number, height: number): boolean;
  notifySubmitted(): void;
  dispose(): void;
}

interface CompiledFullscreenProgramState {
  readonly name: string;
  readonly shaderId: ShaderProgramId;
  readonly decl: RenderFeatureFullscreenProgramDeclaration;
  frameParams: Uint8Array | undefined;
}

function mapPlacementToKernelStage(
  placement: RenderFeaturePlacement | undefined,
  fullscreenStage?: 'before-temporal' | 'before-output' | 'after-output',
): KernelRenderFeatureStage {
  if (fullscreenStage === 'before-temporal' || fullscreenStage === 'before-output') {
    return 'before-post';
  }
  if (fullscreenStage === 'after-output') return 'post';
  switch (placement) {
    case 'environment':
      return 'environment';
    case 'after-depth':
      return 'after-depth';
    case 'before-medium':
      return 'before-medium';
    case 'scene':
      return 'scene';
    case 'after-tonemap':
      return 'after-tonemap';
    default:
      return 'post';
  }
}

function resolveStageColorFormat(
  stage: KernelRenderFeatureStage,
  hdrFormat: GPUTextureFormat,
): GPUTextureFormat {
  if (
    stage === 'environment' ||
    stage === 'before-opaque' ||
    stage === 'after-depth' ||
    stage === 'after-opaque' ||
    stage === 'before-medium' ||
    stage === 'before-transparent' ||
    stage === 'after-transparent' ||
    stage === 'scene' ||
    stage === 'before-post'
  ) {
    return hdrFormat;
  }
  return 'rgba8unorm';
}

function extractFullscreenDeclarations(
  plan: RenderFeaturePlan,
): readonly RenderFeatureFullscreenProgramDeclaration[] {
  const out: RenderFeatureFullscreenProgramDeclaration[] = [];
  for (const w of plan.work) {
    for (const r of w.resources) {
      if (r.kind === 'fullscreen-program') out.push(r);
    }
  }
  return out;
}

function planSignatureForFullscreen(
  decls: readonly RenderFeatureFullscreenProgramDeclaration[],
): string {
  return decls.map((d) => `${d.name}:${d.stage ?? ''}:${d.source.length}`).join('|');
}

function installFullscreenProgramPass(
  featureId: string,
  prog: CompiledFullscreenProgramState,
  targetFormat: GPUTextureFormat,
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  targets: KernelPipelineTargets,
): Result<void, KernelError> {
  const inputColor = targets.currentColor ?? targets.sceneColor;
  const outTexRes = builder.createTexture(`${featureId}.${prog.name}.out`, {
    format: targetFormat,
  });
  if (!outTexRes.ok) return outTexRes;
  const outTex: KernelGraphTextureHandle = outTexRes.value;

  const extraReads: KernelGraphTextureHandle[] = [inputColor];
  const needsDepth = (prog.decl.reads ?? []).some((r) =>
    typeof r === 'string' ? r === 'scene-depth' : r.key === 'scene-depth',
  );
  if (needsDepth && targets.sceneDepth !== undefined) {
    extraReads.push(targets.sceneDepth);
  }

  let bgId = 0;
  const passRes = builder.addRasterPass(`${featureId}.${prog.name}`, {
    reads: extraReads,
    colorAttachments: [
      { target: outTex, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
    ],
    prepare(frame, res) {
      const b = res.beginBindingSet();
      res.bindTexture(b, 0, inputColor);
      b.bindSampler(1, frame.postSampler);
      let nextSlot = 2;
      if (needsDepth && targets.sceneDepth !== undefined) {
        res.bindTexture(b, nextSlot++, targets.sceneDepth);
      }
      const paramBytes = prog.frameParams ?? prog.decl.params?.defaultValue;
      if (paramBytes !== undefined && paramBytes.byteLength > 0) {
        const u = res.writeUniform(paramBytes);
        b.bindUniformSlice(nextSlot, u.offset, u.length);
      }
      bgId = b.finish();
    },
    encode(pass) {
      pass.drawFullscreen(prog.shaderId, bgId as BindingSetId);
    },
  });
  if (!passRes.ok) return passRes;

  targets.setCurrentColor?.(outTex);
  return ok(undefined);
}

/**
 * Adapts a declarative `@forgeax/engine-render` `RenderFeature<FrameData>` (using
 * `fullscreen-program` declarations, per-frame `frameParams`, and placement stages) into a
 * `KernelRenderFeature<KernelStandardPipelineFrame>` that runs directly inside `KernelRenderGraph`.
 */
export function adaptRenderFeatureToKernel<FrameData>(
  feature: RenderFeature<FrameData>,
  assets: KernelAssetApi,
  hdrFormat: GPUTextureFormat,
): AdaptedRenderFeatureRuntime {
  let activeStage = mapPlacementToKernelStage(feature.placement);
  let lastData: FrameData | undefined;
  let lastPlanSignature = '';
  const compiledPrograms = new Map<string, CompiledFullscreenProgramState>();
  let orderedPrograms: CompiledFullscreenProgramState[] = [];

  const syncProgramsFromPlan = (plan: RenderFeaturePlan): boolean => {
    const decls = extractFullscreenDeclarations(plan);
    const nextSig = planSignatureForFullscreen(decls);
    const firstStage = decls[0]?.stage;
    const nextStage = mapPlacementToKernelStage(feature.placement, firstStage);
    const targetFormat = resolveStageColorFormat(nextStage, hdrFormat);

    if (nextSig === lastPlanSignature && nextStage === activeStage) {
      for (const d of decls) {
        const state = compiledPrograms.get(d.name);
        if (state !== undefined) {
          state.frameParams = d.frameParams ?? d.params?.defaultValue;
        }
      }
      return false;
    }

    activeStage = nextStage;
    lastPlanSignature = nextSig;
    const nextOrdered: CompiledFullscreenProgramState[] = [];
    for (const d of decls) {
      let existing = compiledPrograms.get(d.name);
      if (existing === undefined || existing.decl.source !== d.source) {
        if (existing !== undefined) assets.destroyShaderProgram(existing.shaderId);
        const reg = assets.registerShaderProgram({
          code: d.source,
          vertexEntryPoint: 'vs_main',
          fragmentEntryPoint: d.fragmentEntryPoint ?? 'fs_main',
          layoutFamilyId: 0,
          colorFormats: [targetFormat],
          label: `feature.${feature.identity}.${d.name}`,
        });
        if (!reg.ok) continue;
        existing = {
          name: d.name,
          shaderId: reg.value,
          decl: d,
          frameParams: d.frameParams ?? d.params?.defaultValue,
        };
        compiledPrograms.set(d.name, existing);
      } else {
        existing.frameParams = d.frameParams ?? d.params?.defaultValue;
      }
      nextOrdered.push(existing);
    }
    orderedPrograms = nextOrdered;
    return true;
  };

  const kernelFeature: KernelRenderFeature<KernelStandardPipelineFrame> = {
    name: feature.identity,
    get stage() {
      return activeStage;
    },
    ...(feature.dependencies === undefined ? {} : { dependencies: feature.dependencies }),
    install(builder, targets) {
      const targetFormat = resolveStageColorFormat(activeStage, hdrFormat);
      for (const prog of orderedPrograms) {
        const res = installFullscreenProgramPass(
          feature.identity,
          prog,
          targetFormat,
          builder,
          targets,
        );
        if (!res.ok) return res;
      }
      return ok(undefined);
    },
  };

  return {
    identity: feature.identity,
    get stage() {
      return activeStage;
    },
    kernelFeature,
    prepareForFrame(world: World, frameNumber: number, width: number, height: number): boolean {
      const extRes = feature.extract({
        world,
        frameNumber,
        views: [{ identity: 'main', render: true, frameSize: { width, height } }],
      });
      if (!extRes.ok) return false;
      lastData = extRes.value;
      const planRes = feature.plan(extRes.value, {
        frameNumber,
        views: [
          {
            identity: 'main',
            width,
            height,
            targets: [],
          },
        ],
      } as never);
      if (!planRes.ok) return false;
      return syncProgramsFromPlan(planRes.value);
    },
    notifySubmitted(): void {
      if (lastData !== undefined) {
        feature.onFrameSubmitted?.(lastData);
      }
    },
    dispose(): void {
      for (const prog of compiledPrograms.values()) {
        assets.destroyShaderProgram(prog.shaderId);
      }
      compiledPrograms.clear();
      orderedPrograms = [];
      lastData = undefined;
    },
  };
}
