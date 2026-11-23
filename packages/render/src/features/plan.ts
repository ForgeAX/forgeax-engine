import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import type { GraphBufferAccess, GraphTextureAccess } from '@forgeax/engine-render-graph';
import type { RhiCaps, TextureFormat } from '@forgeax/engine-rhi';
import { type Asset, type BindGroupLayoutEntry, err, ok, type Result } from '@forgeax/engine-types';
import type { RenderError } from '../errors/render';
import { isSceneDataTarget, type SceneDataTarget } from '../temporal/scene-data';
import {
  type RenderFeatureSamplerDescriptor,
  type RenderFeatureTextureDescriptor,
  validFeatureTexture,
} from './feature-texture';
import {
  isRenderFeatureTextureSource,
  type RenderFeatureTextureSource,
} from './feature-texture-source';
import {
  isOwnedRenderFeatureProgramData,
  type RenderFeatureGpuBufferUsage,
  type RenderFeatureGpuProgramDescriptor,
  type RenderFeatureNativePlanBuilder,
  type RenderFeatureNativePlanToken,
  validRenderFeatureWorkgroups,
} from './prepared-gpu-work';
import type { RenderFeaturePipelineDescriptor } from './prepared-graphics';
import { type RenderFeatureTemporalStage, validRenderFeatureTemporalStage } from './temporal-stage';
import {
  isRenderFeatureTextureReference,
  type RenderFeatureTextureReference,
} from './texture-source';
import type { RenderFeatureGpuBufferInitialization } from './types';

export type RenderFeatureResourceUsage = GraphBufferAccess | GraphTextureAccess;
export type FullscreenRenderFeatureStage = 'before-temporal' | 'after-output';

/**
 * Renderer-owned binding layout contract for a material shader.
 *
 * Producer features use this read-only projection to describe which logical
 * scene resources a custom material consumes. The render owner remains the
 * source of truth for the shader source and its pipeline layout.
 */
export type RenderFeatureMaterialShaderBindingContract =
  import('@forgeax/engine-types').MaterialProgramBindingContract;

export interface RenderFeatureMaterialShaderContract {
  readonly forwardFog?: 'height-vertex/1';
  readonly bindings: RenderFeatureMaterialShaderBindingContract;
  readonly sceneDepth?: import('@forgeax/engine-types').MaterialSceneDepth;
  readonly systemInputs?: import('@forgeax/engine-types').MaterialProgramSystemInputs;
  readonly entryPoints?: readonly import('@forgeax/engine-types').ShaderEntryPointReads[];
}

export type RenderFeatureFullscreenRead =
  | string
  | {
      readonly key: string;
      readonly sampleType?: 'depth' | 'float-3d-repeat' | 'unfilterable-float';
      /** Use binding 0 for the sole depth input. */
      readonly primary?: true;
    };

/** A named graph target or an authorized semantic sampled-read target. */
export type RenderFeatureSampledTarget = string | SceneDataTarget | RenderFeatureTextureReference;

/** A cooked fullscreen shader declaration owned by a RenderFeature plan. */
export interface RenderFeatureFullscreenProgramDeclaration {
  readonly kind: 'fullscreen-program';
  /** Admit this scoped declaration into Standard's automatic post chain. */
  readonly chain?: true;
  /** Inline graphics may consume this canonical clip-space stream instead of vertex_index. */
  readonly vertexLayout?: 'clip-position-color';
  /** Sample count of the declared depth read, independently of the color output. */
  readonly depthSampleCount?: 1 | 4;
  readonly name: string;
  readonly source: string;
  readonly stage?: FullscreenRenderFeatureStage;
  /** Optional fragment entry point when one WGSL module owns multiple passes. */
  readonly fragmentEntryPoint?: string;
  readonly reads?: readonly RenderFeatureFullscreenRead[];
  /** Bind the renderer-owned View group at group(0) for camera reconstruction. */
  readonly usesView?: boolean;
  /** Read-only storage buffers appended after the regular color/depth reads. */
  readonly storageBindings?: readonly number[];
  /** Current uniform bytes for an automatic chain pass. Must match params.byteSize. */
  readonly frameParams?: Uint8Array;
  readonly params?: {
    readonly byteSize: number;
    readonly defaultValue: Uint8Array;
  };
}

export type RenderFeatureBindingValue =
  | null
  | boolean
  | number
  | string
  | ArrayBufferView
  | SceneDataTarget
  | readonly RenderFeatureBindingValue[]
  | { readonly [name: string]: RenderFeatureBindingValue };

export type RenderFeatureResourceDeclaration =
  | RenderFeatureFullscreenProgramDeclaration
  | {
      readonly kind: 'feature-texture-reference';
      readonly name: string;
      readonly source: RenderFeatureTextureSource;
    }
  | ({ readonly kind: 'texture'; readonly name: string } & RenderFeatureTextureDescriptor)
  | {
      readonly kind: 'sampler';
      readonly name: string;
      readonly descriptor: RenderFeatureSamplerDescriptor;
    }
  | { readonly kind: 'texture-alias'; readonly name: string; readonly resource: string }
  | {
      /** A graph-owned texture whose storage lifetime is this compiled frame graph. */
      readonly kind: 'graph-texture';
      readonly name: string;
      readonly allocationKey: string;
      /** Expose this view as a same-frame ordinary material texture source. */
      readonly materialSource?: boolean;
      readonly descriptor: import('@forgeax/engine-render-graph').GraphTextureDescriptor & {
        readonly size: {
          readonly width: number;
          readonly height: number;
          readonly depthOrArrayLayers: number;
        };
      };
      readonly view?: import('@forgeax/engine-render-graph').GraphTextureViewDescriptor;
    }
  | {
      /** Once-per-frame scene capture from an explicit simulation camera. */
      readonly kind: 'scene-depth';
      readonly name: string;
      readonly camera: NonNullable<import('./types').RenderFeatureExtractView['selectedView']>;
    }
  | { readonly kind: 'scene-noise'; readonly name: string }
  | {
      /** Renderer-owned geometric field from this exact composition World. */
      readonly kind: 'scene-sdf';
      readonly name: string;
      readonly descriptor: import('./scene-sdf').RenderFeatureSceneSdfDescriptor;
    }
  | {
      readonly kind: 'compute-program';
      readonly name: string;
      /** Request native compilation completion before this program becomes ready. */
      readonly preparePipelines?: boolean;
      readonly program: RenderFeatureGpuProgramDescriptor;
    }
  | {
      readonly kind: 'graphics-program';
      readonly name: string;
      readonly program: RenderFeaturePipelineDescriptor;
    }
  | {
      readonly kind: 'buffer';
      readonly name: string;
      /** Replace storage transactionally when its committed content identity changes. */
      readonly allocationKey?: string;
      readonly size: number;
      readonly usage: readonly RenderFeatureGpuBufferUsage[];
      readonly data?: ArrayBufferView;
      readonly initialization?: RenderFeatureGpuBufferInitialization;
      /** Ordered writes to disjoint or deliberately overlapping buffer ranges. */
      readonly uploads?: readonly {
        readonly offset: number;
        readonly data: ArrayBufferView;
      }[];
    }
  | {
      /** A resident generation-owned resource supplied by a render-owned provider. */
      readonly kind: 'prepared-gpu-resource';
      readonly name: string;
      readonly resource:
        | {
            readonly kind: 'buffer';
            readonly value: unknown;
            readonly size: number;
            readonly usage?: readonly RenderFeatureGpuBufferUsage[];
          }
        | {
            readonly kind: 'texture-view';
            readonly value: unknown;
          }
        | {
            readonly kind: 'sampler';
            readonly value: unknown;
          };
      /** Acquired only when this resource enters a graph candidate. */
      readonly acquireResidencyLease?: () => import('./prepared-gpu-work').PreparedGraphicsResourceLease;
      /** Optional graph target or semantic scene-data target backing the resource. */
      readonly logicalTarget?: RenderFeatureSampledTarget;
    }
  | {
      readonly kind: 'compute-bindings';
      readonly name: string;
      readonly program: string;
      readonly entries: readonly {
        readonly binding: number;
        readonly resource: string;
        readonly offset?: number;
        readonly size?: number;
      }[];
    }
  | {
      readonly kind: 'graphics-bindings';
      readonly name: string;
      readonly program: string;
      readonly values: Readonly<Record<string, RenderFeatureBindingValue>>;
      readonly logicalTargets?: Readonly<Record<string, string>>;
    }
  | {
      readonly kind: 'vertex-data';
      readonly name: string;
      readonly layout: string;
      readonly data: ArrayBufferView | readonly number[];
      readonly buffer?: never;
    }
  | {
      readonly kind: 'vertex-data';
      readonly name: string;
      readonly layout: string;
      readonly buffer: string;
      readonly offset?: number;
      readonly size?: number;
      readonly data?: never;
    }
  | {
      readonly kind: 'index-data';
      readonly name: string;
      readonly format: 'uint16' | 'uint32';
      readonly data: Uint16Array | Uint32Array;
      readonly buffer?: never;
    }
  | {
      readonly kind: 'index-data';
      readonly name: string;
      readonly format: 'uint16' | 'uint32';
      readonly buffer: string;
      readonly offset?: number;
      readonly size?: number;
      readonly data?: never;
    };

/** Renderer-owned once-per-frame scene captures; only frame-scoped work may declare them. */
export type RenderFeatureSceneResource = Extract<
  RenderFeatureResourceDeclaration,
  { readonly kind: 'scene-depth' | 'scene-noise' | 'scene-sdf' }
>;

export function isRenderFeatureSceneResource(
  resource: RenderFeatureResourceDeclaration,
): resource is RenderFeatureSceneResource {
  return (
    resource.kind === 'scene-depth' ||
    resource.kind === 'scene-noise' ||
    resource.kind === 'scene-sdf'
  );
}

