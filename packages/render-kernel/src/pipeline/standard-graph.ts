// Declarative Standard 3D PBR RenderPipeline built directly over KernelRenderGraph.
// Composes Shadow/CSM -> Skybox -> Opaque (4-BGL or WebGL2 uniform) -> Transparent ->
// HDR Bloom -> Multi-Curve Output Transform (ACES/AgX/Reinhard/Neutral/None + Vignette) ->
// FXAA -> DebugDraw + UI Overlay -> optional Readback, with all 16 user KernelRenderFeature
// injection stages and ping-pong `targets.currentColor` handoff.

import {
  COLOR_DOMAIN_DISPLAY_ENCODED,
  COLOR_DOMAIN_LINEAR_HDR,
  DRAW_FLAG_INSTANCING,
  DRAW_FLAG_SHADOW_CASTER_ONLY,
  SORT_BACK_TO_FRONT,
  SORT_MATERIAL_PSO,
} from '../command-stream.js';
import { type KernelError, ok, type Result } from '../errors.js';
import { createPipelineTargets } from '../graph/builder.js';
import type {
  KernelGraphTextureHandle,
  KernelRenderFeature,
  KernelRenderGraphBuilderLike,
  KernelRenderPipeline,
  MutableKernelPipelineTargets,
} from '../graph/types.js';
import type { BindingSetId, CullId, ShaderProgramId } from '../handles.js';
import {
  PASS_TAG_FORWARD_OPAQUE,
  PASS_TAG_FORWARD_TRANSPARENT,
  PASS_TAG_SHADOW_DEPTH,
} from '../pso-key.js';
import type { KernelStandardPipelineFrame, KernelUniformFallbackDraw } from './types.js';

export interface KernelStandardGraphTopology {
  readonly hdrFormat: GPUTextureFormat;
  readonly outputFormat: GPUTextureFormat;
  readonly headless: boolean;
  readonly supportsScene4Bgl: boolean;
  readonly hasShadowLight: boolean;
  readonly shadowAtlasDim: number;
  readonly hasSkybox: boolean;
  readonly hasTransparent: boolean;
  readonly bloomEnabled: boolean;
  readonly fxaaEnabled: boolean;
  readonly hasDebugLines: boolean;
  readonly hasUiOverlay: boolean;
  readonly hasReadback: boolean;
}

const FALLBACK_UBO_FLOATS = 64; // 256 bytes = 2 mat4 + 8 vec4

