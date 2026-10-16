import type { TextureFormat } from '@forgeax/engine-rhi';

/** Render-owned logical targets exposed to producer-owned RenderFeatures. */

export type RenderFeatureTargetKind = 'scene-color' | 'scene-depth';

/**
 * A logical attachment supplied by the active RenderPipeline.
 *
 * The semantic kind plus attachment facts identify the target. The active
 * pipeline supplies the graph resource, so feature authors never name an
 * internal graph key.
 */
export interface RenderFeatureTargetHandle {
  /** Stable alias used when a pipeline exposes more than one color role. */
  readonly name?: string;
  readonly kind: RenderFeatureTargetKind;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly __renderFeatureTarget: unique symbol;
}

export interface RenderFeatureTargetInput {
  readonly name?: string;
  readonly kind: RenderFeatureTargetKind;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export function createRenderFeatureTarget(
  input: RenderFeatureTargetInput,
): RenderFeatureTargetHandle {
  return Object.freeze({ ...input }) as RenderFeatureTargetHandle;
}

export function isRenderFeatureTargetHandle(value: unknown): value is RenderFeatureTargetHandle {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<RenderFeatureTargetInput>;
  return (
    (candidate.kind === 'scene-color' || candidate.kind === 'scene-depth') &&
    typeof candidate.format === 'string' &&
    (candidate.sampleCount === 1 || candidate.sampleCount === 4)
  );
}

export function resolveStandardRenderFeatureTargets(input: {
  readonly tonemap: string;
  readonly antialias: string;
  readonly storageBuffer: boolean;
  readonly multisample: boolean;
  readonly colorAttachmentFormat: TextureFormat;
  /** Expose cloud history aliases only while a CloudLayer is authored. */
  readonly cloudHistory?: boolean;
}): readonly RenderFeatureTargetHandle[] {
  const sampleCount: 1 | 4 = input.antialias === 'msaa' && input.multisample ? 4 : 1;
  // Standard always exposes the scene to features as a linear float target;
  // the shared Output Transform owns the eventual RGBA8 write for every
  // antialias mode, including no-AA/WebGL2.
  const linearLdr =
    input.tonemap === 'none' ||
    input.antialias === 'fxaa' ||
    (input.antialias === 'msaa' && input.multisample);
  const colorFormat =
    input.tonemap !== 'none' || linearLdr ? 'rgba16float' : input.colorAttachmentFormat;
  return [
    createRenderFeatureTarget({
      name: 'color',
      kind: 'scene-color',
      format: colorFormat,
      sampleCount,
    }),
    createRenderFeatureTarget({
      name: 'depth',
      kind: 'scene-depth',
      format: 'depth32float-stencil8',
      sampleCount,
    }),
    createRenderFeatureTarget({
      name: 'motion-input',
      kind: 'scene-color',
      format: colorFormat,
      sampleCount,
    }),
    createRenderFeatureTarget({
      name: 'motion-output',
      kind: 'scene-color',
      format: colorFormat,
      sampleCount: 1,
    }),
    // A graph-owned, single-sample map produced before direct-solar lighting.
    // The logical handle lets the feature plan validate its producer before
    // the Standard pipeline allocates the concrete texture.
    createRenderFeatureTarget({
      name: 'cloud-shadow',
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    }),
    // These are declarative aliases only. Standard allocates the actual
    // linear-LDR ping-pong target at the ordered post stage and resolves these
    // names through `contributeFeatures` when that stage is reached.
    createRenderFeatureTarget({
      name: 'barrel-input',
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    }),
    createRenderFeatureTarget({
      name: 'barrel-output',
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    }),
    ...(input.cloudHistory === true
      ? [
          createRenderFeatureTarget({
            name: 'cloud-history-radiance-previous',
            kind: 'scene-color',
            format: 'rgba16float',
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-radiance-current',
            kind: 'scene-color',
            format: 'rgba16float',
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-transmittance-previous',
            kind: 'scene-color',
            format: 'rgba16float',
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-transmittance-current',
            kind: 'scene-color',
            format: 'rgba16float',
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-depth-previous',
            kind: 'scene-color',
            format: 'rgba16float',
            sampleCount: 1,
          }),
          createRenderFeatureTarget({
            name: 'cloud-history-depth-current',
            kind: 'scene-color',
            format: 'rgba16float',
            sampleCount: 1,
          }),
        ]
      : []),
  ];
}