export type RenderFeatureDispatch =
  | {
      readonly kind: 'direct';
      readonly entryPoint: string;
      /** Optional bindings for this dispatch; the pass program remains shared. */
      readonly bindings?: string;
      /** Frame data. A zero axis retains graph resources but records no dispatch. */
      readonly workgroups: readonly [number, number?, number?];
    }
  | {
      readonly kind: 'indirect';
      readonly entryPoint: string;
      readonly bindings?: string;
      readonly resource: string;
      readonly offset: number;
    };

export type RenderFeatureDraw =
  | {
      readonly kind: 'draw';
      readonly vertexCount: number;
      readonly instanceCount: number;
      readonly firstVertex?: number;
      readonly firstInstance?: number;
    }
  | {
      readonly kind: 'draw-indexed';
      readonly indexCount: number;
      readonly instanceCount: number;
      readonly firstIndex?: number;
      readonly baseVertex?: number;
      readonly firstInstance?: number;
    }
  | {
      readonly kind: 'draw-indirect' | 'draw-indexed-indirect';
      readonly resource: string;
      readonly offset?: number;
    };

export interface RenderFeatureDrawDeclaration {
  /** Frame data: retain resource access and ordering while skipping this draw. */
  readonly enabled?: boolean | undefined;
  readonly program: string;
  readonly bindings: readonly string[];
  readonly vertexData: readonly { readonly slot: number; readonly resource: string }[];
  readonly vertexLayout?: 'none';
  readonly indexData?: {
    readonly resource: string;
    readonly format: 'uint16' | 'uint32';
  };
  readonly draw: RenderFeatureDraw;
}

export type RenderFeaturePassDeclaration = (
  | {
      readonly kind: 'copy';
      readonly name: string;
      /** Explicit same-submit, completed-receipt texture observations. */
      readonly textureReadbacks?: readonly { readonly name: string; readonly target: string }[];
      readonly copies: readonly {
        /** Frame data: retain copy resources/order while skipping this command. */
        readonly enabled?: boolean | undefined;
        readonly source: string;
        readonly destination: string;
        readonly size: number;
        readonly sourceOffset?: number;
        readonly destinationOffset?: number;
      }[];
    }
  | {
      readonly kind: 'shadow-caster';
      readonly name: string;
      readonly draws: readonly RenderFeatureDrawDeclaration[];
    }
  | {
      readonly kind: 'compute';
      readonly name: string;
      readonly program: string;
      readonly bindings: string;
      readonly dispatches: readonly RenderFeatureDispatch[];
    }
  | {
      readonly kind: 'raster';
      readonly name: string;
      readonly colorAttachments: readonly {
        readonly target: string;
        readonly loadOp: 'load' | 'clear';
        readonly storeOp: 'store' | 'discard';
      }[];
      readonly depthStencilAttachment?: {
        readonly target: string;
        readonly depthClearValue?: number;
        readonly depthLoadOp: 'load' | 'clear';
        readonly depthStoreOp: 'store' | 'discard';
      };
      readonly sampledTargets?: readonly RenderFeatureSampledTarget[];
      readonly sceneDepth?: import('@forgeax/engine-types').MaterialSceneDepth;
      readonly draws: readonly RenderFeatureDrawDeclaration[];
    }
) & {
  readonly temporal?: RenderFeatureTemporalStage;
  /** Frame data: retain the declared resources and ordering while skipping execution. */
  readonly enabled?: boolean | undefined;
};

/**
 * The sole executable feature declaration for one frame. Programs, bindings,
 * resources, dispatches, draws, and logical targets are all named here; graph
 * access is derived from these roles rather than duplicated as reads/writes.
 */
export interface RenderFeatureWorkPlan {
  /** Every declared pass must encode in the same physical submission. */
  readonly submission?: 'atomic';
  /** Override the feature placement for this resource scope. */
  readonly placement?: import('./types').RenderFeaturePlacement;
  /** @internal Source-selected water state; dynamic content is outside plan identity. */
  readonly waterView?: import('../water/view-projection').WaterRenderView;
  readonly resources: readonly RenderFeatureResourceDeclaration[];
  readonly passes: readonly RenderFeaturePassDeclaration[];
}

export interface RenderFeatureLogicalTarget {
  readonly name: string;
  readonly kind: 'color' | 'depth' | 'swapchain';
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export interface RenderFeaturePlanView {
  /** Accepted-submit timing belongs to the receiving view, independently of source extraction. */
  readonly motionBlur?: import('./motion-blur/motion-blur-feature').MotionBlurFeatureInput;
  readonly identity: string;
  readonly render: boolean;
  readonly graphResources?: import('./types').RenderFeatureGraphResourceState;
  readonly frame: {
    readonly frameNumber: number;
    readonly width?: number;
    readonly height?: number;
    readonly extent?: import('../pipeline/render-extent').RenderExtent;
    readonly waterFoamMaterials?: readonly import('../water/fluid-foam').WaterFluidFoamMaterial[];
  };
  readonly selectedView?: import('./types').RenderFeatureExtractView['selectedView'];
  readonly targets: readonly RenderFeatureLogicalTarget[];
  readonly sceneData: import('../temporal/scene-data-catalog').SceneDataCatalog;
}

export interface RenderFeaturePlanContext {
  /** @internal Open producer-declared nested CPU work on the active Render World. */
  readonly beginProfileWork?: (
    work: string,
  ) => import('@forgeax/engine-ecs').ScheduleWorkScope | undefined;
  /** @internal Host-bound constructor for Engine-owned, non-borrowed primary work. */
  readonly createNativePlan?: () => RenderFeatureNativePlanBuilder;
  /** Resolve an exact asset in the corresponding source World or accepted publication. */
  readonly resolveAsset?: (handle: number, revision?: number) => Result<Asset, unknown>;
  /** Resolve a published material and its realm-bound compiler recipe at the accepted revision. */
  readonly resolveMaterialTemplate?: import('../publication/resource-scope').RenderResourceScope['resolveMaterialTemplate'];
  /** Resolve an exact resident texture view through the Renderer asset/residency owner. */
  readonly resolveResidentTextureView?: (
    sourceWorldIndex: number,
    guid: string,
    revision: number,
  ) => Result<Readonly<{ view: unknown; retain(): (evict?: boolean) => void }>, unknown>;

  /** Read a build-time cooked utility selected for the receiving device. */
  readonly getFeatureShaderSource?: ((identifier: string) => string | undefined) | undefined;