function packUniformDrawScratch(
  out: Float32Array,
  frame: KernelStandardPipelineFrame,
  draw: KernelUniformFallbackDraw,
): Uint8Array {
  out.set(frame.camera.viewProj, 0);
  out.set(draw.worldMatrix, 16);
  out[32] = draw.baseColor[0];
  out[33] = draw.baseColor[1];
  out[34] = draw.baseColor[2];
  out[35] = draw.baseColor[3];
  out[36] = draw.emissive[0];
  out[37] = draw.emissive[1];
  out[38] = draw.emissive[2];
  out[39] = draw.roughness;
  out[40] = frame.fallbackLightDir[0];
  out[41] = frame.fallbackLightDir[1];
  out[42] = frame.fallbackLightDir[2];
  out[43] = frame.camera.exposure ?? 1.0;
  out[44] = frame.fallbackLightColorIntensity[0];
  out[45] = frame.fallbackLightColorIntensity[1];
  out[46] = frame.fallbackLightColorIntensity[2];
  out[47] = frame.fallbackLightColorIntensity[3];
  out[48] = frame.fallbackAmbient[0];
  out[49] = frame.fallbackAmbient[1];
  out[50] = frame.fallbackAmbient[2];
  out[51] = frame.fallbackAmbient[3];
  out[52] = frame.camera.position[0];
  out[53] = frame.camera.position[1];
  out[54] = frame.camera.position[2];
  out[55] = draw.metallic;
  out[56] = frame.fallbackFog0[0];
  out[57] = frame.fallbackFog0[1];
  out[58] = frame.fallbackFog0[2];
  out[59] = frame.fallbackFog0[3];
  out[60] = frame.fallbackFog1[0];
  out[61] = frame.fallbackFog1[1];
  out[62] = frame.fallbackFog1[2];
  out[63] = frame.fallbackFog1[3];
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

function addShadowPass(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  shadowDepth: KernelGraphTextureHandle,
): Result<void, KernelError> {
  return builder.addRasterPass('standard-shadow-depth', {
    colorAttachments: [],
    depthAttachment: {
      target: shadowDepth,
      loadOp: 'clear',
      storeOp: 'store',
      clearDepth: 1.0,
    },
    encode(pass, frame, res) {
      const cascadeCount = Math.max(1, Math.min(4, frame.cascadeCount));
      const isTiled = cascadeCount > 1;
      const tileDim = frame.shadowMapSize;
      for (let c = 0; c < cascadeCount; c++) {
        let uOff = frame.viewUniformOffset;
        let uLen = frame.viewUniformLength;
        if (c > 0) {
          const cascadeBytes = frame.cascadeViewUboBytes[c];
          if (cascadeBytes !== undefined) {
            const slice = res.writeUniform(cascadeBytes);
            uOff = slice.offset;
            uLen = slice.length;
          }
        }
        if (isTiled) {
          const tx = (c & 1) * tileDim;
          const ty = ((c >> 1) & 1) * tileDim;
          pass.setViewport(tx, ty, tileDim, tileDim, 0, 1);
          pass.setScissor(tx, ty, tileDim, tileDim);
        }
        const cullId = (frame.shadowCullIds[c] ?? c + 1) as CullId;
        pass.drawRenderers({
          cullId,
          passTag: PASS_TAG_SHADOW_DEPTH,
          sortMode: SORT_MATERIAL_PSO,
          drawFlags: DRAW_FLAG_INSTANCING | DRAW_FLAG_SHADOW_CASTER_ONLY,
          queueMin: 0,
          queueMax: 2450,
          viewUniformOffset: uOff,
          viewUniformLength: uLen,
          overrideShader: frame.shaders.shadow,
          passAttachmentId: 1,
        });
        if (frame.skinnedObjectCount > 0) {
          pass.drawRenderers({
            cullId,
            passTag: PASS_TAG_SHADOW_DEPTH,
            sortMode: SORT_MATERIAL_PSO,
            drawFlags: DRAW_FLAG_INSTANCING | DRAW_FLAG_SHADOW_CASTER_ONLY,
            queueMin: 2451,
            queueMax: 2490,
            viewUniformOffset: uOff,
            viewUniformLength: uLen,
            overrideShader: frame.shaders.skinnedShadow,
            passAttachmentId: 1,
          });
        }
      }
    },
  });
}

function addSkyboxPass(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  hdrColor: KernelGraphTextureHandle,
): Result<void, KernelError> {
  let skyBg = 0;
  return builder.addRasterPass('standard-skybox', {
    colorAttachments: [
      { target: hdrColor, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
    ],
    prepare(frame, res) {
      const slice = res.writeUniform(frame.skyboxUboBytes);
      skyBg = res.beginBindingSet().bindUniformSlice(0, slice.offset, slice.length).finish();
    },
    encode(pass, frame) {
      pass.drawFullscreen(frame.shaders.skybox, skyBg as BindingSetId);
    },
  });
}

function addOpaqueScenePass(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  hdrColor: KernelGraphTextureHandle,
  mainDepth: KernelGraphTextureHandle,
  shadowDepth: KernelGraphTextureHandle | undefined,
  hasSkybox: boolean,
): Result<void, KernelError> {
  const fallbackScratch = new Float32Array(FALLBACK_UBO_FLOATS);
  let fallbackBindings: BindingSetId[] = [];
  return builder.addRasterPass('standard-forward-opaque', {
    reads: shadowDepth !== undefined ? [shadowDepth] : [],
    colorAttachments: [
      {
        target: hdrColor,
        loadOp: hasSkybox ? 'load' : 'clear',
        storeOp: 'store',
        clearColor: (frame) => frame.clearColor,
      },
    ],
    depthAttachment: {
      target: mainDepth,
      loadOp: 'clear',
      storeOp: 'store',
      clearDepth: 1.0,
    },
    prepare(frame, res) {
      if (frame.supportsScene4Bgl) {
        if (shadowDepth !== undefined) {
          const b = res.beginBindingSet();
          res.bindTexture(b, 0, shadowDepth);
          frame.shadowBindSet = b.finish();
        } else {
          frame.shadowBindSet = 0;
        }
        return;
      }
      fallbackBindings = [];
      for (const draw of frame.fallbackDraws) {
        if (draw.transparent) continue;
        const u = res.writeUniform(packUniformDrawScratch(fallbackScratch, frame, draw));
        const bs = res
          .beginBindingSet()
          .bindUniformSlice(0, u.offset, u.length)
          .bindTexture(1, draw.baseColorTexId ?? frame.defaultWhiteTexture)
          .bindSampler(2, frame.postSampler)
          .finish();
        fallbackBindings.push(bs);
      }
    },
    encode(pass, frame) {
      if (frame.supportsScene4Bgl) {
        pass.drawRenderers({
          cullId: frame.mainCullId,
          passTag: PASS_TAG_FORWARD_OPAQUE,
          sortMode: SORT_MATERIAL_PSO,
          drawFlags: DRAW_FLAG_INSTANCING,
          queueMin: 0,
          queueMax: 2500,
          layerMask: frame.camera.cullMask ?? 0xffff_ffff,
          viewUniformOffset: frame.viewUniformOffset,
          viewUniformLength: frame.viewUniformLength,
          extraBindings: frame.shadowBindSet,
          passAttachmentId: 2,
        });
        return;
      }
      pass.setShaderPipeline(frame.shaders.uniformPbrOpaque, 0, 2, 1);
      let bIdx = 0;
      for (const draw of frame.fallbackDraws) {
        if (draw.transparent) continue;
        const bg = fallbackBindings[bIdx++];
        if (bg !== undefined) pass.setBindGroup(0, bg);
        pass.setVertexBuffer(0, draw.meshId);
        if (draw.indexCount > 0) {
          pass.setIndexBuffer(draw.meshId, draw.isUint32Index);
          pass.drawIndexed(draw.indexCount, 1, draw.firstIndex, draw.baseVertex, 0);
        } else {
          pass.draw(draw.vertexCount, 1, draw.firstVertex, 0);
        }
      }
    },
  });
}

function addTransparentScenePass(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  targets: MutableKernelPipelineTargets,
  mainDepth: KernelGraphTextureHandle,
  shadowDepth: KernelGraphTextureHandle | undefined,
): Result<void, KernelError> {
  const fallbackScratch = new Float32Array(FALLBACK_UBO_FLOATS);
  let fallbackBindings: BindingSetId[] = [];
  return builder.addRasterPass('standard-forward-transparent', {
    reads: shadowDepth !== undefined ? [shadowDepth] : [],
    colorAttachments: [{ target: targets.currentColor, loadOp: 'load', storeOp: 'store' }],
    depthAttachment: { target: mainDepth, loadOp: 'load', storeOp: 'store' },
    prepare(frame, res) {
      if (frame.supportsScene4Bgl) return;
      fallbackBindings = [];
      for (const draw of frame.fallbackDraws) {
        if (!draw.transparent) continue;
        const u = res.writeUniform(packUniformDrawScratch(fallbackScratch, frame, draw));
        const bs = res
          .beginBindingSet()
          .bindUniformSlice(0, u.offset, u.length)
          .bindTexture(1, draw.baseColorTexId ?? frame.defaultWhiteTexture)
          .bindSampler(2, frame.postSampler)
          .finish();
        fallbackBindings.push(bs);
      }
    },
    encode(pass, frame) {
      if (frame.supportsScene4Bgl) {
        pass.drawRenderers({
          cullId: frame.mainCullId,
          passTag: PASS_TAG_FORWARD_TRANSPARENT,
          sortMode: SORT_BACK_TO_FRONT,
          drawFlags: 0,
          queueMin: 2501,
          queueMax: 5000,
          layerMask: frame.camera.cullMask ?? 0xffff_ffff,
          viewUniformOffset: frame.viewUniformOffset,
          viewUniformLength: frame.viewUniformLength,
          extraBindings: frame.shadowBindSet,
          passAttachmentId: 2,
        });
        return;
      }
      pass.setShaderPipeline(frame.shaders.uniformPbrTransparent, 0, 2, 1);
      let bIdx = 0;
      for (const draw of frame.fallbackDraws) {
        if (!draw.transparent) continue;
        const bg = fallbackBindings[bIdx++];
        if (bg !== undefined) pass.setBindGroup(0, bg);
        pass.setVertexBuffer(0, draw.meshId);
        if (draw.indexCount > 0) {
          pass.setIndexBuffer(draw.meshId, draw.isUint32Index);
          pass.drawIndexed(draw.indexCount, 1, draw.firstIndex, draw.baseVertex, 0);
        } else {
          pass.draw(draw.vertexCount, 1, draw.firstVertex, 0);
        }
      }
    },
  });
}

function addBloomPasses(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  targets: MutableKernelPipelineTargets,
  hdrFormat: GPUTextureFormat,
): Result<void, KernelError> {
  const bloomA = builder.createTexture('standard-bloom-a', { format: hdrFormat, scale: 0.5 });
  if (!bloomA.ok) return bloomA;
  const bloomB = builder.createTexture('standard-bloom-b', { format: hdrFormat, scale: 0.5 });
  if (!bloomB.ok) return bloomB;

  const hdrIn = targets.currentColor;
  let bgExtract = 0;
  const r1 = builder.addRasterPass('standard-bloom-extract-h', {
    reads: [hdrIn],
    colorAttachments: [
      { target: bloomA.value, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
    ],
    prepare(frame, res) {
      const u = res.writeUniform(frame.bloomUboBytes);
      const b = res.beginBindingSet();
      res.bindTexture(b, 0, hdrIn);
      b.bindSampler(1, frame.postSampler).bindUniformSlice(2, u.offset, u.length);
      bgExtract = b.finish();
    },
    encode(pass, frame) {
      pass.drawFullscreen(frame.shaders.bloomExtractH, bgExtract as BindingSetId);
    },
  });
  if (!r1.ok) return r1;

  let bgBlurV = 0;
  const r2 = builder.addRasterPass('standard-bloom-blur-v', {
    reads: [bloomA.value],
    colorAttachments: [
      { target: bloomB.value, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
    ],
    prepare(frame, res) {
      const u = res.writeUniform(frame.bloomUboBytes);
      const b = res.beginBindingSet();
      res.bindTexture(b, 0, bloomA.value);
      b.bindSampler(1, frame.postSampler).bindUniformSlice(2, u.offset, u.length);
      bgBlurV = b.finish();
    },
    encode(pass, frame) {
      pass.drawFullscreen(frame.shaders.bloomBlurV, bgBlurV as BindingSetId);
    },
  });
  if (!r2.ok) return r2;

  let bgComp = 0;
  return builder.addRasterPass('standard-bloom-composite', {
    reads: [bloomB.value],
    colorAttachments: [{ target: hdrIn, loadOp: 'load', storeOp: 'store' }],
    prepare(frame, res) {
      const u = res.writeUniform(frame.bloomUboBytes);
      const b = res.beginBindingSet();
      res.bindTexture(b, 0, bloomB.value);
      b.bindSampler(1, frame.postSampler).bindUniformSlice(2, u.offset, u.length);
      bgComp = b.finish();
    },
    encode(pass, frame) {
      pass.drawFullscreen(frame.shaders.bloomComposite, bgComp as BindingSetId);
    },
  });
}

function addTonemapPass(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  srcHdr: KernelGraphTextureHandle,
  dstLdr: KernelGraphTextureHandle,
  useOutputShader: boolean,
): Result<void, KernelError> {
  let bg = 0;
  return builder.addRasterPass('standard-tonemap', {
    reads: [srcHdr],
    colorAttachments: [
      { target: dstLdr, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
    ],
    prepare(frame, res) {
      const u = res.writeUniform(frame.tonemapUboBytes);
      const b = res.beginBindingSet();
      res.bindTexture(b, 0, srcHdr);
      b.bindSampler(1, frame.postSampler).bindUniformSlice(2, u.offset, u.length);
      bg = b.finish();
    },
    encode(pass, frame) {
      const shader: ShaderProgramId = useOutputShader
        ? frame.shaders.tonemapOutput
        : frame.shaders.tonemapLdr;
      pass.drawFullscreen(shader, bg as BindingSetId);
    },
  });
}

function addFxaaPass(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  srcLdr: KernelGraphTextureHandle,
  dstOutput: KernelGraphTextureHandle,
): Result<void, KernelError> {
  let bg = 0;
  return builder.addRasterPass('standard-fxaa', {
    reads: [srcLdr],
    colorAttachments: [
      { target: dstOutput, loadOp: 'clear', storeOp: 'store', clearColor: [0, 0, 0, 1] },
    ],
    prepare(frame, res) {
      const u = res.writeUniform(frame.fxaaUboBytes);
      const b = res.beginBindingSet();
      res.bindTexture(b, 0, srcLdr);
      b.bindSampler(1, frame.postSampler).bindUniformSlice(2, u.offset, u.length);
      bg = b.finish();
    },
    encode(pass, frame) {
      pass.drawFullscreen(frame.shaders.fxaaOutput, bg as BindingSetId);
    },
  });
}

function addDebugAndUiOverlayPasses(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  topology: KernelStandardGraphTopology,
  hdrTarget: KernelGraphTextureHandle,
  mainDepth: KernelGraphTextureHandle,
  finalTarget: KernelGraphTextureHandle,
): Result<void, KernelError> {
  if (topology.hasDebugLines) {
    const dbgScratch = new Float32Array(20);
    let dbgBg = 0;
    const dbgRes = builder.addRasterPass('standard-debug-lines', {
      colorAttachments: [{ target: hdrTarget, loadOp: 'load', storeOp: 'store' }],
      depthAttachment: { target: mainDepth, loadOp: 'load', storeOp: 'store' },
      prepare(frame, res) {
        dbgScratch.set(frame.camera.viewProj, 0);
        dbgScratch[16] = frame.camera.exposure ?? 1.0;
        const u = res.writeUniform(new Uint8Array(dbgScratch.buffer));
        dbgBg = res.beginBindingSet().bindUniformSlice(0, u.offset, u.length).finish();
      },
      encode(pass, frame) {
        if (frame.debugLineBuffer === undefined || frame.debugLineVertexCount <= 0) return;
        pass.setShaderPipeline(frame.shaders.debugLines, 0, 2, 1);
        pass.setBindGroup(0, dbgBg as BindingSetId);
        pass.setVertexBuffer(0, frame.debugLineBuffer);
        pass.draw(frame.debugLineVertexCount, 1, 0, 0);
      },
    });
    if (!dbgRes.ok) return dbgRes;
  }
  if (topology.hasUiOverlay) {
    let uiBg = 0;
    const uiRes = builder.addRasterPass('standard-ui-overlay', {
      colorAttachments: [{ target: finalTarget, loadOp: 'load', storeOp: 'store' }],
      prepare(frame, res) {
        if (!frame.uiOverlayActive || frame.uiOverlayTexId === undefined) {
          uiBg = 0;
          return;
        }
        uiBg = res
          .beginBindingSet()
          .bindDynamicTexture(0, frame.uiOverlayTexId)
          .bindSampler(1, frame.postSampler)
          .finish();
      },
      encode(pass, frame) {
        if (uiBg === 0) return;
        pass.drawFullscreen(frame.shaders.uiOverlayOutput, uiBg as BindingSetId);
      },
    });
    if (!uiRes.ok) return uiRes;
  }
  return ok(undefined);
}

function hasActiveStageFeature(
  features: readonly KernelRenderFeature<KernelStandardPipelineFrame>[],
  stages: readonly string[],
): boolean {
  for (const f of features) {
    if (f.enabled !== false && stages.includes(f.stage)) return true;
  }
  return false;
}

interface StandardGraphTargets {
  readonly hdrColor: KernelGraphTextureHandle;
  readonly mainDepth: KernelGraphTextureHandle;
  readonly shadowDepth: KernelGraphTextureHandle | undefined;
  readonly ldrColor: KernelGraphTextureHandle | undefined;
  readonly outputTarget: KernelGraphTextureHandle;
  readonly targets: ReturnType<typeof createPipelineTargets>;
}

function runFeatureStages(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  features: readonly KernelRenderFeature<KernelStandardPipelineFrame>[],
  targets: ReturnType<typeof createPipelineTargets>,
  stages: readonly KernelRenderFeature<KernelStandardPipelineFrame>['stage'][],
): Result<void, KernelError> {
  for (const stage of stages) {
    const res = builder.installFeatures(stage, features, targets);
    if (!res.ok) return res;
  }
  return ok(undefined);
}

function allocateStandardTargets(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  topology: KernelStandardGraphTopology,
  features: readonly KernelRenderFeature<KernelStandardPipelineFrame>[],
): Result<StandardGraphTargets, KernelError> {
  const hdrColor = builder.createTexture('standard-hdr-color', {
    format: topology.hdrFormat,
    colorDomain: COLOR_DOMAIN_LINEAR_HDR,
  });
  if (!hdrColor.ok) return hdrColor;

  const mainDepth = builder.createTexture('standard-scene-depth', { format: 'depth32float' });
  if (!mainDepth.ok) return mainDepth;

  let shadowDepth: KernelGraphTextureHandle | undefined;
  if (topology.hasShadowLight && topology.supportsScene4Bgl) {
    const sh = builder.createTexture('standard-shadow-depth', {
      format: 'depth32float',
      width: topology.shadowAtlasDim,
      height: topology.shadowAtlasDim,
    });
    if (!sh.ok) return sh;
    shadowDepth = sh.value;
  }

  const outputTarget = topology.headless
    ? builder.createTexture('standard-output', {
        format: topology.outputFormat,
        colorDomain: COLOR_DOMAIN_DISPLAY_ENCODED,
      })
    : builder.importSurface('standard-swapchain', { format: topology.outputFormat });
  if (!outputTarget.ok) return outputTarget;

  const needsLdrBuffer =
    topology.fxaaEnabled || hasActiveStageFeature(features, ['after-tonemap', 'post']);
  let ldrColor: KernelGraphTextureHandle | undefined;
  if (needsLdrBuffer) {
    const ldr = builder.createTexture('standard-ldr-color', {
      format: 'rgba8unorm',
      colorDomain: COLOR_DOMAIN_DISPLAY_ENCODED,
    });
    if (!ldr.ok) return ldr;
    ldrColor = ldr.value;
  }

  const targets = createPipelineTargets({
    sceneColor: hdrColor.value,
    sceneDepth: mainDepth.value,
    ...(shadowDepth === undefined ? {} : { shadowMap: shadowDepth }),
    ...(ldrColor === undefined ? {} : { ldrColor }),
    outputTarget: outputTarget.value,
  });
  return ok({
    hdrColor: hdrColor.value,
    mainDepth: mainDepth.value,
    shadowDepth,
    ldrColor,
    outputTarget: outputTarget.value,
    targets,
  });
}

function buildStandardShadowAndSkyPhase(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  topology: KernelStandardGraphTopology,
  features: readonly KernelRenderFeature<KernelStandardPipelineFrame>[],
  allocated: StandardGraphTargets,
): Result<void, KernelError> {
  const preShadow = runFeatureStages(builder, features, allocated.targets, ['before-shadow']);
  if (!preShadow.ok) return preShadow;
  if (allocated.shadowDepth !== undefined) {
    const sh = addShadowPass(builder, allocated.shadowDepth);
    if (!sh.ok) return sh;
  }
  const mid = runFeatureStages(builder, features, allocated.targets, [
    'after-shadow',
    'environment',
  ]);
  if (!mid.ok) return mid;
  if (topology.hasSkybox) {
    const sky = addSkyboxPass(builder, allocated.hdrColor);
    if (!sky.ok) return sky;
  }
  return runFeatureStages(builder, features, allocated.targets, ['before-scene', 'before-opaque']);
}

function buildStandardGeometryPhase(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  topology: KernelStandardGraphTopology,
  features: readonly KernelRenderFeature<KernelStandardPipelineFrame>[],
  allocated: StandardGraphTargets,
): Result<void, KernelError> {
  const opaque = addOpaqueScenePass(
    builder,
    allocated.hdrColor,
    allocated.mainDepth,
    allocated.shadowDepth,
    topology.hasSkybox,
  );
  if (!opaque.ok) return opaque;

  const mid = runFeatureStages(builder, features, allocated.targets, [
    'after-depth',
    'after-opaque',
    'before-medium',
    'before-transparent',
  ]);
  if (!mid.ok) return mid;

  if (topology.hasTransparent) {
    const transp = addTransparentScenePass(
      builder,
      allocated.targets,
      allocated.mainDepth,
      allocated.shadowDepth,
    );
    if (!transp.ok) return transp;
  }

  if (topology.hasDebugLines) {
    const dbg = addDebugAndUiOverlayPasses(
      builder,
      { ...topology, hasUiOverlay: false },
      allocated.targets.currentColor,
      allocated.mainDepth,
      allocated.outputTarget,
    );
    if (!dbg.ok) return dbg;
  }

  return runFeatureStages(builder, features, allocated.targets, [
    'after-transparent',
    'scene',
    'before-post',
  ]);
}

function buildStandardPostAndPresentPhase(
  builder: KernelRenderGraphBuilderLike<KernelStandardPipelineFrame>,
  topology: KernelStandardGraphTopology,
  features: readonly KernelRenderFeature<KernelStandardPipelineFrame>[],
  allocated: StandardGraphTargets,
): Result<void, KernelError> {
  if (topology.bloomEnabled) {
    const bloom = addBloomPasses(builder, allocated.targets, topology.hdrFormat);
    if (!bloom.ok) return bloom;
  }

  const tonemapDest = allocated.ldrColor ?? allocated.outputTarget;
  const tm = addTonemapPass(
    builder,
    allocated.targets.currentColor,
    tonemapDest,
    allocated.ldrColor === undefined,
  );
  if (!tm.ok) return tm;
  allocated.targets.setCurrentColor(tonemapDest);

  const postStages = runFeatureStages(builder, features, allocated.targets, [
    'after-tonemap',
    'post',
  ]);
  if (!postStages.ok) return postStages;

  if (topology.fxaaEnabled) {
    const fxaa = addFxaaPass(builder, allocated.targets.currentColor, allocated.outputTarget);
    if (!fxaa.ok) return fxaa;
    allocated.targets.setCurrentColor(allocated.outputTarget);
  } else if (allocated.targets.currentColor.id !== allocated.outputTarget.id) {
    const copy = builder.addCopyTexturePass('standard-present-copy', {
      source: allocated.targets.currentColor,
      destination: allocated.outputTarget,
    });
    if (!copy.ok) return copy;
    allocated.targets.setCurrentColor(allocated.outputTarget);
  }

  const afterPost = runFeatureStages(builder, features, allocated.targets, ['after-post']);
  if (!afterPost.ok) return afterPost;

  if (topology.hasUiOverlay) {
    const ui = addDebugAndUiOverlayPasses(
      builder,
      { ...topology, hasDebugLines: false },
      allocated.hdrColor,
      allocated.mainDepth,
      allocated.outputTarget,
    );
    if (!ui.ok) return ui;
  }

  const prePresent = runFeatureStages(builder, features, allocated.targets, ['before-present']);
  if (!prePresent.ok) return prePresent;

  if (topology.hasReadback) {
    return builder.addReadbackPass('standard-readback', {
      source: allocated.outputTarget,
      ticketId: (frame) => frame.readbackTicketId ?? 0,
    });
  }
  return ok(undefined);
}

/**
 * Constructs a declarative Standard 3D PBR `KernelRenderPipeline` for the given immutable topology.
 * Compiles once per `(width, height, topology)` via `KernelGraphCache` and executes identically on
 * Desktop Native (Metal/DX12/Vulkan), WebGPU/Dawn, and Browser WebGL2 WASM closure.
 */
export function createKernelStandardPipeline(
  topology: KernelStandardGraphTopology,
): KernelRenderPipeline<KernelStandardPipelineFrame> {
  return {
    name: 'forgeax::kernel-standard',
    build(builder, features) {
      const allocRes = allocateStandardTargets(builder, topology, features);
      if (!allocRes.ok) return allocRes;
      const p1 = buildStandardShadowAndSkyPhase(builder, topology, features, allocRes.value);
      if (!p1.ok) return p1;
      const p2 = buildStandardGeometryPhase(builder, topology, features, allocRes.value);
      if (!p2.ok) return p2;
      return buildStandardPostAndPresentPhase(builder, topology, features, allocRes.value);
    },
  };
}
