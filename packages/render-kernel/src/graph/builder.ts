// Low-frequency device-agnostic RenderGraph compiler targeting RenderKernel.
// Validates RAW/WAR/WAW access ordering, same-pass read+write hazards, uninitialized transient
// reads, derives GPU texture usages, optimizes MSAA `storeOp: 'auto'`, and groups compatible
// adjacent raster passes into an immutable CompiledKernelGraph.

import { COLOR_DOMAIN_LINEAR_HDR } from '../command-stream.js';
import { textureFormatBytesPerPixel } from '../dynamic-texture.js';
import { type KernelError, kernelErr, ok, type Result } from '../errors.js';
import type { BufferId, TextureOrTempId } from '../handles.js';
import {
  buildCompiledTextureSlot,
  type CompiledBufferSlot,
  type CompiledGraphPassEntry,
  CompiledKernelGraph,
  unwrapTextureHandle,
} from './compiled.js';
import type {
  CompiledKernelGraphInfo,
  KernelGraphBufferHandle,
  KernelGraphComputePassDesc,
  KernelGraphCopyBufferPassDesc,
  KernelGraphCopyTexturePassDesc,
  KernelGraphDependencyInfo,
  KernelGraphPassInfo,
  KernelGraphPassKind,
  KernelGraphRasterPassDesc,
  KernelGraphReadbackPassDesc,
  KernelGraphResourceInfo,
  KernelGraphResourceOrigin,
  KernelGraphTextureDesc,
  KernelGraphTextureHandle,
  KernelGraphTextureRef,
  KernelGraphTextureViewDesc,
  KernelGraphTextureViewHandle,
  KernelPipelineTargets,
  KernelRenderFeature,
  KernelRenderFeatureStage,
  KernelRenderGraphBuilderLike,
  KernelRenderPipeline,
  MutableKernelPipelineTargets,
} from './types.js';

/** Creates a mutable target carrier supporting ping-pong `currentColor` handoff across features. */
export function createPipelineTargets(init: {
  readonly sceneColor: KernelGraphTextureHandle;
  readonly outputTarget: KernelGraphTextureHandle;
  readonly sceneDepth?: KernelGraphTextureHandle;
  readonly shadowMap?: KernelGraphTextureHandle;
  readonly ldrColor?: KernelGraphTextureHandle;
  readonly extras?: Readonly<Record<string, KernelGraphTextureHandle>>;
}): MutableKernelPipelineTargets {
  const extras: Record<string, KernelGraphTextureHandle> = { ...(init.extras ?? {}) };
  const targets: MutableKernelPipelineTargets = {
    sceneColor: init.sceneColor,
    ...(init.sceneDepth === undefined ? {} : { sceneDepth: init.sceneDepth }),
    ...(init.shadowMap === undefined ? {} : { shadowMap: init.shadowMap }),
    ...(init.ldrColor === undefined ? {} : { ldrColor: init.ldrColor }),
    currentColor: init.sceneColor,
    outputTarget: init.outputTarget,
    extras,
    setCurrentColor(next: KernelGraphTextureHandle) {
      targets.currentColor = next;
    },
    setExtra(name: string, handle: KernelGraphTextureHandle) {
      extras[name] = handle;
    },
  };
  return targets;
}