  readonly materialContext?: MaterialCookRasterContext;
  readonly caps: Readonly<RhiCaps>;
  readonly limits?: Readonly<Partial<GPUSupportedLimits>>;
  readonly frame: { readonly frameNumber: number };
  /** Device generation for resources whose identity is tied to the active receiver. */
  readonly deviceGeneration?: number;
  readonly generation: number;
  readonly views: readonly RenderFeaturePlanView[];
  readonly materialShaderBindingContract?: (
    materialShaderId: string,
  ) => RenderFeatureMaterialShaderContract;
}

export type RenderFeatureWorkScope = 'frame' | { readonly view: string };

/** Each scope owns its resource namespace; view work may read shared frame resources. */
export interface RenderFeatureWork extends RenderFeatureWorkPlan {
  readonly scope: RenderFeatureWorkScope;
}

/** The producer declares one frame containing shared simulation and view projections. */
export type RenderFeaturePlan =
  | {
      readonly pendingSource: { readonly resource: string; readonly reason: string };
      readonly work: readonly [];
      readonly native?: never;
      readonly sourceFeedback?: never;
      readonly readbacks?: never;
    }
  | {
      readonly pendingSource?: never;
      readonly native?: RenderFeatureNativePlanToken;
      readonly work: readonly RenderFeatureWork[];
      readonly sourceFeedback?: unknown;
      readonly readbacks?: readonly { readonly resource: string; readonly tag: unknown }[];
    };

/** Frozen declaration produced for one feature in one frame. */
export interface RenderFeaturePlannedFrame {
  readonly scope: RenderFeatureWorkScope;
  readonly featureIdentity: string;
  readonly generation: number;
  readonly signature: string;
  readonly plan: RenderFeatureWorkPlan;
  /** Placement selected by the installed feature; omitted means the legacy post stage. */
  readonly placement?: import('./types').RenderFeaturePlacement;
  readonly viewGraph?: 'transient';
}

export interface RenderFeatureDerivedAccess {
  readonly resource: string | SceneDataTarget | RenderFeatureTextureReference;
  readonly usage: RenderFeatureResourceUsage;
}

function stageFailure(identity: string): RenderError {
  return {
    code: 'render-feature-stage-failed',
    expected: 'a closed RenderFeatureWorkPlan with valid named descriptor references',
    hint: 'declare each program, binding, buffer, draw, dispatch, and logical target exactly once',
    detail: {
      featureIdentity: identity,
      order: -1,
      stage: 'plan',
      recovery: 'next-frame',
    },
  } as RenderError;
}

function declaredCopyBuffer(resource: RenderFeatureResourceDeclaration | undefined) {
  return resource?.kind === 'buffer'
    ? resource
    : resource?.kind === 'prepared-gpu-resource' && resource.resource.kind === 'buffer'
      ? resource.resource
      : undefined;
}

function validName(name: string): boolean {
  return /^[a-z][a-z0-9.-]{0,127}$/.test(name);
}

/** Detached accounting for the canonical plan signature path. */
export interface RenderFeaturePlanSignatureMetrics {
  calls: number;
  typedArrayBytes: number;
  outputChars: number;
}

const BYTE_HEX = '0123456789abcdef';
const BYTE_HEX_CHUNK_SIZE = 2048;

/**
 * Append an exact byte spelling without Array#join's per-byte number/string
 * conversion. Inline vertex/index payloads remain part of the canonical
 * signature; this only changes their private textual representation from a
 * comma-separated decimal list to bounded hex chunks.
 */
function appendByteHex(value: ArrayBufferView, parts: string[]): void {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  parts.push('[bytes-hex:');
  for (let start = 0; start < bytes.length; start += BYTE_HEX_CHUNK_SIZE) {
    const end = Math.min(bytes.length, start + BYTE_HEX_CHUNK_SIZE);
    let encoded = '';
    for (let index = start; index < end; index += 1) {
      const byte = bytes[index] as number;
      encoded += BYTE_HEX[byte >>> 4] as string;
      encoded += BYTE_HEX[byte & 0x0f] as string;
    }
    parts.push(encoded);
  }
  parts.push(']');
}

/**
 * Detached structural evidence for one plan signature.
 *
 * The renderer validates a plan twice: once while the feature host records
 * the candidate signature and again while the typed graph admits that
 * candidate. Keeping a detached structural snapshot lets the second check
 * avoid rebuilding a large string while still detecting mutations to the
 * shallow-frozen plan. This is intentionally a structural cache, not an
 * object-identity shortcut.
 */
export type RenderFeaturePlanSignatureNode =
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | {
      readonly kind: 'array';
      readonly values: readonly (RenderFeaturePlanSignatureNode | undefined)[];
    }
  | {
      readonly kind: 'object';
      readonly keys: readonly string[];
      readonly values: readonly RenderFeaturePlanSignatureNode[];
    }
  | {
      readonly kind: 'primitive';
      readonly token: string;
      readonly stringValue?: string;
      /** Token provenance captured only through the native JSON formatter. */
      readonly numberValue?: number;
    };

export interface RenderFeaturePlanSignatureSnapshot {
  readonly submission?: 'atomic';
  readonly placement?: import('./types').RenderFeaturePlacement;
  readonly resources: readonly RenderFeaturePlanSignatureNode[];
  readonly passes: RenderFeaturePlanSignatureNode;
}

const signatureEvidenceByPlan = new WeakMap<
  object,
  {
    readonly signature: string;
    readonly snapshot: RenderFeaturePlanSignatureSnapshot;
  }
>();

// Only detached renderer-owned program data can omit repeated subtree reads.
// Frozen borrowed containers (including getters and byte aliases) stay live.
const ownedProgramSignatureNodes = new WeakMap<object, RenderFeaturePlanSignatureNode>();
// Buffer topology sorts usage and adds an omitted upload field. Keep this
// normalized evidence separate from the same object's ordinary JSON subtree.
const ownedBufferSignatureNodes = new WeakMap<object, RenderFeaturePlanSignatureNode>();

function isOwnedStaticBuffer(
  resource: RenderFeatureResourceDeclaration,
): resource is Extract<RenderFeatureResourceDeclaration, { readonly kind: 'buffer' }> {
  return (
    isOwnedRenderFeatureProgramData(resource) &&
    resource.kind === 'buffer' &&
    resource.data === undefined
  );
}

// The detached evidence is deliberately checked again by graph admission.
// Host and graph therefore share one exact structural proof without trusting
// a producer-owned boolean or object identity if a plan is mutated between
// the two stages.
function compareStableKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// Capture only a native data property, without invoking a custom stringify
// accessor at module initialization. Changed/custom platform formatters use
// the unchanged generic serializer instead of any detached-token shortcut.
const signatureJson = JSON;
const signatureStringifyDescriptor = Object.getOwnPropertyDescriptor(signatureJson, 'stringify');
const signatureStringify =
  typeof signatureStringifyDescriptor?.value === 'function' &&
  Function.prototype.toString.call(signatureStringifyDescriptor.value) ===
    'function stringify() { [native code] }'
    ? (signatureStringifyDescriptor.value as typeof JSON.stringify)
    : undefined;
const signatureReflectApply = Reflect.apply;

interface OwnedStringTokens {
  lookup(value: string): string | undefined;
  remember(value: string, token: string, receiver: unknown, stringify: unknown): void;
}

export interface RenderFeatureSignatureTokenReuseMetrics {
  lookups: number;
  hits: number;
  remembered: number;
  serializedCharacters: number;
  environmentFallbacks: number;
  budgetFallbacks: number;
}

/** A token becomes evidence only after the original serializer observes the
 * primitive. No name, descriptor, prior snapshot or future author field is
 * read to populate this call-local bounded table. */
function ownedStringTokenReuse(
  metrics?: RenderFeatureSignatureTokenReuseMetrics,
): OwnedStringTokens {
  let first: readonly [string, string] | undefined;
  let tokens: Map<string, string> | undefined;
  let characters = 0;
  const canonical = () => {
    const descriptor = Object.getOwnPropertyDescriptor(signatureJson, 'stringify');
    return (
      JSON === signatureJson &&
      signatureStringify !== undefined &&
      descriptor?.value === signatureStringify
    );
  };
  return {
    lookup(value) {
      if (value.length < 256) return undefined;
      if (metrics !== undefined) metrics.lookups++;
      if (!canonical()) {
        if (metrics !== undefined) metrics.environmentFallbacks++;
        return undefined;
      }
      const token = first?.[0] === value ? first[1] : tokens?.get(value);
      if (token !== undefined && metrics !== undefined) metrics.hits++;
      return token;
    },
    remember(value, token, receiver, stringify) {
      if (
        value.length < 256 ||
        receiver !== signatureJson ||
        signatureStringify === undefined ||
        stringify !== signatureStringify
      )
        return;
      if (metrics !== undefined) metrics.serializedCharacters += value.length;
      if (first?.[0] === value || tokens?.has(value)) return;
      // These are existing immutable string references, not extra string copies.
      // Budget misses preserve the original serializer and admission behavior.
      if (
        (tokens?.size ?? (first === undefined ? 0 : 1)) >= 64 ||
        characters + value.length + token.length > 4 * 1024 * 1024
      ) {
        if (metrics !== undefined) metrics.budgetFallbacks++;
        return;
      }
      if (first === undefined) first = [value, token];
      else {
        if (tokens === undefined) tokens = new Map([first]);
        tokens.set(value, token);
      }
      characters += value.length + token.length;
      if (metrics !== undefined) metrics.remembered++;
    },
  };
}

function stablePrimitiveToken(
  value: unknown,
  previous?: Extract<RenderFeaturePlanSignatureNode, { readonly kind: 'primitive' }>,
  ownedStringTokens?: OwnedStringTokens,
): string | { readonly token: string; readonly numberValue: number } {
  // WGSL strings are immutable even when their enclosing descriptor is rebuilt.
  // Keep the canonical token while still checking every mutable container.
  if (typeof value === 'string' && previous?.stringValue === value) return previous.token;
  if (typeof value === 'string') {
    const token = ownedStringTokens?.lookup(value);
    if (token !== undefined) return token;
  }
  // Match the original method-call observation exactly: read the receiver and
  // stringify property once, then call that captured function with that receiver.
  // This also lets a native primitive hint use the function actually selected
  // after any borrowed getter changed the environment, without a second probe.
  const receiver = JSON;
  const stringify = receiver.stringify;
  const native =
    receiver === signatureJson &&
    signatureStringify !== undefined &&
    stringify === signatureStringify;
  if (native) {
    const previousToken = retainedPrimitiveToken(value, previous);
    if (previousToken !== undefined) return previousToken;
  }

  const token =
    (signatureReflectApply(stringify, receiver, [value]) as string | undefined) ?? 'undefined';
  if (typeof value === 'string') ownedStringTokens?.remember(value, token, receiver, stringify);
  if (native && typeof value === 'number') return { token, numberValue: value };
  return token;
}

function primitiveTokenText(
  result: string | { readonly token: string; readonly numberValue: number },
): string {
  return typeof result === 'string' ? result : result.token;
}

type SignatureFrameData = false | 'passes' | 'dispatches' | 'draws' | 'copies';

/**
 * Clone a signature node while reusing an unchanged subtree from the prior
 * detached snapshot.  The prior node is never mutated: a changed parent gets
 * a new frozen container and only equal children are shared.  This keeps the
 * graph-admission evidence immutable while avoiding a full tree allocation
 * when one VFX resource/pass changes.
 */
function cloneSignatureNode(
  value: unknown,
  previous?: RenderFeaturePlanSignatureNode,
  frameData: SignatureFrameData = false,
  ownedStringTokens?: OwnedStringTokens,
): RenderFeaturePlanSignatureNode {
  if (frameData === false && isOwnedRenderFeatureProgramData(value)) {
    const owned = value as object;
    const cached = ownedProgramSignatureNodes.get(owned);
    if (cached !== undefined) return cached;
    const node = cloneSignatureObject(value, previous, frameData, ownedStringTokens);
    ownedProgramSignatureNodes.set(owned, node);
    return node;
  }
  return cloneSignatureObject(value, previous, frameData, ownedStringTokens);
}

function cloneSignatureObject(
  value: unknown,
  previous?: RenderFeaturePlanSignatureNode,
  frameData: SignatureFrameData = false,
  ownedStringTokens?: OwnedStringTokens,
): RenderFeaturePlanSignatureNode {
  if (ArrayBuffer.isView(value)) return cloneSignatureBytes(value, previous);
  if (Array.isArray(value)) {
    return cloneSignatureArray(value, previous, frameData, ownedStringTokens);
  }
  if (value !== null && typeof value === 'object') {
    return cloneSignatureRecord(
      value as Readonly<Record<string, unknown>>,
      previous?.kind === 'object' ? previous : undefined,
      frameData,
      ownedStringTokens,
    );
  }
  return cloneSignaturePrimitive(value, previous, ownedStringTokens);
}

function cloneSignatureBytes(
  value: ArrayBufferView,
  previous: RenderFeaturePlanSignatureNode | undefined,
): RenderFeaturePlanSignatureNode {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (previous?.kind === 'bytes' && previous.bytes.byteLength === bytes.byteLength) {
    let equal = true;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== previous.bytes[index]) {
        equal = false;
        break;
      }
    }
    if (equal) return previous;
  }
  return { kind: 'bytes', bytes: new Uint8Array(bytes) };
}

