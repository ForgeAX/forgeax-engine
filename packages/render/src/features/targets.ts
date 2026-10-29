import type { TextureFormat } from '@forgeax/engine-rhi';
import type { RenderFeatureLogicalTarget } from './plan';

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

const LOGICAL_TARGET = Symbol('render-feature-logical-target');
type OwnedTarget = RenderFeatureTargetHandle & {
  readonly [LOGICAL_TARGET]: {
    readonly owner: RenderFeatureTargetInput;
    readonly value: RenderFeatureLogicalTarget;
  };
};

function projectLogicalTarget(target: RenderFeatureTargetInput): RenderFeatureLogicalTarget {
  return {
    name: target.name ?? (target.kind === 'scene-color' ? 'color' : 'depth'),
    kind: target.kind === 'scene-color' ? ('color' as const) : ('depth' as const),
    format: target.format,
    sampleCount: target.sampleCount,
  };
}

export function createRenderFeatureTarget(
  input: RenderFeatureTargetInput,
): RenderFeatureTargetHandle {
  const target = { ...input };
  // Both the value and its projection belong to this immutable target.
  // A replacement target computes its own projection at creation.
  Object.defineProperty(target, LOGICAL_TARGET, {
    value: Object.freeze({ owner: target, value: Object.freeze(projectLogicalTarget(target)) }),
  });
  return Object.freeze(target) as OwnedTarget;
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
  const cloudHistory = input.cloudHistory === true;
  const targets = Object.freeze([
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
    ...(cloudHistory
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
  ]);
  return targets;
}

/** Owned handles carry immutable logical rows; borrowed handles are read on every call. */
export function logicalRenderFeatureTargets(
  targets: readonly RenderFeatureTargetHandle[],
): readonly RenderFeatureLogicalTarget[] {
  return Object.freeze(
    targets.map((target) => {
      const projection = (target as Partial<OwnedTarget>)[LOGICAL_TARGET];
      // A borrowed proxy may forward private properties without owning them.
      return projection?.owner === target ? projection.value : projectLogicalTarget(target);
    }),
  );
}