function orderStageFeatures<Frame>(
  stage: KernelRenderFeatureStage,
  stageFeatures: readonly KernelRenderFeature<Frame>[],
  alreadyInstalled: ReadonlySet<string>,
): Result<readonly KernelRenderFeature<Frame>[], KernelError> {
  const byName = new Map<string, KernelRenderFeature<Frame>>();
  for (const f of stageFeatures) {
    if (byName.has(f.name) || alreadyInstalled.has(f.name)) {
      return kernelErr(
        'kernel-handle-invalid',
        `KernelRenderGraphBuilder.installFeatures(${stage})`,
        'unique feature name',
        `duplicate feature '${f.name}'`,
      );
    }
    byName.set(f.name, f);
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: KernelRenderFeature<Frame>[] = [];

  const visit = (feature: KernelRenderFeature<Frame>): Result<void, KernelError> => {
    if (visited.has(feature.name)) return ok(undefined);
    if (visiting.has(feature.name)) {
      return kernelErr(
        'kernel-pass-resource-conflict',
        `KernelRenderGraphBuilder.installFeatures(${stage})`,
        'acyclic feature dependencies',
        `dependency cycle detected involving feature '${feature.name}'`,
      );
    }
    visiting.add(feature.name);
    for (const depName of feature.dependencies ?? []) {
      const sameStageDep = byName.get(depName);
      if (sameStageDep !== undefined) {
        const depRes = visit(sameStageDep);
        if (!depRes.ok) return depRes;
      } else if (!alreadyInstalled.has(depName)) {
        return kernelErr(
          'kernel-handle-invalid',
          `KernelRenderGraphBuilder.installFeatures(${stage})`,
          `installed dependency '${depName}'`,
          `feature '${feature.name}' depends on '${depName}' which is not installed in stage '${stage}' or an earlier stage`,
        );
      }
    }
    visiting.delete(feature.name);
    visited.add(feature.name);
    ordered.push(feature);
    return ok(undefined);
  };

  for (const f of stageFeatures) {
    const res = visit(f);
    if (!res.ok) return res;
  }
  return ok(ordered);
}

const USAGE_COPY_SRC = 0x01;
const USAGE_COPY_DST = 0x02;
const USAGE_TEXTURE_BINDING = 0x04;
const USAGE_RENDER_ATTACHMENT = 0x10;

interface DeclaredTexture<Frame> {
  readonly id: number;
  readonly name: string;
  readonly origin: KernelGraphResourceOrigin;
  readonly format: GPUTextureFormat;
  readonly width?: number;
  readonly height?: number;
  readonly scale: number;
  readonly sampleCount: 1 | 4;
  readonly mipLevelCount: number;
  readonly arrayLayerCount: number;
  readonly colorDomain: number;
  readonly resolve?: (frame: Frame) => TextureOrTempId;
}

type DeclaredPass<Frame> =
  | {
      readonly kind: 'raster';
      readonly name: string;
      readonly desc: KernelGraphRasterPassDesc<Frame>;
    }
  | {
      readonly kind: 'compute';
      readonly name: string;
      readonly desc: KernelGraphComputePassDesc<Frame>;
    }
  | {
      readonly kind: 'copy-texture';
      readonly name: string;
      readonly desc: KernelGraphCopyTexturePassDesc<Frame>;
    }
  | {
      readonly kind: 'copy-buffer';
      readonly name: string;
      readonly desc: KernelGraphCopyBufferPassDesc<Frame>;
    }
  | {
      readonly kind: 'mipgen';
      readonly name: string;
      readonly target: KernelGraphTextureHandle;
      readonly when?: (frame: Frame) => boolean;
    }
  | {
      readonly kind: 'readback';
      readonly name: string;
      readonly desc: KernelGraphReadbackPassDesc<Frame>;
    };

interface TextureTracking {
  derivedUsage: number;
  initialized: boolean;
  firstPass: number;
  lastPass: number;
  lastWriter: number;
  lastReaders: number[];
}

function touchTex(track: TextureTracking, passIndex: number, usageBit: number): void {
  track.derivedUsage |= usageBit;
  if (track.firstPass === -1) track.firstPass = passIndex;
  track.lastPass = passIndex;
}

function recordRead(
  track: TextureTracking,
  texName: string,
  passIndex: number,
  passName: string,
  passNames: readonly string[],
  deps: KernelGraphDependencyInfo[],
): Result<void, KernelError> {
  if (!track.initialized) {
    return kernelErr(
      'kernel-pass-resource-conflict',
      `KernelRenderGraph(${passName})`,
      `initialized texture '${texName}'`,
      `graph-created texture '${texName}' is read before any pass writes to it`,
    );
  }
  if (track.lastWriter >= 0 && track.lastWriter !== passIndex) {
    deps.push({
      kind: 'RAW',
      resource: texName,
      fromPass: passNames[track.lastWriter] ?? '',
      toPass: passName,
    });
  }
  track.lastReaders.push(passIndex);
  return ok(undefined);
}

function recordWrite(
  track: TextureTracking,
  texName: string,
  passIndex: number,
  passName: string,
  passNames: readonly string[],
  deps: KernelGraphDependencyInfo[],
): void {
  if (track.lastWriter >= 0 && track.lastWriter !== passIndex) {
    deps.push({
      kind: 'WAW',
      resource: texName,
      fromPass: passNames[track.lastWriter] ?? '',
      toPass: passName,
    });
  }
  for (const r of track.lastReaders) {
    if (r !== passIndex) {
      deps.push({ kind: 'WAR', resource: texName, fromPass: passNames[r] ?? '', toPass: passName });
    }
  }
  track.initialized = true;
  track.lastWriter = passIndex;
  track.lastReaders.length = 0;
}

function collectRasterWrittenIds<Frame>(desc: KernelGraphRasterPassDesc<Frame>): Set<number> {
  const writtenIds = new Set<number>();
  for (const a of desc.colorAttachments) {
    writtenIds.add(unwrapTextureHandle(a.target).id);
    if (a.resolveTarget !== undefined) writtenIds.add(unwrapTextureHandle(a.resolveTarget).id);
  }
  if (desc.depthAttachment !== undefined && !desc.depthAttachment.readOnly) {
    writtenIds.add(unwrapTextureHandle(desc.depthAttachment.target).id);
  }
  return writtenIds;
}

function rasterAttachmentSignature<Frame>(desc: KernelGraphRasterPassDesc<Frame>): string {
  const parts: string[] = [];
  for (const c of desc.colorAttachments) {
    const h = unwrapTextureHandle(c.target);
    const r = c.resolveTarget === undefined ? -1 : unwrapTextureHandle(c.resolveTarget).id;
    const mip = c.target.kind === 'graph-texture-view' ? c.target.baseMipLevel : 0;
    const layer = c.target.kind === 'graph-texture-view' ? c.target.baseArrayLayer : 0;
    parts.push(`c:${h.id}:${r}:${mip}:${layer}`);
  }
  if (desc.depthAttachment !== undefined) {
    const h = unwrapTextureHandle(desc.depthAttachment.target);
    const mip =
      desc.depthAttachment.target.kind === 'graph-texture-view'
        ? desc.depthAttachment.target.baseMipLevel
        : 0;
    parts.push(`d:${h.id}:${mip}:${desc.depthAttachment.readOnly ? 1 : 0}`);
  }
  return parts.join('|');
}

function isUnconditionalLoad<Frame>(desc: KernelGraphRasterPassDesc<Frame>): boolean {
  for (const c of desc.colorAttachments) {
    if (c.loadOp !== 'load') return false;
  }
  if (desc.depthAttachment !== undefined && !desc.depthAttachment.readOnly) {
    if (desc.depthAttachment.loadOp !== 'load') return false;
  }
  return true;
}

export interface KernelRenderGraphCompileOptions {
  readonly surfaceSize: { readonly width: number; readonly height: number };
}

export class KernelRenderGraphBuilder<Frame> implements KernelRenderGraphBuilderLike<Frame> {
  private readonly textures: DeclaredTexture<Frame>[] = [];
  private readonly textureNames = new Set<string>();
  private readonly buffers: CompiledBufferSlot<Frame>[] = [];
  private readonly bufferNames = new Set<string>();
  private readonly passes: DeclaredPass<Frame>[] = [];
  private readonly passNames = new Set<string>();
  private readonly installedFeatures: {
    readonly name: string;
    readonly stage: KernelRenderFeatureStage;
  }[] = [];

  createTexture(
    name: string,
    desc: KernelGraphTextureDesc,
  ): Result<KernelGraphTextureHandle, KernelError> {
    if (this.textureNames.has(name)) {
      return kernelErr(
        'kernel-handle-invalid',
        'KernelRenderGraphBuilder.createTexture',
        'unique texture name',
        `duplicate texture '${name}'`,
      );
    }
    const id = this.textures.length;
    this.textureNames.add(name);
    this.textures.push({
      id,
      name,
      origin: 'transient',
      format: desc.format,
      ...(desc.width === undefined ? {} : { width: desc.width }),
      ...(desc.height === undefined ? {} : { height: desc.height }),
      scale: desc.scale ?? 1,
      sampleCount: desc.sampleCount ?? 1,
      mipLevelCount: Math.max(1, desc.mipLevelCount ?? 1),
      arrayLayerCount: Math.max(1, desc.arrayLayerCount ?? 1),
      colorDomain: desc.colorDomain ?? COLOR_DOMAIN_LINEAR_HDR,
    });
    return ok({ kind: 'graph-texture', id, name, origin: 'transient', format: desc.format });
  }

  importTexture(
    name: string,
    desc: { readonly format: GPUTextureFormat; readonly width?: number; readonly height?: number },
    resolve: (frame: Frame) => TextureOrTempId,
  ): Result<KernelGraphTextureHandle, KernelError> {
    if (this.textureNames.has(name)) {
      return kernelErr(
        'kernel-handle-invalid',
        'KernelRenderGraphBuilder.importTexture',
        'unique texture name',
        `duplicate texture '${name}'`,
      );
    }
    const id = this.textures.length;
    this.textureNames.add(name);
    this.textures.push({
      id,
      name,
      origin: 'imported',
      format: desc.format,
      ...(desc.width === undefined ? {} : { width: desc.width }),
      ...(desc.height === undefined ? {} : { height: desc.height }),
      scale: 1,
      sampleCount: 1,
      mipLevelCount: 1,
      arrayLayerCount: 1,
      colorDomain: COLOR_DOMAIN_LINEAR_HDR,
      resolve,
    });
    return ok({ kind: 'graph-texture', id, name, origin: 'imported', format: desc.format });
  }

  importSurface(
    name: string,
    desc: { readonly format: GPUTextureFormat },
    resolve?: (frame: Frame) => TextureOrTempId,
  ): Result<KernelGraphTextureHandle, KernelError> {
    if (this.textureNames.has(name)) {
      return kernelErr(
        'kernel-handle-invalid',
        'KernelRenderGraphBuilder.importSurface',
        'unique surface name',
        `duplicate texture '${name}'`,
      );
    }
    const id = this.textures.length;
    this.textureNames.add(name);
    this.textures.push({
      id,
      name,
      origin: 'surface',
      format: desc.format,
      scale: 1,
      sampleCount: 1,
      mipLevelCount: 1,
      arrayLayerCount: 1,
      colorDomain: COLOR_DOMAIN_LINEAR_HDR,
      ...(resolve === undefined ? {} : { resolve }),
    });
    return ok({ kind: 'graph-texture', id, name, origin: 'surface', format: desc.format });
  }

  importBuffer(
    name: string,
    resolve: (frame: Frame) => BufferId,
  ): Result<KernelGraphBufferHandle, KernelError> {
    if (this.bufferNames.has(name)) {
      return kernelErr(
        'kernel-handle-invalid',
        'KernelRenderGraphBuilder.importBuffer',
        'unique buffer name',
        `duplicate buffer '${name}'`,
      );
    }
    const id = this.buffers.length;
    this.bufferNames.add(name);
    this.buffers.push({ id, name, resolve });
    return ok({ kind: 'graph-buffer', id, name });
  }

  view(
    texture: KernelGraphTextureHandle,
    desc: KernelGraphTextureViewDesc,
  ): KernelGraphTextureViewHandle {
    return {
      kind: 'graph-texture-view',
      texture,
      baseMipLevel: desc.baseMipLevel ?? 0,
      ...(desc.mipLevelCount === undefined ? {} : { mipLevelCount: desc.mipLevelCount }),
      baseArrayLayer: desc.baseArrayLayer ?? 0,
      aspect: desc.aspect ?? 'all',
    };
  }

  private registerPassName(name: string): Result<void, KernelError> {
    if (this.passNames.has(name)) {
      return kernelErr(
        'kernel-handle-invalid',
        'KernelRenderGraphBuilder',
        'unique pass name',
        `duplicate pass '${name}'`,
      );
    }
    this.passNames.add(name);
    return ok(undefined);
  }

  addRasterPass(name: string, desc: KernelGraphRasterPassDesc<Frame>): Result<void, KernelError> {
    const check = this.registerPassName(name);
    if (!check.ok) return check;
    this.passes.push({ kind: 'raster', name, desc });
    return ok(undefined);
  }

  addComputePass(name: string, desc: KernelGraphComputePassDesc<Frame>): Result<void, KernelError> {
    const check = this.registerPassName(name);
    if (!check.ok) return check;
    this.passes.push({ kind: 'compute', name, desc });
    return ok(undefined);
  }

  addCopyTexturePass(
    name: string,
    desc: KernelGraphCopyTexturePassDesc<Frame>,
  ): Result<void, KernelError> {
    const check = this.registerPassName(name);
    if (!check.ok) return check;
    this.passes.push({ kind: 'copy-texture', name, desc });
    return ok(undefined);
  }

  addCopyBufferPass(
    name: string,
    desc: KernelGraphCopyBufferPassDesc<Frame>,
  ): Result<void, KernelError> {
    const check = this.registerPassName(name);
    if (!check.ok) return check;
    this.passes.push({ kind: 'copy-buffer', name, desc });
    return ok(undefined);
  }

  addMipGenPass(
    name: string,
    target: KernelGraphTextureHandle,
    when?: (frame: Frame) => boolean,
  ): Result<void, KernelError> {
    const check = this.registerPassName(name);
    if (!check.ok) return check;
    this.passes.push({ kind: 'mipgen', name, target, ...(when === undefined ? {} : { when }) });
    return ok(undefined);
  }

  addReadbackPass(
    name: string,
    desc: KernelGraphReadbackPassDesc<Frame>,
  ): Result<void, KernelError> {
    const check = this.registerPassName(name);
    if (!check.ok) return check;
    this.passes.push({ kind: 'readback', name, desc });
    return ok(undefined);
  }

  private readonly installedFeatureNames = new Set<string>();

  installFeatures(
    stage: KernelRenderFeatureStage,
    features: readonly KernelRenderFeature<Frame>[],
    targets: KernelPipelineTargets,
  ): Result<void, KernelError> {
    const active = features.filter((f) => f.stage === stage && f.enabled !== false);
    if (active.length === 0) return ok(undefined);
    const orderedRes = orderStageFeatures(stage, active, this.installedFeatureNames);
    if (!orderedRes.ok) return orderedRes;
    for (const feature of orderedRes.value) {
      const res = feature.install(this, targets);
      if (!res.ok) return res;
      this.installedFeatureNames.add(feature.name);
      this.installedFeatures.push({ name: feature.name, stage });
    }
    return ok(undefined);
  }

  compile(
    options: KernelRenderGraphCompileOptions,
  ): Result<CompiledKernelGraph<Frame>, KernelError> {
    const surfaceW = Math.max(1, Math.floor(options.surfaceSize.width));
    const surfaceH = Math.max(1, Math.floor(options.surfaceSize.height));
    const tracking: TextureTracking[] = this.textures.map((t) => ({
      derivedUsage: 0,
      initialized: t.origin !== 'transient',
      firstPass: -1,
      lastPass: -1,
      lastWriter: -1,
      lastReaders: [],
    }));
    const deps: KernelGraphDependencyInfo[] = [];
    const passNameList = this.passes.map((p) => p.name);

    const analysisErr = this.analyzePasses(tracking, passNameList, deps);
    if (analysisErr !== undefined) return analysisErr;

    const resourceInfos = this.buildResourceInfos(tracking, surfaceW, surfaceH);
    const { compiledPasses, passInfos } = this.lowerPassesAndBatches(tracking);
    const compiledTexSlots = this.textures.map((t, i) => {
      const infoItem = resourceInfos[i];
      if (infoItem === undefined) {
        throw new Error(`KernelRenderGraphBuilder: missing resource info for slot ${i}`);
      }
      return buildCompiledTextureSlot(i, infoItem, t.colorDomain, t.resolve);
    });
    const info: CompiledKernelGraphInfo = {
      surfaceSize: { width: surfaceW, height: surfaceH },
      resources: resourceInfos,
      passes: passInfos,
      dependencies: deps,
      installedFeatures: [...this.installedFeatures],
    };
    return ok(
      new CompiledKernelGraph(
        info.surfaceSize,
        compiledTexSlots,
        [...this.buffers],
        compiledPasses,
        info,
      ),
    );
  }

  private analyzePasses(
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<never, KernelError> | undefined {
    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      if (p === undefined) continue;
      const res = this.analyzeSinglePass(p, i, tracking, passNames, deps);
      if (!res.ok) return res;
    }
    return undefined;
  }

  private analyzeSinglePass(
    pass: DeclaredPass<Frame>,
    index: number,
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<void, KernelError> {
    switch (pass.kind) {
      case 'raster':
        return this.analyzeRasterPass(pass.name, pass.desc, index, tracking, passNames, deps);
      case 'compute':
        return this.analyzeTextureReads(
          pass.name,
          pass.desc.textureReads,
          index,
          tracking,
          passNames,
          deps,
        );
      case 'copy-texture':
        return this.analyzeCopyTexturePass(pass.name, pass.desc, index, tracking, passNames, deps);
      case 'mipgen':
        return this.analyzeMipGenPass(pass.name, pass.target, index, tracking, passNames, deps);
      case 'readback':
        return this.analyzeReadbackPass(pass.name, pass.desc, index, tracking, passNames, deps);
      case 'copy-buffer':
        return ok(undefined);
    }
  }

  private analyzeTextureReads(
    passName: string,
    reads: readonly KernelGraphTextureRef[] | undefined,
    index: number,
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<void, KernelError> {
    if (reads === undefined) return ok(undefined);
    for (const ref of reads) {
      const h = unwrapTextureHandle(ref);
      const track = tracking[h.id];
      if (track === undefined) continue;
      touchTex(track, index, USAGE_TEXTURE_BINDING);
      const r = recordRead(track, h.name, index, passName, passNames, deps);
      if (!r.ok) return r;
    }
    return ok(undefined);
  }

  private analyzeRasterPass(
    passName: string,
    desc: KernelGraphRasterPassDesc<Frame>,
    index: number,
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<void, KernelError> {
    const writtenIds = collectRasterWrittenIds(desc);
    const readRes = this.analyzeRasterReads(
      passName,
      desc.reads,
      writtenIds,
      index,
      tracking,
      passNames,
      deps,
    );
    if (!readRes.ok) return readRes;
    const colorRes = this.analyzeRasterColors(
      passName,
      desc.colorAttachments,
      index,
      tracking,
      passNames,
      deps,
    );
    if (!colorRes.ok) return colorRes;
    return this.analyzeRasterDepth(
      passName,
      desc.depthAttachment,
      index,
      tracking,
      passNames,
      deps,
    );
  }

  private analyzeRasterReads(
    passName: string,
    reads: readonly KernelGraphTextureRef[] | undefined,
    writtenIds: ReadonlySet<number>,
    index: number,
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<void, KernelError> {
    if (reads === undefined) return ok(undefined);
    for (const ref of reads) {
      const h = unwrapTextureHandle(ref);
      if (writtenIds.has(h.id)) {
        return kernelErr(
          'kernel-pass-resource-conflict',
          `KernelRenderGraph(${passName})`,
          `non-conflicting access to '${h.name}'`,
          `texture '${h.name}' cannot be both written as an attachment and sampled in the same pass`,
        );
      }
      const track = tracking[h.id];
      if (track === undefined) continue;
      touchTex(track, index, USAGE_TEXTURE_BINDING);
      const r = recordRead(track, h.name, index, passName, passNames, deps);
      if (!r.ok) return r;
    }
    return ok(undefined);
  }

  private analyzeRasterColors(
    passName: string,
    attachments: KernelGraphRasterPassDesc<Frame>['colorAttachments'],
    index: number,
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<void, KernelError> {
    for (const a of attachments) {
      const h = unwrapTextureHandle(a.target);
      const track = tracking[h.id];
      if (track === undefined) continue;
      touchTex(track, index, USAGE_RENDER_ATTACHMENT);
      if (a.loadOp === 'load' || typeof a.loadOp === 'function') {
        const r = recordRead(track, h.name, index, passName, passNames, deps);
        if (!r.ok) return r;
      }
      recordWrite(track, h.name, index, passName, passNames, deps);
      if (a.resolveTarget !== undefined) {
        const rh = unwrapTextureHandle(a.resolveTarget);
        const rTrack = tracking[rh.id];
        if (rTrack !== undefined) {
          touchTex(rTrack, index, USAGE_RENDER_ATTACHMENT);
          recordWrite(rTrack, rh.name, index, passName, passNames, deps);
        }
      }
    }
    return ok(undefined);
  }

  private analyzeRasterDepth(
    passName: string,
    depth: KernelGraphRasterPassDesc<Frame>['depthAttachment'],
    index: number,
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<void, KernelError> {
    if (depth === undefined) return ok(undefined);
    const dh = unwrapTextureHandle(depth.target);
    const dTrack = tracking[dh.id];
    if (dTrack === undefined) return ok(undefined);
    touchTex(dTrack, index, USAGE_RENDER_ATTACHMENT);
    if (depth.readOnly || depth.loadOp === 'load') {
      const r = recordRead(dTrack, dh.name, index, passName, passNames, deps);
      if (!r.ok) return r;
    }
    if (!depth.readOnly) {
      recordWrite(dTrack, dh.name, index, passName, passNames, deps);
    }
    return ok(undefined);
  }

  private analyzeCopyTexturePass(
    passName: string,
    desc: KernelGraphCopyTexturePassDesc<Frame>,
    index: number,
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<void, KernelError> {
    const srcH = unwrapTextureHandle(desc.source);
    const dstH = unwrapTextureHandle(desc.destination);
    if (srcH.id === dstH.id) {
      return kernelErr(
        'kernel-pass-resource-conflict',
        `KernelRenderGraph(${passName})`,
        'distinct source and destination textures',
        `copy-texture cannot copy '${srcH.name}' onto itself`,
      );
    }
    const srcTrack = tracking[srcH.id];
    const dstTrack = tracking[dstH.id];
    if (srcTrack !== undefined) {
      touchTex(srcTrack, index, USAGE_COPY_SRC);
      const r = recordRead(srcTrack, srcH.name, index, passName, passNames, deps);
      if (!r.ok) return r;
    }
    if (dstTrack !== undefined) {
      touchTex(dstTrack, index, USAGE_COPY_DST);
      recordWrite(dstTrack, dstH.name, index, passName, passNames, deps);
    }
    return ok(undefined);
  }

  private analyzeMipGenPass(
    passName: string,
    target: KernelGraphTextureHandle,
    index: number,
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<void, KernelError> {
    const track = tracking[target.id];
    if (track === undefined) return ok(undefined);
    touchTex(track, index, USAGE_TEXTURE_BINDING | USAGE_RENDER_ATTACHMENT);
    const r = recordRead(track, target.name, index, passName, passNames, deps);
    if (!r.ok) return r;
    recordWrite(track, target.name, index, passName, passNames, deps);
    return ok(undefined);
  }

  private analyzeReadbackPass(
    passName: string,
    desc: KernelGraphReadbackPassDesc<Frame>,
    index: number,
    tracking: TextureTracking[],
    passNames: readonly string[],
    deps: KernelGraphDependencyInfo[],
  ): Result<void, KernelError> {
    const h = unwrapTextureHandle(desc.source);
    const track = tracking[h.id];
    if (track === undefined) return ok(undefined);
    touchTex(track, index, USAGE_COPY_SRC);
    return recordRead(track, h.name, index, passName, passNames, deps);
  }

  private buildResourceInfos(
    tracking: readonly TextureTracking[],
    surfaceW: number,
    surfaceH: number,
  ): KernelGraphResourceInfo[] {
    return this.textures.map((t, i) => {
      const tr = tracking[i];
      const width =
        t.width !== undefined && t.width > 0
          ? t.width
          : Math.max(1, Math.round(surfaceW * t.scale));
      const height =
        t.height !== undefined && t.height > 0
          ? t.height
          : Math.max(1, Math.round(surfaceH * t.scale));
      const bpp = textureFormatBytesPerPixel(t.format);
      const estimatedBytes =
        t.origin === 'transient' ? width * height * bpp * t.sampleCount * t.arrayLayerCount : 0;
      return {
        name: t.name,
        origin: t.origin,
        format: t.format,
        width,
        height,
        sampleCount: t.sampleCount,
        mipLevelCount: t.mipLevelCount,
        arrayLayerCount: t.arrayLayerCount,
        derivedUsage: (tr?.derivedUsage ?? 0) || USAGE_RENDER_ATTACHMENT | USAGE_TEXTURE_BINDING,
        firstPass: tr?.firstPass ?? -1,
        lastPass: tr?.lastPass ?? -1,
        estimatedBytes,
      };
    });
  }

  private lowerPassesAndBatches(tracking: readonly TextureTracking[]): {
    compiledPasses: CompiledGraphPassEntry<Frame>[];
    passInfos: KernelGraphPassInfo[];
  } {
    const compiledPasses: CompiledGraphPassEntry<Frame>[] = [];
    const passInfos: KernelGraphPassInfo[] = [];
    let batchId = -1;
    let prevSig: string | undefined;

    for (let i = 0; i < this.passes.length; i++) {
      const p = this.passes[i];
      if (p === undefined) continue;
      if (p.kind === 'raster') {
        const sig = rasterAttachmentSignature(p.desc);
        const canMerge =
          prevSig !== undefined &&
          prevSig === sig &&
          p.desc.when === undefined &&
          isUnconditionalLoad(p.desc);
        if (!canMerge) batchId += 1;
        prevSig = p.desc.when === undefined ? sig : undefined;

        const autoDiscarded: string[] = [];
        const resolvedStoreOps = p.desc.colorAttachments.map((a) => {
          if (a.storeOp === 'discard') return 'discard' as const;
          if (a.storeOp === 'auto') {
            const h = unwrapTextureHandle(a.target);
            const decl = this.textures[h.id];
            const tr = tracking[h.id];
            const canDiscard =
              decl !== undefined &&
              tr !== undefined &&
              decl.origin === 'transient' &&
              decl.sampleCount > 1 &&
              a.loadOp === 'clear' &&
              a.resolveTarget !== undefined &&
              tr.lastPass === i;
            if (canDiscard) {
              autoDiscarded.push(h.name);
              return 'discard' as const;
            }
          }
          return 'store' as const;
        });

        compiledPasses.push({
          kind: 'raster',
          name: p.name,
          labelId: i + 1,
          desc: p.desc,
          resolvedStoreOps,
        });
        passInfos.push({
          name: p.name,
          kind: 'raster',
          index: i,
          rasterBatch: batchId,
          autoDiscardedAttachments: autoDiscarded,
        });
      } else {
        prevSig = undefined;
        compiledPasses.push(this.lowerNonRasterPass(p, i));
        passInfos.push({
          name: p.name,
          kind: p.kind as KernelGraphPassKind,
          index: i,
          rasterBatch: -1,
          autoDiscardedAttachments: [],
        });
      }
    }
    return { compiledPasses, passInfos };
  }

  private lowerNonRasterPass(
    p: Exclude<DeclaredPass<Frame>, { kind: 'raster' }>,
    index: number,
  ): CompiledGraphPassEntry<Frame> {
    if (p.kind === 'compute') {
      return { kind: 'compute', name: p.name, labelId: index + 1, desc: p.desc };
    }
    if (p.kind === 'copy-texture') {
      return { kind: 'copy-texture', name: p.name, desc: p.desc };
    }
    if (p.kind === 'copy-buffer') {
      return { kind: 'copy-buffer', name: p.name, desc: p.desc };
    }
    if (p.kind === 'mipgen') {
      return {
        kind: 'mipgen',
        name: p.name,
        target: p.target,
        ...(p.when === undefined ? {} : { when: p.when }),
      };
    }
    return { kind: 'readback', name: p.name, desc: p.desc };
  }
}

/** Compiles a declarative `KernelRenderPipeline` with ordered user `KernelRenderFeature`s. */
export function compileKernelRenderPipeline<Frame>(
  pipeline: KernelRenderPipeline<Frame>,
  features: readonly KernelRenderFeature<Frame>[],
  options: KernelRenderGraphCompileOptions,
): Result<CompiledKernelGraph<Frame>, KernelError> {
  const builder = new KernelRenderGraphBuilder<Frame>();
  const buildRes = pipeline.build(builder, features);
  if (!buildRes.ok) return buildRes;
  return builder.compile(options);
}