function cloneSignatureArray(
  value: readonly unknown[],
  previous: RenderFeaturePlanSignatureNode | undefined,
  frameData: SignatureFrameData,
  ownedStringTokens: OwnedStringTokens | undefined,
): RenderFeaturePlanSignatureNode {
  const initialLength = value.length;
  const previousValues = previous?.kind === 'array' ? previous.values : undefined;
  let values: (RenderFeaturePlanSignatureNode | undefined)[] | undefined =
    previousValues === undefined || previousValues.length !== value.length
      ? new Array(initialLength)
      : undefined;
  for (let index = 0; index < value.length; index += 1) {
    const child = value[index];
    const prior = previousValues?.[index];
    const next =
      child === undefined
        ? undefined
        : cloneSignatureNode(child, prior, frameData, ownedStringTokens);
    if (values === undefined && next !== prior) {
      values = new Array(initialLength);
      // The source can shrink from a getter: only visited rows belong to
      // this projection; its unvisited suffix must remain holes.
      for (let prefix = 0; prefix < index; prefix += 1) values[prefix] = previousValues?.[prefix];
    }
    if (values !== undefined) values[index] = next;
  }
  if (values === undefined && previous?.kind === 'array') return previous;
  return Object.freeze({ kind: 'array', values: Object.freeze(values ?? []) });
}

/** Frame payload fields that are upload evidence rather than signature topology. */
function signaturePayloadKey(
  frameData: SignatureFrameData,
  source: Readonly<Record<string, unknown>>,
): string | undefined {
  if (frameData === 'passes' || frameData === 'draws' || frameData === 'copies') return 'enabled';
  return frameData === 'dispatches' && source.kind === 'direct' ? 'workgroups' : undefined;
}

/** Which frame-data command list, if any, a pass field holds. */
function passChildFrameData(passKind: unknown, key: string): SignatureFrameData {
  if (passKind === 'copy' && key === 'copies') return 'copies';
  if (passKind === 'compute' && key === 'dispatches') return 'dispatches';
  if ((passKind === 'raster' || passKind === 'shadow-caster') && key === 'draws') return 'draws';
  return false;
}

/**
 * Descriptor object shapes are stable across VFX revisions.  Reuse the
 * detached canonical key order after an allocation-free own-key check; only
 * an actual add/remove falls back to Object.keys().sort().
 */
function signatureRecordKeys(
  source: Readonly<Record<string, unknown>>,
  previousObject: Extract<RenderFeaturePlanSignatureNode, { kind: 'object' }> | undefined,
  payloadKey: string | undefined,
): readonly string[] {
  if (previousObject !== undefined && hasSignatureKeySet(source, previousObject.keys, payloadKey)) {
    return previousObject.keys;
  }
  return Object.freeze(
    Object.keys(source)
      .filter((key) => key !== payloadKey)
      .sort(compareStableKeys),
  );
}

function hasSignatureKeySet(
  source: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  payloadKey: string | undefined,
): boolean {
  let ownKeyCount = 0;
  for (const key in source) {
    if (key !== payloadKey && Object.hasOwn(source, key)) ownKeyCount += 1;
  }
  if (ownKeyCount !== keys.length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(source, key)) return false;
  }
  return true;
}

function signatureKeyPositions(keys: readonly string[]): Map<string, number> {
  const positions = new Map<string, number>();
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    if (!positions.has(key)) positions.set(key, index);
  }
  return positions;
}

function cloneSignatureRecord(
  source: Readonly<Record<string, unknown>>,
  previousObject: Extract<RenderFeaturePlanSignatureNode, { kind: 'object' }> | undefined,
  frameData: SignatureFrameData,
  ownedStringTokens: OwnedStringTokens | undefined,
): RenderFeaturePlanSignatureNode {
  const keys = signatureRecordKeys(source, previousObject, signaturePayloadKey(frameData, source));
  // The key-set proof already establishes the detached field ordinals.
  // Allocate a new value column only when a child actually changes.
  const sameKeys = keys === previousObject?.keys;
  const previousPositions =
    !sameKeys && previousObject !== undefined
      ? signatureKeyPositions(previousObject.keys)
      : undefined;
  let values: RenderFeaturePlanSignatureNode[] | undefined = sameKeys
    ? undefined
    : new Array(keys.length);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const previousIndex = sameKeys ? index : (previousPositions?.get(key) ?? -1);
    const prior = previousIndex < 0 ? undefined : previousObject?.values[previousIndex];
    const passKind = frameData === 'passes' ? source.kind : undefined;
    const next = cloneSignatureNode(
      source[key],
      prior,
      passChildFrameData(passKind, key),
      ownedStringTokens,
    );
    if (values === undefined && next !== prior) {
      values = new Array(keys.length);
      for (let prefix = 0; prefix < index; prefix += 1)
        values[prefix] = previousObject?.values[prefix] as RenderFeaturePlanSignatureNode;
    }
    if (values !== undefined) values[index] = next;
  }
  if (values === undefined && previousObject !== undefined) return previousObject;
  return Object.freeze({
    kind: 'object',
    keys,
    values: Object.freeze(values ?? []),
  });
}

function cloneSignaturePrimitive(
  value: unknown,
  previous: RenderFeaturePlanSignatureNode | undefined,
  ownedStringTokens: OwnedStringTokens | undefined,
): RenderFeaturePlanSignatureNode {
  const result = stablePrimitiveToken(
    value,
    previous?.kind === 'primitive' ? previous : undefined,
    ownedStringTokens,
  );
  const token = typeof result === 'string' ? result : result.token;
  if (previous?.kind === 'primitive' && previous.token === token) {
    if (typeof result !== 'string' && previous.numberValue === undefined)
      return { kind: 'primitive', token, numberValue: result.numberValue };
    return previous;
  }
  if (typeof value === 'string') return { kind: 'primitive', token, stringValue: value };
  return typeof result === 'string'
    ? { kind: 'primitive', token }
    : { kind: 'primitive', token, numberValue: result.numberValue };
}

function fullscreenProgramTopology(resource: RenderFeatureFullscreenProgramDeclaration) {
  if (!Object.hasOwn(resource, 'frameParams')) return resource;
  const { frameParams: _frameParams, ...topology } = resource;
  return topology;
}

function signatureResourceValue(resource: RenderFeatureResourceDeclaration): unknown {
  if (resource.kind === 'fullscreen-program') return fullscreenProgramTopology(resource);
  if (resource.kind === 'scene-depth') return { ...resource, camera: undefined };
  if (resource.kind !== 'buffer') return resource;
  // Match resourceTopology exactly: buffer payloads are upload evidence, not
  // topology identity, while usage order is canonicalized before comparison.
  const { uploads: _uploads, initialization, ...descriptor } = resource;
  return {
    ...descriptor,
    ...(initialization === undefined
      ? {}
      : { initialization: bufferInitializationTopology(initialization) }),
    usage: [...resource.usage].sort(compareStableKeys),
    data: undefined,
  };
}

/** Initialization bytes are upload evidence; only their owner version affects topology. */
function bufferInitializationTopology(
  initialization: RenderFeatureGpuBufferInitialization,
): Readonly<{ version: string; byteLength: number }> {
  return { version: initialization.version, byteLength: initialization.byteLength };
}

function signaturePassValue(pass: RenderFeaturePassDeclaration): unknown {
  if (pass.kind === 'copy') {
    const { enabled: _enabled, copies, ...topology } = pass;
    return {
      ...topology,
      copies: copies.map((copy) => {
        if (!Object.hasOwn(copy, 'enabled')) return copy;
        const { enabled: _enabled, ...command } = copy;
        return command;
      }),
    };
  }
  if (pass.kind === 'compute') {
    const { enabled: _enabled, dispatches, ...topology } = pass;
    return {
      ...topology,
      dispatches: dispatches.map((dispatch) => {
        if (dispatch.kind !== 'direct') return dispatch;
        const { workgroups: _workgroups, ...command } = dispatch;
        return command;
      }),
    };
  }
  if (pass.kind === 'raster' || pass.kind === 'shadow-caster') {
    const { enabled: _enabled, draws, ...topology } = pass;
    return {
      ...topology,
      draws: draws.map((draw) => {
        if (!Object.hasOwn(draw, 'enabled')) return draw;
        const { enabled: _enabled, ...command } = draw;
        return command;
      }),
    };
  }
  return pass;
}

/** Generic entry retains the exact original source-observation/serializer path. */
export function cloneRenderFeaturePlanSignatureSnapshot(
  plan: RenderFeatureWorkPlan,
  previous?: RenderFeaturePlanSignatureSnapshot,
): RenderFeaturePlanSignatureSnapshot {
  return cloneSignatureSnapshot(plan, previous);
}

/** Internal Host entry: reuse only canonical primitive tokens produced during
 * this clone. Mutable declarations and bytes retain their full original checks. */
export function cloneOwnedRenderFeaturePlanSignatureSnapshot(
  plan: RenderFeatureWorkPlan,
  previous?: RenderFeaturePlanSignatureSnapshot,
  metrics?: RenderFeatureSignatureTokenReuseMetrics,
): RenderFeaturePlanSignatureSnapshot {
  return cloneSignatureSnapshot(plan, previous, true, metrics);
}

function cloneResourceSignature(
  resource: RenderFeatureResourceDeclaration,
  prior: RenderFeaturePlanSignatureNode | undefined,
  ownedStringTokens: OwnedStringTokens | undefined,
): RenderFeaturePlanSignatureNode {
  const ownedStatic = isOwnedStaticBuffer(resource);
  const cached = ownedStatic ? ownedBufferSignatureNodes.get(resource) : undefined;
  const next =
    cached ?? cloneSignatureNode(signatureResourceValue(resource), prior, false, ownedStringTokens);
  if (ownedStatic && cached === undefined) ownedBufferSignatureNodes.set(resource, next);
  return next;
}

