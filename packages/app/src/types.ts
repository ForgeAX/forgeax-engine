// App contracts for explicit host assembly and browser construction.
//
// AI users: see packages/app/src/index.ts for the public surface and
// packages/app/src/create-app.ts for the runtime implementation.
//
// M1 (this milestone) ships the skeleton: interfaces are final-shape, but
// start / stop / pause / resume / onError on the returned App are stubs
// that return Result.ok(undefined) and a no-op unsubscribe. The rAF main
// loop, dt clamp, error fan-out, and input attach internals land in
// later milestones (M2..M5 per plan-strategy section 7).

import type { AnimationPlaybackOptions } from '@forgeax/engine-animation';
import type { AssetRegistry, CatalogSource } from '@forgeax/engine-assets-runtime';
import type { AudioBackend } from '@forgeax/engine-audio';
import type { DebugDraw } from '@forgeax/engine-debug-draw';
import type { TimePolicy, World } from '@forgeax/engine-ecs';
import type { ActionConfig, InputBackend } from '@forgeax/engine-input';
import type { PhysicsWorld, PhysicsWorld2D } from '@forgeax/engine-physics';
import type { Platform } from '@forgeax/engine-platform';
import type { Context, Plugin, PluginPrograms } from '@forgeax/engine-plugin';
import type { Profiler } from '@forgeax/engine-profiler';
import type {
  GpuPassTimingOptions,
  OutputColorSpace,
  RenderError,
  Renderer,
  RenderFeature,
  RenderProfile,
  SsrAdmissionIdentity,
} from '@forgeax/engine-render';
import type { RhiBackendInstrumentation } from '@forgeax/engine-render/internal/construct-renderer';
import type { RhiError, RhiInstance } from '@forgeax/engine-rhi';
import type { EngineEnvironmentError } from '@forgeax/engine-runtime';
import type {
  AssetDecoderContributionRef,
  Result,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';

import type { AssetRuntimeAssemblyError } from './assets-runtime-assembly';
import type { AppError, AppErrorCode } from './errors';
import type { ExecutionControl, ExecutionOptions } from './execution';
import type { InputAttachOptions } from './internal/input-attach';
import type { RhiCapture } from './internal/rhi-capture';
import type { AppObservation } from './observation';
import type { RuntimePackOptions } from './runtime-packs.js';

// Re-export AppError + AppErrorCode (the canonical SSOT lives in
// `./errors`). Pre-M5 (M1..M4) referenced these as type-only declarations
// inside this file; M5 collapses to the single SSOT in `./errors.ts` per
// plan-strategy section 7 + research section 2.7.
export type { AppError, AppErrorCode };

/**
 * Structured error union surfaced through the App `onError` fan-out + the
 * assemble-form construction Result. Derived from the `Renderer.onError`
 * channel contract `RendererError` (feat-20260704-runtime-tier1-decomposition
 * M2 / w14 / D-4) so a runtime-layer error fanned out by the renderer (e.g.
 * `'equirect-projection-failed'`) reaches host App listeners verbatim, plus the
 * App-layer `AppError`. `RendererError` = `RhiError | RenderError |
 * AssetRuntimeError | SkinError | PostProcessError`, so this equals the
 * pre-decomposition `AppError | RhiError | RuntimeError | PostProcessError`
 * exactly (RuntimeError was RenderError | AssetRuntimeError | SkinError). AI
 * users `switch (err.code)` over the union: the disjoint `AppErrorCode` /
 * `RhiErrorCode` / per-cluster `*ErrorCode` / `PostProcessErrorCode` literal
 * sets let TS narrow each arm to the concrete class.
 */
export type AppDispatchError = AppError | RenderError;

/**
 * Per-frame draw description pulled from the host each frame
 * (feat-20260709-editor-world-partition-editorworld-super-composite / M2 / D-3).
 *
 *   - `worlds`       — the exact world list to render this frame, in draw order.
 *   - `cameraOwner`  — index into `worlds` whose cameras drive the frame.
 *   - `resourceOwner`— index into `worlds` whose singleton render resources
 *                      (skylight / skybox / postProcessParams) drive the frame.
 *
 * The two owners are independent (M1 owner-split): an editor can render a scene
 * world's geometry through an editor world's camera while sourcing lighting from
 * a third. `cameraOwner === resourceOwner` is the single-owner degenerate case.
 *
 * @see {@link DrawSource}
 */
export interface DrawSourceResult {
  readonly worlds: readonly World[];
  readonly cameraOwner: number;
  readonly resourceOwner: number;
}

/**
 * Stable frame-loop phase vocabulary for opt-in performance diagnostics.
 *
 * Local and Worker execution record these phases through the same optional
 * Profiler capability. When omitted, the frame loop keeps its normal path and
 * does not allocate capture records.
 */
export const APP_PHASE_CATALOG = [
  'frame-total',
  'draw-source',
  'world-update-primary',
  'world-update-injected',
  'renderer-draw',
  'host-frame',
  'engine-update',
  'kernel-wait',
  'host-audio',
] as const;

/**
 * Optional per-frame draw-source injection seam
 * (feat-20260709-editor-world-partition-editorworld-super-composite / M2 / D-3).
 *
 * The frame-loop invokes this callback once per frame (a "pull"). It lets a host
 * (e.g. the editor) decide, each frame, WHICH worlds to render and which owner
 * indices to use — without the engine knowing anything about editor world
 * partitioning.
 *
 *   - Returns `undefined` → the frame-loop degrades to the single-world path,
 *     byte-identical to `renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 })` where `world` is
 *     the App's own world (the single-world AI-user default). A host that wires
 *     the seam but has nothing multi-world to inject this frame returns
 *     `undefined`.
 *   - Returns `null` -> no scene is admitted. The Renderer presents its configured
 *     screen UI with a pending receipt while the primary World keeps updating.
 *   - Returns a {@link DrawSourceResult} → the frame-loop runs `world.update(1 / 60).unwrap()`
 *     on EVERY returned world (so transform propagation writes each world's
 *     derived `GlobalTransform.world` mat4 before extract reads it — no stale matrix),
 *     then calls `renderer.draw(worlds, { cameraOwner, resourceOwner })`.
 *
 * When omitted entirely, the App never consults a seam and always renders its
 * own single world (legacy behaviour unchanged).
 */
export type DrawSource = () => DrawSourceResult | null | undefined;

/**
 * Options for createApp({ platform, renderer, world, ... }).
 *
 * Field semantics (final shape -- runtime use lands in M2..M5):
 *   - renderer: caller-owned Renderer (host already invoked createRenderer).
 *   - world:    caller-owned World (host already invoked new World()).
 *   - input:    InputBackend handle the host-side attached. When omitted the
 *               assemble entry skips input attach (caller manages input).
 *   - silenceUnhandledErrors: when true, suppresses the console.error
 *               fallback inside the error fan-out (M4).
 */
export interface AppAssembleArgs {
  /** Borrowed native host. App releases its frame and event leases, not this host. */
  readonly platform: Platform;
  readonly renderer: Renderer;
  /** Host-owned asset catalogue paired with the renderer construction. */
  readonly assets?: AssetRegistry;
  /** Explicit catalog projection for this Registry. */
  readonly assetCatalog?: CatalogSource;
  /** Explicit owner decoder contributions; no app-side decoder discovery is performed. */
  readonly assetDecoders?: readonly AssetDecoderContributionRef[];
  /** Program definitions owned by this realm's existing asset provider. */
  readonly pluginPrograms?: PluginPrograms;
  /** Opt-in producer; construct realm-bound hosts/imports inside an execution bootstrap when used. */
  readonly runtimePacks?: RuntimePackOptions;
  /** Optional runtime scope that supplies the catalog URL and generation fence. */
  readonly assetRuntimeBinding?: RuntimeAssetBinding;
  readonly world: World;
  /** Unified plugin list (M1 feat-20260623-plugin-system-unify-build-world-protocol). */
  readonly plugins?: readonly Plugin[];
  readonly silenceUnhandledErrors?: boolean;
  /**
   * Per-frame draw-source injection seam (M2 / D-3). When supplied, the
   * frame-loop pulls it each frame to decide which worlds to render + which
   * owner indices to use; when omitted the App renders its own single world
   * (legacy behaviour). See {@link DrawSource}.
   */
  readonly drawSource?: DrawSource;
  /** Explicit profiler capability shared by the host and renderer. */
  readonly profiler?: Profiler;
  /** Host recorder capability paired with the supplied renderer's instrumentation. */
  readonly rhiCapture?: RhiCapture;
  /** Same receipt projection used by the browser Host startup owner. */
  readonly onFrameSubmitted?: import('./app-assembly').BuildAppArgs['onFrameSubmitted'];
  readonly onFrameCompleted?: import('./app-assembly').BuildAppArgs['onFrameCompleted'];
}

/** Effective physical canvas size transported to an Engine Worker frame. */
export interface CanvasDrawingBufferSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Options for createApp(canvas, opts?, bundler?) from @forgeax/engine/app/browser.
 *
 * feat-20260608-create-app-param-surface-trim / M2 / D-3: self-describing
 * surface -- no longer `extends RendererOptions`. The 7 app-only fields
 * (input / audio / physics / silenceUnhandledErrors) plus the RHI escape-hatch
 * field (rhi) are
 * listed inline, so IDE autocomplete shows AI users a clean surface
 * without inheriting now-disallowed slots like clearColor (M1, on Camera)
 * and shaderManifestUrl (M2, on BundlerOptions / 3rd arg). The escape
 * hatches stay discoverable for the RHI debugging path (charter P1 -- not
 * default noise, but reachable when the AI user scrolls the type).
 */
export interface CreateAppOptions extends InputAttachOptions {
  /** Host facts and scheduling for local execution. */
  readonly platform?: Platform;
  /** Opt into realm-local engine execution. Omission preserves the existing local assembly path. */
  readonly execution?: ExecutionOptions;
  /**
   * Replace WebGPU with the no-op `installWebGpuStub` in the main realm and every
   * execution Worker realm. The Engine keeps its WebGPU path and the profile's
   * caps without GPU work, validation or readback contents; CPU diagnostics only.
   */
  readonly gpuStub?: import('@forgeax/engine-rhi-webgpu').WebGpuStubProfile;
  /** One realm-owned Registry; omitted reuses the Registry created by createRenderer. */
  readonly assets?: AssetRegistry;
  /** Explicit catalog projection for this Registry. */
  readonly assetCatalog?: CatalogSource;
  /** Explicit owner decoder contributions; no app-side decoder discovery is performed. */
  readonly assetDecoders?: readonly AssetDecoderContributionRef[];
  /** Program definitions owned by this realm's existing asset provider. */
  readonly pluginPrograms?: PluginPrograms;
  /** Opt-in producer; construct realm-bound hosts/imports inside an execution bootstrap when used. */
  readonly runtimePacks?: RuntimePackOptions;
  /** Optional runtime scope that supplies the catalog URL and generation fence. */
  readonly assetRuntimeBinding?: RuntimeAssetBinding;
  /** Producer-owned render features forwarded to the renderer unchanged. */
  readonly features?: readonly RenderFeature<unknown>[];
  /** Standard profile forwarded to the single renderer-owned pipeline. */
  readonly standardProfile?: RenderProfile;
  /**
   * Display output color space (default `'srgb'`). `'display-p3'` falls back to sRGB with a
   * structured report in `renderer.inspect().output.colorSpace` when the canvas cannot present it.
   */
  readonly outputColorSpace?: OutputColorSpace;
  /** Captured exact pipeline recipes, prepared before renderer initialization completes. */
  readonly pipelineLibrary?: import('@forgeax/engine-rhi').PipelineLibraryManifest;
  /**
   * Captured recipes compiled after first renderer readiness without blocking it, in a
   * bounded window. Observe `renderer.inspect().pipelineLibrary.backgroundWarmup`;
   * a failure never fails the App and affected pipelines compile on first use.
   */
  readonly backgroundPipelineLibrary?: import('@forgeax/engine-rhi').PipelineLibraryManifest;
  /** Renderer-owned retained dynamic mesh budget; default 64 MiB, maximum 512 MiB. */
  readonly dynamicGeometryMeshBudgetBytes?: number;
  /**
   * Content byte budget of each Engine-created AssetRegistry serving the App World
   * (meshes, textures and other runtime records). Positive safe integer; default 4 GiB.
   * It guards against runaway growth; raise it for scenes with more resident content.
   */
  readonly assetBudgetBytes?: number;
  /** Optional bounded Render-owned GPU pass facts; this is not frame latency. */
  readonly gpuPassTiming?: GpuPassTimingOptions;
  /** Default-off receipt-owned CPU shadow workload, without additional GPU operations. */
  readonly shadowWorkload?: boolean;
  /** Exact source/tree/lock/build identity binding for the renderer-owned SSR seam. */
  readonly ssrIdentity?: SsrAdmissionIdentity;
  /** Explicit Render-owned full-frame reflection pixel readback for diagnostics. */
  readonly captureReflectionFallbackReadback?: boolean;
  /** Unified plugin list (M1 feat-20260623-plugin-system-unify-build-world-protocol). */
  readonly plugins?: readonly Plugin[];
  /** Existing Cordis root supplied by a generic host plugin. */
  readonly context?: Context;
  /**
   * A host-owned input backend for this canvas. When supplied, createApp inserts
   * it into the World instead of attaching a second browser listener set. The
   * host retains its lifecycle; this app only consumes snapshots from the view.
   */
  readonly input?: InputBackend;
  /**
   * World-owned time policy supplied to the canvas-form World constructor.
   * Assemble-form callers retain their pre-existing World policy.
   */
  readonly time?: TimePolicy;
  /** Animation-owned cadence forwarded to the local or Engine Worker assembly. */
  readonly animation?: AnimationPlaybackOptions;
  /**
   * When true, suppresses the console.error fallback inside the error
   * fan-out for hosts that prefer total silence (M4 default: false).
   */
  readonly silenceUnhandledErrors?: boolean;
  /**
   * RHI escape hatch -- forwarded verbatim to createRenderer. Same semantics
   * as `RendererOptions.rhi` (the createRenderer third-party-RHI-instance
   * injection point). Use only for testing / pinning a specific backend /
   * advanced AI users that ship their own RhiInstance shim.
   */
  readonly rhi?: RhiInstance | undefined;
  /** Optional host-owned RHI lifecycle instrumentation, such as recording. */
  readonly rhiInstrumentation?: RhiBackendInstrumentation;
  /**
   * Action mapping configuration (M1: action semantic abstraction layer).
   *
   * Declares named actions (e.g. 'jump', 'moveRight') bound to raw input sources
   * (key, mouseButton, gamepadButton, gamepadAxis). The engine derives per-frame
   * action states via `deriveActionStates()` and exposes them via
   * `snap.action(name).isPressed()`. Duplicate action names follow last-wins
   * semantics (D-8).
   *
   * This is canvas-form only. Assemble-form hosts insert the
   * `INPUT_MAP_KEY` Resource directly.
   */
  readonly inputMap?: readonly ActionConfig[] | undefined;
  /**
   * Per-frame draw-source injection seam (M2 / D-3). When supplied, the
   * frame-loop pulls it each frame to decide which worlds to render + which
   * owner indices to use; when omitted the canvas-form App renders its own
   * single world (legacy behaviour unchanged). See {@link DrawSource}.
   */
  readonly drawSource?: DrawSource;
  /** Explicit profiler capability shared by the host and renderer. */
  readonly profiler?: Profiler;
}

export type { BundlerOptions } from '@forgeax/engine-render/internal/construct-renderer';

/**
 * App handle returned by createApp(...). Host owns the lifecycle and
 * interacts with the rAF loop through start / stop / pause / resume +
 * the structured error fan-out via onError.
 *
 * M1 skeleton: start / stop / pause / resume return Result.ok(undefined)
 * synchronously and onError returns a no-op unsubscribe. The 4-state
 * machine + idempotent transitions land in M2 (plan-strategy section 7).
 */
export interface App {
  /** Caller-owned Renderer (reference equality with the assemble input). */
  readonly renderer: Renderer;
  /** Host-owned AssetRegistry paired with this App realm, when available. */
  readonly assets?: AssetRegistry;
  /** Caller-owned World (reference equality with the assemble input). */
  readonly world: World;
  /** Host-side lifecycle and immutable diagnostics for the selected execution tier. */
  readonly execution: ExecutionControl;
  readonly observation?: AppObservation;
  /**
   * Pause frame submission and relinquish the renderer presentation surface
   * without replacing World, Renderer, AssetRegistry, plugins, or history.
   */
  releaseSurfacePreserveWorld(): Promise<Result<void, RhiError | RenderError>>;
  /** Restore the same surface and resume only when release paused a running App. */
  restoreSurface(): Promise<Result<void, RhiError | RenderError>>;
  /** Native Cordis realm that owns this App's capability fibers and effects. */
  readonly pluginContext: Context;
  /** InputBackend handle when input attach is enabled; undefined otherwise. */
  readonly input?: InputBackend;
  /** AudioBackend handle when audio attach is enabled; undefined otherwise. */
  readonly audio?: AudioBackend;
  /**
   * PhysicsWorld handle when a physics backend plugin is active; undefined
   * otherwise. Plugin activation awaits WASM initialization -- createApp
   * resolves ONLY after the WASM module is loaded, so this field is
   * populated immediately when createApp returns (AC-06: no timing gap).
   */
  readonly physics?: PhysicsWorld | PhysicsWorld2D | undefined;
  /**
   * Immediate-mode debug-draw overlay instance (feat-20260615 debug-draw M5).
   *
   * Created automatically during createApp (canvas form). AI users call
   * `app.debugDraw.line(a, b, RED)` in any system and the overlay renders
   * at frame-end via the render-graph's debug-overlay pass. Shape calls are
   * immediate-mode — vertices accumulate per-frame and are flushed at the
   * tonemap suffix; stale data from frame N-1 is never visible in frame N.
   *
   * Undefined when debug-draw is not wired (assemble-form createApp with
   * no explicit debugDraw creation — the auto-attach is canvas-form only).
   */
  readonly debugDraw?: DebugDraw | undefined;
  /**
   * Begin host frame scheduling:
   *   - first call: Result.ok(undefined)
   *   - second call (already running): Result.err({ code: 'app-already-running' })
   */
  start(): Result<void, AppError>;
  /**
   * Stop host frame scheduling:
   *   - 'idle' / 'stopped' state: Result.err({ code: 'app-not-started' })
   *   - 'running' / 'paused' state: Result.ok(undefined)
   */
  stop(): Result<void, AppError>;
  /** Tear down plugins, host resources, and renderer ownership. */
  dispose(): Promise<Result<void, AppError>>;
  /**
   * Pause rAF scheduling. Idempotent in 'paused' state. M1 stub returns
   * Result.ok(undefined) unconditionally; full state machine in M2.
   */
  pause(): Result<void, AppError>;
  /**
   * Resume rAF scheduling from paused state. M1 stub returns
   * Result.ok(undefined) unconditionally; full state machine in M2.
   */
  resume(): Result<void, AppError>;
  /**
   * Advance one complete update/draw frame through the App-owned frame authority.
   * The App must be paused; deterministic tools supply the explicit delta.
   * `{ render: false }` runs only the World update (see {@link AppStepFrameOptions}).
   */
  stepFrame(deltaSeconds: number, options?: AppStepFrameOptions): Result<void, AppDispatchError>;
  /**
   * Subscribe to structured errors fan-out from the rAF loop. Returns an
   * unsubscribe handle. The callback signature deliberately excludes raw
   * Error (charter P3 -- AI users walk .code, not message strings).
   *
   * M1 stub: registers nothing and returns a no-op unsubscribe; full
   * fan-out registry lands in M4 (plan-strategy section 7).
   */
  onError(cb: (err: AppDispatchError) => void): () => void;
  /**
   * Replace the per-frame world routing pull. `undefined` restores the
   * single-world path; an injected result updates every returned secondary
   * World before drawing it with the declared owners. This changes routing,
   * not scheduling or time ownership.
   */
  setDrawSource(drawSource: DrawSource | undefined): void;
  /**
   * Most recent dispatched error retained for host self-inspection without
   * requiring an onError listener up front.
   */
  readonly lastError?: AppDispatchError | undefined;
  /** Optional single-frame RHI capture capability owned by the App host. */
  readonly rhiCapture?: RhiCapture;
  /**
   * Handle for the remote eval server started by createApp (dev mode).
   *
   * `undefined` in production builds and headless/dawn-node without explicit
   * opt-in. When present, the host can read `app.remote.port` for WS connection
   * details or call `await app.remote.close()` to tear down the server
   * (feat-20260629-inspector-two-layer-model M4 / w20).
   *
   * Typed as {@link RemoteHandle} from `@forgeax/engine-types` — a neutral
   * package with no dependency on `@forgeax/engine-remote`.
   */
  readonly remote?: import('@forgeax/engine-types').RemoteHandle | undefined;
}

/** Options for a paused {@link App.stepFrame}. */
export interface AppStepFrameOptions {
  /**
   * Default true. False runs the same World update (input, Time, Update and
   * FixedUpdate) but submits no picture and needs no frame receipt credit; the
   * next rendered frame draws the advanced World with a temporal reset. Queries
   * of the submitted picture (GPU picking, submitted terrain height) keep
   * answering for the last rendered frame until then.
   */
  readonly render?: boolean;
}

/** Host control returned by the unified execution path. Engine-owned objects remain realm-local. */
export type ExecutionApp = Pick<
  App,
  | 'execution'
  | 'input'
  | 'audio'
  | 'start'
  | 'stop'
  | 'pause'
  | 'resume'
  | 'stepFrame'
  | 'onError'
  | 'lastError'
  | 'dispose'
> & {
  /** Current host surface; render-worker recovery replaces the transferred element. */
  readonly canvas?: HTMLCanvasElement;
  /** Optional eval bridge whose executor remains in the selected Engine realm. */
  readonly remoteEval?: ExecutionRemoteEval;
  /** Internal bridge-disconnect hook for revoking Worker synthetic input. */
  readonly clearInput?: () => void;
  /** Open a fresh synthetic-input lease in the Worker session. */
  readonly beginInputLease?: () => void;
  /** Finish one Worker profiler session, fenced to its World and capture id. */
  readonly finishProfiler?: (expected?: {
    readonly worldIdentity?: string;
    readonly captureId?: string;
  }) => void;
};

/** A Promise-shaped inspection call with admission and cancellation witnesses. */
export type ExecutionRemoteEval = (
  code: string,
  expectedWorldIdentity?: string,
) => Promise<unknown> & {
  readonly started: Promise<void>;
  /** Resolves with whether the Worker had already admitted the inspection. */
  readonly cancel: () => Promise<boolean>;
};

/**
 * Error union returned by the assemble-form entry. The canvas-form thin
 * wrapper widens this with EngineEnvironmentError (createRenderer
 * construction-time failure path -- plan-strategy D-5 / requirements AC-01).
 *
 * Cordis activation failures are projected into AppError at this boundary.
 */
export type AssembleAppError = AppError | RhiError | AssetRuntimeAssemblyError;

/**
 * Error union returned by the canvas-form thin wrapper. Extends
 * AssembleAppError with EngineEnvironmentError to surface
 * createRenderer construction-time failures unchanged (preserves
 * .detail.webgpuError per requirements section 6.1).
 *
 * The canvas form adds renderer construction failures.
 */
export type CanvasAppError = AssembleAppError | EngineEnvironmentError;
