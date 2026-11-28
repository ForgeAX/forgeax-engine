// Declarative KernelRenderFeature extension host for DesktopNativeSceneRenderer.
// Compiles installed user features into a cached KernelRenderGraph subgraph and records them
// into the active FrameRecorder at HDR (`before-post`) or output (`before-present`) boundaries.

import type { FrameRecorder } from '../command-stream.js';
import { type KernelError, kernelErr, ok, type Result } from '../errors.js';
import { createPipelineTargets } from '../graph/builder.js';
import { KernelGraphCache } from '../graph/cache.js';
import type { KernelRenderFeature, KernelRenderPipeline } from '../graph/types.js';
import type { SamplerId, TextureOrTempId } from '../handles.js';

export interface DesktopFeatureFrameContext {
  readonly width: number;
  readonly height: number;
  readonly hdrColor: TextureOrTempId;
  readonly mainDepth: TextureOrTempId;
  readonly outputTarget: TextureOrTempId;
  readonly postSampler: SamplerId;
  readonly viewUniformOffset: number;
  readonly viewUniformLength: number;
}

export class DesktopFeatureHost {
  private readonly features: KernelRenderFeature<DesktopFeatureFrameContext>[] = [];
  private readonly hdrCache = new KernelGraphCache<DesktopFeatureFrameContext>();
  private readonly presentCache = new KernelGraphCache<DesktopFeatureFrameContext>();

  register(feature: KernelRenderFeature<DesktopFeatureFrameContext>): Result<void, KernelError> {
    if (this.features.some((f) => f.name === feature.name)) {
      return kernelErr(
        'kernel-handle-invalid',
        'DesktopNativeSceneRenderer.registerFeature',
        'unique feature name',
        `feature '${feature.name}' is already registered`,
      );
    }
    this.features.push(feature);
    this.hdrCache.invalidate();
    this.presentCache.invalidate();
    return ok(undefined);
  }

  unregister(name: string): boolean {
    const idx = this.features.findIndex((f) => f.name === name);
    if (idx < 0) return false;
    this.features.splice(idx, 1);
    this.hdrCache.invalidate();
    this.presentCache.invalidate();
    return true;
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const idx = this.features.findIndex((f) => f.name === name);
    if (idx < 0) return false;
    const prev = this.features[idx];
    if (prev === undefined) return false;
    this.features[idx] = { ...prev, enabled };
    this.hdrCache.invalidate();
    this.presentCache.invalidate();
    return true;
  }

  list(): readonly { readonly name: string; readonly stage: string; readonly enabled: boolean }[] {
    return this.features.map((f) => ({
      name: f.name,
      stage: f.stage,
      enabled: f.enabled !== false,
    }));
  }

  recordWithPost(
    rec: FrameRecorder,
    ctx: DesktopFeatureFrameContext,
    recordPost: () => void,
  ): void {
    this.recordBeforePost(rec, ctx);
    recordPost();
    this.recordBeforePresent(rec, ctx);
  }

  recordBeforePost(rec: FrameRecorder, ctx: DesktopFeatureFrameContext): void {
    const active = this.features.filter(
      (f) => f.enabled !== false && (f.stage === 'before-post' || f.stage === 'after-opaque'),
    );
    if (active.length === 0) return;
    const key = active.map((f) => `${f.stage}:${f.name}`).join(',');
    const pipe: KernelRenderPipeline<DesktopFeatureFrameContext> = {
      name: 'desktop-before-post-features',
      build(builder, feats) {
        const hdr = builder.importTexture(
          'desktop-hdr',
          { format: 'rgba16float' },
          (c) => c.hdrColor,
        );
        if (!hdr.ok) return hdr;
        const depth = builder.importTexture(
          'desktop-depth',
          { format: 'depth32float' },
          (c) => c.mainDepth,
        );
        if (!depth.ok) return depth;
        const out = builder.importTexture(
          'desktop-out',
          { format: 'rgba8unorm' },
          (c) => c.outputTarget,
        );
        if (!out.ok) return out;
        const targets = createPipelineTargets({
          sceneColor: hdr.value,
          sceneDepth: depth.value,
          outputTarget: out.value,
        });
        const r1 = builder.installFeatures('after-opaque', feats, targets);
        if (!r1.ok) return r1;
        return builder.installFeatures('before-post', feats, targets);
      },
    };
    const compiled = this.hdrCache.getOrCompile(pipe, active, ctx.width, ctx.height, key);
    if (compiled.ok) compiled.value.record(rec, ctx);
  }

  recordBeforePresent(rec: FrameRecorder, ctx: DesktopFeatureFrameContext): void {
    const active = this.features.filter(
      (f) =>
        f.enabled !== false &&
        (f.stage === 'after-post' || f.stage === 'before-present' || f.stage === 'post'),
    );
    if (active.length === 0) return;
    const key = active.map((f) => `${f.stage}:${f.name}`).join(',');
    const pipe: KernelRenderPipeline<DesktopFeatureFrameContext> = {
      name: 'desktop-before-present-features',
      build(builder, feats) {
        const hdr = builder.importTexture(
          'desktop-hdr',
          { format: 'rgba16float' },
          (c) => c.hdrColor,
        );
        if (!hdr.ok) return hdr;
        const out = builder.importTexture(
          'desktop-out',
          { format: 'rgba8unorm' },
          (c) => c.outputTarget,
        );
        if (!out.ok) return out;
        const targets = createPipelineTargets({ sceneColor: hdr.value, outputTarget: out.value });
        targets.setCurrentColor(out.value);
        const r1 = builder.installFeatures('post', feats, targets);
        if (!r1.ok) return r1;
        const r2 = builder.installFeatures('after-post', feats, targets);
        if (!r2.ok) return r2;
        return builder.installFeatures('before-present', feats, targets);
      },
    };
    const compiled = this.presentCache.getOrCompile(pipe, active, ctx.width, ctx.height, key);
    if (compiled.ok) compiled.value.record(rec, ctx);
  }
}