function cloneSignatureSnapshot(
  plan: RenderFeatureWorkPlan,
  previous?: RenderFeaturePlanSignatureSnapshot,
  reuseStringTokens = false,
  metrics?: RenderFeatureSignatureTokenReuseMetrics,
): RenderFeaturePlanSignatureSnapshot {
  let ownedStringTokens: OwnedStringTokens | undefined;
  function captureResourceSignatures(): readonly RenderFeaturePlanSignatureNode[] {
    const initialLength = plan.resources.length;
    let resources: RenderFeaturePlanSignatureNode[] | undefined =
      previous === undefined || previous.resources.length !== initialLength
        ? new Array(initialLength)
        : undefined;
    for (let index = 0; index < plan.resources.length; index += 1) {
      const resource = plan.resources[index] as RenderFeatureResourceDeclaration;
      // The public resource can have getters or be a Proxy. Choosing evidence
      // by a speculative name read changes its original observation/error order.
      const prior = previous?.resources[index];
      let next: RenderFeaturePlanSignatureNode;
      if (prior !== undefined && equalResourceNode(resource, prior)) {
        next = prior;
      } else {
        // Buffer `data` is deliberately outside topology identity, so avoid
        // materialising its normalized spread object on the common upload-only
        // update path.  Changed declarations still share equal descendants.
        if (reuseStringTokens) ownedStringTokens ??= ownedStringTokenReuse(metrics);
        next = cloneResourceSignature(resource, prior, ownedStringTokens);
      }
      if (resources === undefined && next !== prior) {
        resources = new Array(initialLength);
        for (let prefix = 0; prefix < index; prefix += 1)
          resources[prefix] = previous?.resources[prefix] as RenderFeaturePlanSignatureNode;
      }
      if (resources !== undefined) resources[index] = next;
    }
    const nextResources =
      resources === undefined && previous !== undefined
        ? previous.resources
        : Object.freeze(resources ?? []);
    return nextResources;
  }
  const nextResources = captureResourceSignatures();
  let nextPasses = previous?.passes;
  // Host hits only compare existing evidence. Defer its token table and pass
  // projection until there is changed work; generic capture retains its reads.
  if (
    !reuseStringTokens ||
    nextPasses === undefined ||
    !equalSignaturePasses(plan.passes, nextPasses)
  ) {
    if (reuseStringTokens) ownedStringTokens ??= ownedStringTokenReuse(metrics);
    nextPasses = cloneSignatureNode(plan.passes, nextPasses, 'passes', ownedStringTokens);
  }
  if (
    previous !== undefined &&
    previous.placement === plan.placement &&
    nextResources === previous.resources &&
    nextPasses === previous.passes &&
    plan.submission === previous.submission
  ) {
    return previous;
  }
  return Object.freeze({
    ...(plan.placement === undefined ? {} : { placement: plan.placement }),
    resources: nextResources,
    passes: nextPasses,
    ...(plan.submission === undefined ? {} : { submission: plan.submission }),
  });
}

function equalSignatureNode(
  value: unknown,
  snapshot: RenderFeaturePlanSignatureNode,
  frameData: false | 'dispatches' | 'draws' | 'copies' = false,
): boolean {
  if (
    frameData === false &&
    isOwnedRenderFeatureProgramData(value) &&
    ownedProgramSignatureNodes.get(value as object) === snapshot
  )
    return true;
  if (snapshot.kind === 'bytes') {
    if (!ArrayBuffer.isView(value) || value.byteLength !== snapshot.bytes.byteLength) return false;
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] !== snapshot.bytes[index]) return false;
    }
    return true;
  }
  if (snapshot.kind === 'primitive')
    return primitiveTokenText(stablePrimitiveToken(value, snapshot)) === snapshot.token;
  if (snapshot.kind === 'array') {
    if (!Array.isArray(value) || value.length !== snapshot.values.length) return false;
    for (let index = 0; index < snapshot.values.length; index += 1) {
      const expected = snapshot.values[index];
      const current = value[index];
      if (expected === undefined) {
        // stable() intentionally spells holes and explicit undefined alike.
        if (current !== undefined) return false;
      } else if (!equalSignatureNode(current, expected, frameData)) {
        return false;
      }
    }
    return true;
  }
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ArrayBuffer.isView(value)
  ) {
    return false;
  }
  const source = value as Readonly<Record<string, unknown>>;
  const payloadKey =
    frameData === 'draws' || frameData === 'copies'
      ? 'enabled'
      : frameData === 'dispatches' && source.kind === 'direct'
        ? 'workgroups'
        : undefined;
  // Avoid allocating Object.keys(source) on every frame. The snapshot keeps
  // the canonical key order, so an own-property count plus direct lookups is
  // equivalent while leaving the hot validation path allocation-free.
  let ownKeyCount = 0;
  for (const key in source) {
    if (key !== payloadKey && Object.hasOwn(source, key)) ownKeyCount += 1;
  }
  if (ownKeyCount !== snapshot.keys.length) return false;
  for (let index = 0; index < snapshot.keys.length; index += 1) {
    const key = snapshot.keys[index] as string;
    if (!Object.hasOwn(source, key)) return false;
    if (
      !equalSignatureNode(source[key], snapshot.values[index] as RenderFeaturePlanSignatureNode)
    ) {
      return false;
    }
  }
  return true;
}

function equalSortedUsage(usage: unknown, snapshot: RenderFeaturePlanSignatureNode): boolean {
  if (
    !Array.isArray(usage) ||
    snapshot.kind !== 'array' ||
    usage.length !== snapshot.values.length
  ) {
    return false;
  }
  // Usage is a short string union. Compare it as a multiset so the check
  // mirrors [...usage].sort() without allocating a sorted copy per frame.
  for (let index = 0; index < snapshot.values.length; index += 1) {
    const expected = snapshot.values[index];
    if (expected === undefined || expected.kind !== 'primitive') return false;
    let expectedCount = 0;
    let currentCount = 0;
    for (let candidate = 0; candidate < snapshot.values.length; candidate += 1) {
      const sibling = snapshot.values[candidate];
      if (
        sibling !== undefined &&
        sibling.kind === 'primitive' &&
        sibling.token === expected.token
      ) {
        expectedCount += 1;
      }
      if (primitiveTokenText(stablePrimitiveToken(usage[candidate], expected)) === expected.token)
        currentCount += 1;
    }
    if (expectedCount !== currentCount) return false;
  }
  return true;
}

function resourceFramePayloadKey(kind: unknown): string | undefined {
  switch (kind) {
    case 'buffer':
      return 'data';
    case 'fullscreen-program':
      return 'frameParams';
    case 'scene-depth':
      return 'camera';
    case 'compute':
    case 'copy':
    case 'raster':
    case 'shadow-caster':
      return 'enabled';
    default:
      return undefined;
  }
}

function equalResourceNode(resource: unknown, snapshot: RenderFeaturePlanSignatureNode): boolean {
  if (
    isOwnedRenderFeatureProgramData(resource) &&
    ownedBufferSignatureNodes.get(resource as object) === snapshot
  )
    return true;
  if (
    resource === null ||
    typeof resource !== 'object' ||
    Array.isArray(resource) ||
    ArrayBuffer.isView(resource) ||
    snapshot.kind !== 'object'
  ) {
    return false;
  }
  const source = resource as Readonly<Record<string, unknown>>;
  const payloadKey = resourceFramePayloadKey(source.kind);
  if (payloadKey === undefined) return equalSignatureNode(source, snapshot);

  // Camera motion and buffer uploads change frame data, not graph topology.
  // Compare the same normalized structure used by resourceTopology without
  // allocating a spread object on every signature admission.
  const snapshotValues = snapshot.values;
  let comparableKeys = 0;
  // Keep this branch allocation-free as well. Buffer declarations are among
  // the most frequently validated resources in a frame.
  function equalResourceField(key: string, snapshotIndex: number): boolean {
    if (source.kind === 'buffer' && key === 'usage') {
      if (
        !equalSortedUsage(
          source[key],
          snapshotValues[snapshotIndex] as RenderFeaturePlanSignatureNode,
        )
      ) {
        return false;
      }
    } else {
      const child = source[key];
      const kind = source.kind;
      const comparableChild =
        kind === 'buffer' && key === 'initialization' && child !== undefined
          ? bufferInitializationTopology(child as RenderFeatureGpuBufferInitialization)
          : child;
      if (
        !equalSignatureNode(
          comparableChild,
          snapshotValues[snapshotIndex] as RenderFeaturePlanSignatureNode,
          kind === 'copy' && key === 'copies'
            ? 'copies'
            : kind === 'compute' && key === 'dispatches'
              ? 'dispatches'
              : (kind === 'raster' || kind === 'shadow-caster') && key === 'draws'
                ? 'draws'
                : false,
        )
      ) {
        return false;
      }
    }
    return true;
  }
  for (const key in source) {
    if (!Object.hasOwn(source, key)) continue;
    if (key === payloadKey || (source.kind === 'buffer' && key === 'uploads')) continue;
    const snapshotIndex = snapshot.keys.indexOf(key);
    if (snapshotIndex < 0) return false;
    comparableKeys += 1;
    if (!equalResourceField(key, snapshotIndex)) return false;
  }
  let expectedComparableKeys = 0;
  for (const key of snapshot.keys) {
    if (key === payloadKey || (source.kind === 'buffer' && key === 'uploads')) continue;
    expectedComparableKeys += 1;
    if (!Object.hasOwn(source, key)) return false;
  }
  if (comparableKeys !== expectedComparableKeys) return false;
  return true;
}

/** Exact structural equality against a detached signature snapshot. */
export function renderFeaturePlanSignatureSnapshotEquals(
  plan: RenderFeatureWorkPlan,
  snapshot: RenderFeaturePlanSignatureSnapshot,
): boolean {
  if (plan.placement !== snapshot.placement || plan.submission !== snapshot.submission)
    return false;
  if (plan.resources.length !== snapshot.resources.length) return false;
  for (let index = 0; index < plan.resources.length; index += 1) {
    if (
      !equalResourceNode(
        plan.resources[index],
        snapshot.resources[index] as RenderFeaturePlanSignatureNode,
      )
    ) {
      return false;
    }
  }
  // The public checker observes the top-level accessor at every original
  // length/item read; only Host capture holds one array for its comparison.
  if (snapshot.passes.kind !== 'array' || plan.passes.length !== snapshot.passes.values.length)
    return false;
  for (let index = 0; index < plan.passes.length; index += 1) {
    const pass = snapshot.passes.values[index];
    if (pass === undefined || !equalResourceNode(plan.passes[index], pass)) return false;
  }
  return true;
}

function equalSignaturePasses(
  passes: readonly RenderFeaturePassDeclaration[],
  snapshot: RenderFeaturePlanSignatureNode,
): boolean {
  if (snapshot.kind !== 'array' || passes.length !== snapshot.values.length) return false;
  for (let index = 0; index < passes.length; index += 1) {
    const pass = snapshot.values[index];
    if (pass === undefined || !equalResourceNode(passes[index], pass)) return false;
  }
  return true;
}

/** Associate a freshly produced plan with detached evidence for later validation. */
export function rememberRenderFeaturePlanSignature(
  plan: RenderFeatureWorkPlan,
  signature: string,
  snapshot: RenderFeaturePlanSignatureSnapshot,
): void {
  signatureEvidenceByPlan.set(plan as object, { signature, snapshot });
}

/**
 * Validate an existing signature without serializing the plan again. A false
 * result means the plan has no evidence or its nested data no longer matches;
 * callers must then run the canonical serializer as the recovery path.
 */
export function renderFeaturePlanSignatureEvidenceMatches(
  plan: RenderFeatureWorkPlan,
  signature: string,
): boolean {
  const evidence = signatureEvidenceByPlan.get(plan as object);
  return (
    evidence !== undefined &&
    evidence.signature === signature &&
    renderFeaturePlanSignatureSnapshotEquals(plan, evidence.snapshot)
  );
}

function stable(value: unknown, metrics?: RenderFeaturePlanSignatureMetrics): string {
  const parts: string[] = [];
  appendStable(value, parts, metrics);
  return parts.join('');
}

function appendStable(
  value: unknown,
  parts: string[],
  metrics?: RenderFeaturePlanSignatureMetrics,
): void {
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (metrics !== undefined) metrics.typedArrayBytes += bytes.byteLength;
    // Keep every byte in the canonical identity. Decimal Array#join creates
    // a number/string conversion and a separator for every byte; bounded hex
    // chunks cut that allocation footprint while remaining deterministic.
    appendByteHex(value, parts);
    return;
  }
  if (Array.isArray(value)) {
    parts.push('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) parts.push(',');
      // Array#join renders holes and an explicit undefined child as an empty
      // field; retain that canonical spelling instead of writing "undefined".
      if (value[index] !== undefined) appendStable(value[index], parts, metrics);
    }
    parts.push(']');
    return;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value as Readonly<Record<string, unknown>>).sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    parts.push('{');
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index] as string;
      if (index > 0) parts.push(',');
      parts.push(JSON.stringify(key), ':');
      appendStable((value as Readonly<Record<string, unknown>>)[key], parts, metrics);
    }
    parts.push('}');
    return;
  }
  parts.push(JSON.stringify(value) ?? 'undefined');
}

function resourceTopology(
  resource: RenderFeatureResourceDeclaration,
  metrics?: RenderFeaturePlanSignatureMetrics,
): unknown {
  if (resource.kind === 'fullscreen-program') return fullscreenProgramTopology(resource);
  if (resource.kind === 'scene-depth') return { ...resource, camera: undefined };
  if (resource.kind === 'buffer') {
    if (metrics !== undefined && resource.data !== undefined) {
      metrics.typedArrayBytes += resource.data.byteLength;
    }
    const { uploads: _uploads, initialization, ...descriptor } = resource;
    return {
      ...descriptor,
      ...(initialization === undefined
        ? {}
        : { initialization: bufferInitializationTopology(initialization) }),
      usage: [...resource.usage].sort(),
      data: undefined,
    };
  }
  if (resource.kind === 'prepared-gpu-resource') {
    const { acquireResidencyLease: _acquireResidencyLease, ...descriptor } = resource;
    return {
      ...descriptor,
      resource:
        resource.resource.kind === 'buffer'
          ? {
              kind: 'buffer',
              size: resource.resource.size,
              usage: [...(resource.resource.usage ?? [])].sort(),
            }
          : { kind: resource.resource.kind },
    };
  }
  return resource;
}

/** Canonical signature used by typed-graph topology and last-known-good swap. */
export function renderFeaturePlanSignature(
  plan: RenderFeatureWorkPlan,
  metrics?: RenderFeaturePlanSignatureMetrics,
): string {
  if (metrics !== undefined) metrics.calls += 1;
  const signature = stable(
    {
      ...(plan.placement === undefined ? {} : { placement: plan.placement }),
      resources: plan.resources.map((resource) => resourceTopology(resource, metrics)),
      ...(plan.submission === undefined ? {} : { submission: plan.submission }),
      passes: plan.passes.map(signaturePassValue),
    },
    metrics,
  );
  if (metrics !== undefined) metrics.outputChars += signature.length;
  return signature;
}

function bindingAccess(type: GPUBufferBindingType | undefined): GraphBufferAccess | undefined {
  switch (type) {
    case 'uniform':
      return 'uniform-read';
    case 'read-only-storage':
      return 'storage-read';
    case 'storage':
      return 'storage-read-write';
    case undefined:
      return undefined;
  }
}

/** Declarations of one plan by name, for deriving the access of several of its passes. */
export function renderFeaturePlanDeclarations(
  plan: RenderFeatureWorkPlan,
): ReadonlyMap<string, RenderFeatureResourceDeclaration> {
  return new Map(plan.resources.map((resource) => [resource.name, resource]));
}

/** Aggregate the owning per-pass derivation for one complete plan. */
export function deriveRenderFeaturePlanAccess(
  plan: RenderFeatureWorkPlan,
): readonly RenderFeatureDerivedAccess[] {
  const declarations = renderFeaturePlanDeclarations(plan);
  return Object.freeze(
    plan.passes.flatMap((pass) => [...deriveRenderFeaturePassAccess(plan, pass, declarations)]),
  );
}

/**
 * Derive graph access from descriptor roles; producers never author a parallel ledger.
 * A caller deriving every pass of one plan passes its declarations once.
 */
export function deriveRenderFeaturePassAccess(
  plan: RenderFeatureWorkPlan,
  pass: RenderFeaturePassDeclaration,
  declarations?: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): readonly RenderFeatureDerivedAccess[] {
  if (pass.kind === 'copy') {
    const accesses: RenderFeatureDerivedAccess[] = [];
    for (const readback of pass.textureReadbacks ?? [])
      accesses.push({ resource: readback.target, usage: 'copy-src' });
    for (const copy of pass.copies) {
      accesses.push(
        { resource: copy.source, usage: 'copy-src' },
        { resource: copy.destination, usage: 'copy-dst' },
      );
    }
    return Object.freeze(accesses);
  }
  // Copy and draw-less raster passes never consult declarations.
  const resources: ReadonlyMap<string, RenderFeatureResourceDeclaration> =
    pass.kind === 'compute' || pass.draws.length > 0
      ? (declarations ?? renderFeaturePlanDeclarations(plan))
      : new Map();
  if (pass.kind === 'compute') {
    return deriveComputePassAccess(resources, pass);
  }

  const accesses: RenderFeatureDerivedAccess[] = [];
  for (const attachment of pass.kind === 'raster' ? pass.colorAttachments : []) {
    accesses.push({ resource: attachment.target, usage: 'color-attachment' });
  }
  if (pass.kind === 'raster' && pass.depthStencilAttachment !== undefined) {
    accesses.push({
      resource: pass.depthStencilAttachment.target,
      usage: pass.sampledTargets?.some(
        (target) => typeof target === 'string' && target === pass.depthStencilAttachment?.target,
      )
        ? 'depth-stencil-read'
        : 'depth-stencil-write',
    });
  }
  for (const target of pass.kind === 'raster' ? (pass.sampledTargets ?? []) : []) {
    if (typeof target !== 'string') continue;
    accesses.push({ resource: target, usage: 'sampled-read' });
  }
  appendGraphicsDrawAccesses(pass, resources, accesses);
  return Object.freeze(accesses);
}

function deriveComputePassAccess(
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
  pass: Extract<RenderFeaturePassDeclaration, { readonly kind: 'compute' }>,
): readonly RenderFeatureDerivedAccess[] {
  const accesses: RenderFeatureDerivedAccess[] = [];
  const program = resources.get(pass.program);
  const bindingNames = new Set([pass.bindings]);
  for (const dispatch of pass.dispatches)
    if (dispatch.bindings !== undefined) bindingNames.add(dispatch.bindings);
  const layoutEntries =
    program?.kind === 'compute-program' ? (program.program.bindings?.[0]?.entries ?? []) : [];
  for (const name of bindingNames) {
    const bindings = resources.get(name);
    if (bindings?.kind === 'compute-bindings') {
      for (const entry of bindings.entries) {
        const usage = bindingAccess(
          layoutEntries.find((candidate) => candidate.binding === entry.binding)?.buffer?.type,
        );
        if (usage !== undefined) accesses.push({ resource: entry.resource, usage });
        const declaration = resources.get(entry.resource);
        if (declaration?.kind === 'texture') {
          const layout = layoutEntries.find((candidate) => candidate.binding === entry.binding);
          const role = layout?.storageTexture?.access;
          accesses.push({
            resource: declaration.name,
            usage:
              role === 'write-only'
                ? 'storage-write'
                : role === 'read-only'
                  ? 'storage-read'
                  : role === 'read-write'
                    ? 'storage-read-write'
                    : 'sampled-read',
          });
        }
        if (
          declaration?.kind === 'prepared-gpu-resource' &&
          declaration.logicalTarget !== undefined
        ) {
          const layout = layoutEntries.find((candidate) => candidate.binding === entry.binding);
          const usage =
            layout?.storageTexture?.access === 'write-only'
              ? 'storage-write'
              : layout?.storageTexture?.access === 'read-only'
                ? 'storage-read'
                : layout?.storageTexture?.access === 'read-write'
                  ? 'sampled-storage-read-write'
                  : 'sampled-read';
          accesses.push({ resource: declaration.logicalTarget, usage });
        }
      }
    }
  }
  for (const dispatch of pass.dispatches) {
    if (dispatch.kind === 'indirect') {
      accesses.push({ resource: dispatch.resource, usage: 'indirect-read' });
    }
  }
  return Object.freeze(accesses);
}

/** Check names, references and logical targets without copying the plan. */
export function validateRenderFeaturePlan(
  identity: string,
  plan: RenderFeatureWorkPlan,
  logicalTargets: readonly RenderFeatureLogicalTarget[] = [],
): Result<void, RenderError> {
  if (
    (plan.submission !== undefined && plan.submission !== 'atomic') ||
    (plan.placement !== undefined &&
      !['scene', 'after-depth', 'after-tonemap', 'post'].includes(plan.placement))
  )
    return err(stageFailure(identity));
  if (plan.resources.length === 0 && plan.passes.length === 0) return ok(undefined);
  const resources = new Map<string, RenderFeatureResourceDeclaration>();
  const targets = new Set(['swapchain', ...logicalTargets.map((target) => target.name)]);
  for (const resource of plan.resources) {
    if (!validPlanResource(resource, resources, targets)) return err(stageFailure(identity));
    resources.set(resource.name, resource);
  }
  const passes = new Set<string>();
  for (const pass of plan.passes) {
    if (
      !validName(pass.name) ||
      (pass.temporal !== undefined &&
        (!validRenderFeatureTemporalStage(pass.temporal) ||
          (pass.kind !== 'compute' && pass.kind !== 'copy'))) ||
      passes.has(pass.name) ||
      (pass.enabled !== undefined && typeof pass.enabled !== 'boolean')
    )
      return err(stageFailure(identity));
    passes.add(pass.name);
    if (!validPlanPass(pass, resources, targets)) return err(stageFailure(identity));
  }
  return ok(undefined);
}

/** Is this resource uniquely named and are its camera and logical target well-formed? */
function validPlanResource(
  resource: RenderFeatureResourceDeclaration,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
  targets: ReadonlySet<string>,
): boolean {
  if (!validName(resource.name) || resources.has(resource.name)) return false;
  if (resource.kind === 'fullscreen-program' && !validFullscreenProgramResource(resource))
    return false;
  if (
    resource.kind === 'feature-texture-reference' &&
    !isRenderFeatureTextureSource(resource.source)
  )
    return false;
  if (resource.kind === 'texture' && !validFeatureTexture(resource)) return false;
  if (resource.kind === 'graphics-bindings' && !validGraphicsBufferSlots(resource, resources))
    return false;
  if (resource.kind === 'scene-depth' && !validSceneDepthCamera(resource.camera)) return false;
  if (resource.kind === 'graph-texture' && !validGraphTextureResource(resource)) return false;
  return (
    resource.kind !== 'prepared-gpu-resource' ||
    resource.logicalTarget === undefined ||
    (typeof resource.logicalTarget === 'string'
      ? targets.has(resource.logicalTarget)
      : isSceneDataTarget(resource.logicalTarget) ||
        isRenderFeatureTextureReference(resource.logicalTarget))
  );
}

function validFullscreenProgramResource(
  resource: RenderFeatureFullscreenProgramDeclaration,
): boolean {
  if (resource.chain !== undefined && resource.chain !== true) return false;
  return (
    resource.frameParams === undefined ||
    (resource.chain === true &&
      resource.frameParams instanceof Uint8Array &&
      resource.frameParams.byteLength === resource.params?.byteSize)
  );
}

function validSceneDepthCamera(
  camera: Extract<RenderFeatureResourceDeclaration, { readonly kind: 'scene-depth' }>['camera'],
): boolean {
  return ![
    [camera.position, 3],
    [camera.right, 3],
    [camera.up, 3],
    [camera.viewProjection, 16],
  ].some(
    ([data, length]) =>
      !(data instanceof Float32Array) || data.length !== length || !data.every(Number.isFinite),
  );
}

function validPlanPass(
  pass: RenderFeaturePassDeclaration,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
  targets: ReadonlySet<string>,
): boolean {
  if (pass.kind === 'copy') return validCopyPass(pass, resources);
  if (pass.kind === 'compute') return validComputePass(pass, resources);
  return validDrawPass(pass, resources, targets);
}

function validCopyPass(
  pass: Extract<RenderFeaturePassDeclaration, { readonly kind: 'copy' }>,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): boolean {
  if (pass.copies.length === 0 && (pass.textureReadbacks?.length ?? 0) === 0) return false;
  const readbackNames = new Set<string>();
  for (const readback of pass.textureReadbacks ?? []) {
    if (!validTextureReadbackDeclaration(readback, resources, readbackNames)) return false;
    readbackNames.add(readback.name);
  }
  for (const copy of pass.copies) {
    if (!validBufferCopyDeclaration(copy, resources)) return false;
  }
  return true;
}

/** Does a 4-byte-aligned copy of `size` bytes at `offset` fit the buffer? */
function validCopyRange(size: number, offset: number, bufferSize: number): boolean {
  return (
    Number.isSafeInteger(offset) && offset >= 0 && offset % 4 === 0 && size <= bufferSize - offset
  );
}

function validComputePass(
  pass: Extract<RenderFeaturePassDeclaration, { readonly kind: 'compute' }>,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): boolean {
  const program = resources.get(pass.program);
  const bindings = resources.get(pass.bindings);
  if (
    program?.kind !== 'compute-program' ||
    bindings?.kind !== 'compute-bindings' ||
    bindings.program !== pass.program ||
    pass.dispatches.length === 0
  ) {
    return false;
  }
  const entryPoints = new Set(program.program.entryPoints);
  const validated = new Set<object>();
  const immutableProgram = isOwnedRenderFeatureProgramData(program.program);
  const validateBindings = (
    candidate: Extract<RenderFeatureResourceDeclaration, { readonly kind: 'compute-bindings' }>,
  ): boolean => {
    if (immutableProgram && validated.has(candidate)) return true;
    if (!validComputeBindingEntries(candidate, program, resources)) return false;
    if (immutableProgram && isOwnedRenderFeatureProgramData(candidate)) validated.add(candidate);
    return true;
  };
  if (!validateBindings(bindings)) return false;
  for (const dispatch of pass.dispatches) {
    if (!entryPoints.has(dispatch.entryPoint)) return false;
    const override = dispatch.bindings;
    if (override !== undefined) {
      const binding = resources.get(override);
      if (
        binding?.kind !== 'compute-bindings' ||
        binding.program !== pass.program ||
        !validateBindings(binding)
      )
        return false;
    }
    if (!validDispatchSource(dispatch, resources)) return false;
  }
  return true;
}

/** Does every binding entry name a resource whose kind matches its layout slot? */
function validComputeBindingEntries(
  bindings: Extract<RenderFeatureResourceDeclaration, { readonly kind: 'compute-bindings' }>,
  program: Extract<RenderFeatureResourceDeclaration, { readonly kind: 'compute-program' }>,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): boolean {
  for (const entry of bindings.entries) {
    const layout = program.program.bindings?.[0]?.entries.find(
      (candidate) => candidate.binding === entry.binding,
    );
    if (!computeBindingMatchesLayout(resources.get(entry.resource), layout)) return false;
  }
  return true;
}

function computeBindingMatchesLayout(
  resource: RenderFeatureResourceDeclaration | undefined,
  layout: BindGroupLayoutEntry | undefined,
): boolean {
  const validBuffer = resource?.kind === 'buffer' && layout?.buffer !== undefined;
  const validPrepared = preparedComputeBindingMatches(resource, layout);
  const validSceneInput =
    (resource?.kind === 'scene-depth' && layout?.texture?.sampleType === 'depth') ||
    (resource?.kind === 'scene-noise' && layout?.texture !== undefined) ||
    (resource?.kind === 'scene-sdf' && layout?.buffer?.type === 'read-only-storage');
  const validFeatureReference =
    resource?.kind === 'feature-texture-reference' && layout?.texture !== undefined;
  const validOwnedTexture = ownedComputeTextureMatches(resource, layout);
  const validOwnedSampler = resource?.kind === 'sampler' && layout?.sampler !== undefined;
  const validAlias =
    resource?.kind === 'texture-alias' &&
    (layout?.texture !== undefined || layout?.storageTexture !== undefined);
  return (
    validBuffer ||
    validPrepared ||
    validSceneInput ||
    validFeatureReference ||
    validOwnedTexture ||
    validOwnedSampler ||
    validAlias
  );
}

/** Are direct workgroups valid, or does an indirect dispatch name an aligned indirect buffer? */
function validDispatchSource(
  dispatch: RenderFeatureDispatch,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): boolean {
  if (dispatch.kind === 'direct') return validRenderFeatureWorkgroups(dispatch.workgroups);
  const buffer = resources.get(dispatch.resource);
  return (
    buffer?.kind === 'buffer' &&
    buffer.usage.includes('indirect') &&
    Number.isInteger(dispatch.offset) &&
    dispatch.offset >= 0 &&
    dispatch.offset % 4 === 0
  );
}

function validDrawPass(
  pass: Extract<RenderFeaturePassDeclaration, { readonly kind: 'raster' | 'shadow-caster' }>,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
  targets: ReadonlySet<string>,
): boolean {
  if (
    pass.draws.length === 0 &&
    (pass.kind !== 'raster' ||
      pass.sampledTargets?.some((sampled) =>
        pass.colorAttachments.some((attachment) => attachment.target === sampled),
      ) === true ||
      (!pass.colorAttachments.some((attachment) => attachment.loadOp === 'clear') &&
        pass.depthStencilAttachment?.depthLoadOp !== 'clear'))
  )
    return false;
  if (pass.kind === 'raster' && !rasterTargetsDeclared(pass, targets)) return false;
  for (const draw of pass.draws) {
    if (!validDrawDeclaration(draw, pass.kind, resources)) return false;
  }
  return true;
}

function rasterTargetsDeclared(
  pass: Extract<RenderFeaturePassDeclaration, { readonly kind: 'raster' }>,
  targets: ReadonlySet<string>,
): boolean {
  return !(
    pass.colorAttachments.some((attachment) => !targets.has(attachment.target)) ||
    (pass.depthStencilAttachment !== undefined &&
      !targets.has(pass.depthStencilAttachment.target)) ||
    pass.sampledTargets?.some((target) => typeof target === 'string' && !targets.has(target)) ===
      true
  );
}

function validDrawDeclaration(
  draw: RenderFeatureDrawDeclaration,
  passKind: 'raster' | 'shadow-caster',
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): boolean {
  const program = resources.get(draw.program);
  return !(
    program?.kind !== 'graphics-program' ||
    (draw.enabled !== undefined && typeof draw.enabled !== 'boolean') ||
    (passKind === 'shadow-caster' &&
      (program.program.colorFormats.length !== 0 ||
        program.program.depthFormat !== 'depth32float')) ||
    draw.bindings.some((name) => {
      const binding = resources.get(name);
      return binding?.kind !== 'graphics-bindings' || binding.program !== draw.program;
    }) ||
    draw.vertexData.some((binding) => resources.get(binding.resource)?.kind !== 'vertex-data') ||
    (draw.indexData !== undefined &&
      resources.get(draw.indexData.resource)?.kind !== 'index-data') ||
    !validIndirectDrawSource(draw.draw, resources)
  );
}

function validIndirectDrawSource(
  draw: RenderFeatureDraw,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): boolean {
  if (draw.kind !== 'draw-indirect' && draw.kind !== 'draw-indexed-indirect') return true;
  const buffer = resources.get(draw.resource);
  return buffer?.kind === 'buffer' && buffer.usage.includes('indirect');
}

function validGraphicsBufferSlots(
  resource: Extract<RenderFeatureResourceDeclaration, { kind: 'graphics-bindings' }>,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): boolean {
  if (resource.values.bufferBindings === undefined) return true;
  const bindings = resource.values.bufferBindings;
  if (!Array.isArray(bindings)) return false;
  const slots = new Set<number>();
  for (const value of bindings) {
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      ArrayBuffer.isView(value) ||
      typeof value.binding !== 'number' ||
      !Number.isInteger(value.binding) ||
      value.binding < 0 ||
      slots.has(value.binding) ||
      typeof value.resource !== 'string' ||
      resources.get(value.resource)?.kind !== 'buffer' ||
      (value.access !== 'read' && value.access !== 'read-write')
    )
      return false;
    slots.add(value.binding);
  }
  return true;
}
function validGraphTextureResource(
  resource: Extract<RenderFeatureResourceDeclaration, { kind: 'graph-texture' }>,
): boolean {
  const { descriptor } = resource;
  if (
    !validName(resource.allocationKey) ||
    !Number.isInteger(descriptor.size.width) ||
    descriptor.size.width <= 0 ||
    !Number.isInteger(descriptor.size.height) ||
    descriptor.size.height <= 0 ||
    !Number.isInteger(descriptor.size.depthOrArrayLayers) ||
    descriptor.size.depthOrArrayLayers <= 0 ||
    (descriptor.sampleCount !== undefined &&
      descriptor.sampleCount !== 1 &&
      descriptor.sampleCount !== 4) ||
    !validGraphTextureArrayView(resource)
  )
    return false;
  return true;
}

function validGraphTextureArrayView(
  resource: Extract<RenderFeatureResourceDeclaration, { kind: 'graph-texture' }>,
): boolean {
  const { descriptor } = resource;
  return !(
    (resource.view?.baseArrayLayer !== undefined &&
      (!Number.isInteger(resource.view.baseArrayLayer) ||
        resource.view.baseArrayLayer < 0 ||
        resource.view.baseArrayLayer >= descriptor.size.depthOrArrayLayers)) ||
    (resource.view?.arrayLayerCount !== undefined &&
      (!Number.isInteger(resource.view.arrayLayerCount) ||
        resource.view.arrayLayerCount < 1 ||
        (resource.view.baseArrayLayer ?? 0) + resource.view.arrayLayerCount >
          descriptor.size.depthOrArrayLayers)) ||
    (resource.view?.arrayLayerCount !== undefined &&
      resource.view.arrayLayerCount > 1 &&
      resource.view.dimension !== '2d-array') ||
    (resource.view?.dimension === '2d-array' && descriptor.size.depthOrArrayLayers < 1)
  );
}

function validTextureReadbackDeclaration(
  readback: NonNullable<
    Extract<RenderFeaturePassDeclaration, { kind: 'copy' }>['textureReadbacks']
  >[number],
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
  readbackNames: ReadonlySet<string>,
): boolean {
  const target = resources.get(readback.target);
  if (
    !validName(readback.name) ||
    readbackNames.has(readback.name) ||
    target?.kind !== 'graph-texture' ||
    target.descriptor.sampleCount !== 1 ||
    target.descriptor.size.depthOrArrayLayers !== 1 ||
    !['r32float', 'rgba16float', 'rgba32float', 'rgba8unorm'].includes(target.descriptor.format)
  )
    return false;
  return true;
}

function retainedPrimitiveToken(
  value: unknown,
  previous: Extract<RenderFeaturePlanSignatureNode, { kind: 'primitive' }> | undefined,
): string | undefined {
  if (typeof value === 'number' && previous?.numberValue !== undefined) {
    const previousNumber = previous.numberValue;
    if (value === previousNumber || (Number.isNaN(value) && Number.isNaN(previousNumber)))
      return previous.token;
  }
  if (typeof value === 'boolean' && previous?.token === (value ? 'true' : 'false'))
    return previous.token;
  if (value === null && previous?.token === 'null') return previous.token;
  if (value === undefined && previous?.token === 'undefined') return previous.token;
  return undefined;
}

function validBufferCopyDeclaration(
  copy: Extract<RenderFeaturePassDeclaration, { kind: 'copy' }>['copies'][number],
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
): boolean {
  const source = declaredCopyBuffer(resources.get(copy.source)),
    destination = declaredCopyBuffer(resources.get(copy.destination));
  if (
    source === undefined ||
    destination === undefined ||
    (copy.enabled !== undefined && typeof copy.enabled !== 'boolean') ||
    copy.source === copy.destination ||
    !source.usage?.includes('copy-src') ||
    !Number.isSafeInteger(copy.size) ||
    copy.size <= 0 ||
    copy.size % 4 !== 0 ||
    !validCopyRange(copy.size, copy.sourceOffset ?? 0, source.size) ||
    !validCopyRange(copy.size, copy.destinationOffset ?? 0, destination.size)
  )
    return false;
  return true;
}

function appendGraphicsDrawAccesses(
  pass: Extract<RenderFeaturePassDeclaration, { kind: 'raster' | 'shadow-caster' }>,
  resources: ReadonlyMap<string, RenderFeatureResourceDeclaration>,
  accesses: RenderFeatureDerivedAccess[],
): void {
  for (const draw of pass.draws) {
    for (const bindingName of draw.bindings) {
      const binding = resources.get(bindingName);
      if (binding?.kind !== 'graphics-bindings') continue;
      for (const buffer of (binding.values.bufferBindings ??
        []) as unknown as readonly import('./prepared-graphics').RenderFeatureGraphicsStorageBinding[])
        accesses.push({
          resource: buffer.resource,
          usage: buffer.access === 'read' ? 'storage-read' : 'storage-read-write',
        });
    }
    for (const vertex of draw.vertexData) {
      const declaration = resources.get(vertex.resource);
      accesses.push({
        resource:
          declaration?.kind === 'vertex-data' && declaration.buffer !== undefined
            ? declaration.buffer
            : vertex.resource,
        usage: 'vertex-read',
      });
    }
    if (draw.indexData !== undefined) {
      const declaration = resources.get(draw.indexData.resource);
      accesses.push({
        resource:
          declaration?.kind === 'index-data' && declaration.buffer !== undefined
            ? declaration.buffer
            : draw.indexData.resource,
        usage: 'index-read',
      });
    }
    if (draw.draw.kind === 'draw-indirect' || draw.draw.kind === 'draw-indexed-indirect') {
      accesses.push({ resource: draw.draw.resource, usage: 'indirect-read' });
    }
  }
}

function preparedComputeBindingMatches(
  resource: RenderFeatureResourceDeclaration | undefined,
  layout: BindGroupLayoutEntry | undefined,
): boolean {
  return (
    resource?.kind === 'prepared-gpu-resource' &&
    ((resource.resource.kind === 'buffer' && layout?.buffer !== undefined) ||
      (resource.resource.kind === 'texture-view' &&
        (layout?.texture !== undefined || layout?.storageTexture !== undefined)) ||
      (resource.resource.kind === 'sampler' && layout?.sampler !== undefined))
  );
}

function ownedComputeTextureMatches(
  resource: RenderFeatureResourceDeclaration | undefined,
  layout: BindGroupLayoutEntry | undefined,
): boolean {
  return (
    resource?.kind === 'texture' &&
    ((layout?.texture !== undefined && resource.usage.includes('sampled')) ||
      (layout?.storageTexture !== undefined && resource.usage.includes('storage')))
  );
}
