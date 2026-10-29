export type {
  PackDraftField,
  PackDraftReply,
  PackDraftRequest,
  PackDraftSnapshot,
} from '@forgeax/engine-pack/source';

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { type EntityHandle, Time, Update, type World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import type { PackProgramSource } from '@forgeax/engine-pack/runtime';
import type {
  PackDraftRequest,
  PackDraftSnapshot,
  PackDraftUpdate,
} from '@forgeax/engine-pack/source';
import { isScriptablePackAssetKind } from '@forgeax/engine-pack/source';
import type { Plugin } from '@forgeax/engine-plugin';
import type { TextureViewControl } from '@forgeax/engine-preview';
import { Camera } from '@forgeax/engine-render';
import { worldDespawnScene, worldSceneEntityAddressOf } from '@forgeax/engine-scene';
import type { ToolCallerIdentity } from '@forgeax/engine-tool-runtime';
import {
  type Asset,
  type AssetHandle,
  type CatalogEntry,
  type MeshAsset,
  materialGuidText,
  type SceneAsset,
} from '@forgeax/engine-types';
import { ensureFallbackCamera } from './fallback-camera';
import type { App } from './types';
import {
  createWorkspaceAssetAuthoring,
  type WorkspaceAssetFieldWrite,
} from './workspace-asset-authoring';
import {
  type EngineWorkspaceAssetFacts,
  workspaceAssetFacts,
  workspaceAssetKind,
} from './workspace-asset-facts';
import type { EngineWorkspaceRuntimePackRequest } from './workspace-runtime-pack';
import type { EngineWorkspaceTargetTools } from './workspace-target-tools';

/**
 * Engine-owned workspace plugin identity. A frontend plugin consumes
 * the workspace through its Host plugin; it does not implement a second asset
 * registry, scene loader, camera controller, or renderer.
 */
export const ENGINE_WORKSPACE_PLUGIN_ID = 'forgeax:engine-workspace';
export const ENGINE_WORKSPACE_API_VERSION = 'forgeax.engine.workspace/1';
/** Host transport topic used to dispatch commands into the browser realm. */
export const ENGINE_WORKSPACE_COMMAND_TOPIC = 'engine.workspace.command';
/** Host transport service used by the browser realm to return command results. */
export function engineWorkspaceResultService(targetId: string): string {
  return `engine.workspace.result:${targetId}`;
}
/** Built-in Engine type-preview owners available to the DevKit workspace. */
export const ENGINE_WORKSPACE_PREVIEWABLE_KINDS = [
  'scene',
  'material',
  'mesh',
  'texture',
  'equirect',
  'vfx',
] as const;

export class EngineWorkspaceError extends Error {
  constructor(
    readonly code: string,
    readonly expected: string,
    readonly hint: string = expected,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(expected);
    this.name = 'EngineWorkspaceError';
  }
}

export interface EngineWorkspaceProject {
  readonly id: string;
  readonly root: string;
  /** Authored source directories, when this workspace has a filesystem project. */
  readonly assetRoots?: readonly string[];
  readonly name?: string;
  readonly revision?: string;
}

export interface EngineWorkspaceAsset {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly sourceKey?: string;
  readonly packageId?: string;
  readonly lifecycle?: CatalogEntry['lifecycle'];
  readonly path?: string;
  readonly label?: string;
  readonly revision?: string;
  readonly previewable?: boolean;
}

/**
 * A presentation target identifies a live Engine surface.
 * `surface` is deliberately opaque: a browser host may expose
 * the real canvas/page through `attach`, while a native host may expose its
 * own headed surface. The Engine still owns the App/World/Renderer.
 */
export interface EngineWorkspaceTarget {
  readonly targetId: string;
  readonly sessionId: string;
  readonly worldId: string;
  /** Runtime-assigned preview generation; targetId may survive asset replacement. */
  readonly generation?: number;
  /** Whether the target is a visible/attached browser surface. */
  readonly headed: boolean;
  readonly width: number;
  readonly height: number;
  readonly frameId?: number;
  readonly url?: string;
  readonly surface?: unknown;
}

export interface EngineWorkspacePresentation {
  /**
   * Declare who places the exact surface. An Engine-owned surface stays in
   * its original document position; the consumer only controls visibility
   * and invokes the adapter lifecycle.
   */
  readonly surfacePlacement?: 'owner' | 'shell';
  /** Borrow the live target in this canvas document; replacement closes that lease. */
  readonly resolveTarget?: (targetId: string) => EngineWorkspacePreview | undefined;
  /**
   * Optionally return the exact host-owned surface for a target. A returned
   * element is adopted by the presentation host; it must not be a cloned
   * renderer or a screenshot mirror. `undefined` delegates surface creation
   * to the consumer.
   */
  readonly createSurface?: (input: {
    readonly target: EngineWorkspaceTarget;
    readonly tabId?: string;
    readonly document?: unknown;
  }) => unknown;
  /** Attach the exact target surface to a host-owned element. */
  readonly attach?: (input: {
    readonly target: EngineWorkspaceTarget;
    readonly element: unknown;
    readonly tabId?: string;
  }) => void | (() => void) | Promise<void | (() => void)>;
  readonly detach?: (input: {
    readonly target: EngineWorkspaceTarget;
    readonly element: unknown;
    readonly tabId?: string;
  }) => void | Promise<void>;
}

declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    /** Access to the exact Engine-owned surface for frontend plugin composition. */
    engineWorkspacePresentation?: EngineWorkspacePresentation;
  }
}

export interface EngineWorkspaceCameraResult {
  readonly camera: unknown;
  readonly version?: number;
  readonly committed?: boolean;
  readonly interaction?: {
    readonly interactionId: string;
    readonly clientId: string;
    readonly baseVersion: number;
  } | null;
}

export interface EngineWorkspaceCameraInput {
  readonly targetId: string;
  readonly interactionId?: string;
  readonly operationId?: string;
  readonly expectedVersion?: number;
  readonly baseVersion?: number;
  readonly camera?: unknown;
  readonly input?: unknown;
  readonly clientId?: string;
  /** Authenticated transport identity supplied by the backend, never by client arguments. */
  readonly connectionId?: string;
  readonly signal?: AbortSignal;
}

/** Facts captured by the consumer when it binds a payload, not a live Catalog query. */
export interface EngineWorkspaceAssetBinding {
  readonly publication?: CatalogEntry['publication'];
  readonly meta?: EngineWorkspaceAssetFacts;
}

export interface EngineWorkspacePreviewDisplayOptions {
  readonly mode?: 'material' | 'wireframe';
  readonly collision?: boolean;
  readonly bounds?: boolean;
}

export interface EngineWorkspacePreviewDisplay {
  readonly mode: 'material' | 'wireframe';
  readonly collision: boolean;
  readonly bounds: boolean;
  readonly uv?: {
    readonly channels: readonly number[];
    readonly layout?: {
      readonly channel: number;
      readonly lod: 0;
      readonly coordinates: readonly number[];
      readonly triangleIndices: readonly number[];
      readonly assetBinding: EngineWorkspaceAssetBinding;
    };
  };
  readonly capabilities: {
    readonly wireframe: boolean;
    readonly collision: boolean;
    readonly bounds: boolean;
  };
}

export interface EngineWorkspacePreview {
  readonly material?: import('./workspace-material-preview').MaterialPreviewControl;
  readonly writeAssetField?: (input: WorkspaceAssetFieldWrite) => Promise<void>;
  readonly prepareAssetContent?: (
    content: import('@forgeax/engine-import').RuntimePackContent,
    signal?: AbortSignal,
  ) => Promise<number>;
  readonly commitAssetContent?: (
    preparation: number,
    fields: readonly WorkspaceAssetFieldWrite[],
  ) => Promise<void>;
  readonly texture?: TextureViewControl;
  readonly display?: {
    get(options?: {
      readonly signal?: AbortSignal;
      readonly uvChannel?: number;
    }): EngineWorkspacePreviewDisplay | Promise<EngineWorkspacePreviewDisplay>;
    set(
      input: EngineWorkspacePreviewDisplayOptions,
      options?: { readonly signal?: AbortSignal },
    ): EngineWorkspacePreviewDisplay | Promise<EngineWorkspacePreviewDisplay>;
  };
  readonly resize?: (input: {
    readonly targetId: string;
    readonly width: number;
    readonly height: number;
    readonly signal?: AbortSignal;
  }) => Promise<EngineWorkspaceTarget>;
  /** Optional runtime control, supplied by the target tools plugin. */
  readonly setControl?: (
    input: EngineWorkspaceCameraInput & { mode: 'player' | 'observer' },
  ) => unknown | Promise<unknown>;
  readonly tools?: EngineWorkspaceTargetTools;
  /**
   * Public operations are on this outer object. `handle` is an opaque
   * owner-owned resource and is never the operation surface consumed by a
   * client. This keeps App/World internals out of the consumer contract.
   */
  readonly target: EngineWorkspaceTarget;
  readonly asset?: EngineWorkspaceAsset;
  readonly assetBinding?: EngineWorkspaceAssetBinding | undefined;
  readonly scene?: SceneAsset | undefined;
  readonly presentation?: EngineWorkspacePresentation;
  readonly handle?: unknown;
  readonly getCamera: (input: {
    readonly targetId: string;
    readonly signal?: AbortSignal;
  }) => Promise<EngineWorkspaceCameraResult | unknown> | EngineWorkspaceCameraResult | unknown;
  readonly beginCameraInteraction?: (
    input: EngineWorkspaceCameraInput,
  ) => Promise<unknown> | unknown;
  readonly updateCameraDraft?: (input: EngineWorkspaceCameraInput) => Promise<unknown> | unknown;
  readonly commitCamera?: (input: EngineWorkspaceCameraInput) => Promise<unknown> | unknown;
  readonly abortCameraInteraction?: (
    input: EngineWorkspaceCameraInput & { readonly reason?: string },
  ) => Promise<unknown> | unknown;
  /** Roll back an unfinished transaction without a consumer-side ownership ledger. */
  readonly revokeConnection?: (input: {
    readonly targetId: string;
    readonly connectionId: string;
  }) => Promise<unknown> | unknown;
  readonly capture?: (input: {
    readonly targetId: string;
    readonly signal?: AbortSignal;
    readonly width?: number;
    readonly height?: number;
  }) => Promise<unknown> | unknown;
  readonly close?: (input?: { readonly targetId?: string }) => Promise<void> | void;
}

export interface EngineWorkspacePlay extends EngineWorkspacePreview {
  readonly phase: 'starting' | 'running' | 'failed';
  /** Accepted browser handshakes; absent providers have not reported one yet. */
  readonly browserGeneration?: number | undefined;
  readonly ready: (signal?: AbortSignal) => Promise<void>;
}

/**
 * Engine-owned resources used by a non-Scene workspace preview.  The owner
 * creates the resource-specific entities in the same App/World as the
 * workspace target and returns its lifecycle and captured asset binding. Camera,
 * capture, target identity and interaction semantics remain in the common
 * workspace preview below.
 */
export interface EngineWorkspaceResourcePreviewOwner {
  readonly material?: EngineWorkspacePreview['material'];
  readonly texture?: TextureViewControl;
  readonly assetBinding?: EngineWorkspaceAssetBinding;
  readonly display?: EngineWorkspacePreview['display'];
  readonly close?: () => Promise<void> | void;
}

/**
 * Acquire slot assets concurrently. Settle all loads before returning or
 * releasing their grants, so late completion cannot outlive failed preparation.
 */
export async function loadEngineWorkspaceMaterialSlots(
  assets: AssetRegistry,
  slots: MeshAsset['materialSlots'],
): Promise<readonly (AssetHandle<'material'> | 0)[]> {
  const loaded = await Promise.allSettled(
    slots.map(async (slot) => {
      if (slot.defaultMaterial === undefined) return 0 as const;
      if (typeof slot.defaultMaterial === 'number') {
        assets.retain(slot.defaultMaterial, 'material').unwrap();
        return slot.defaultMaterial;
      }
      return (await assets.load(materialGuidText(slot.defaultMaterial), 'material')).unwrap();
    }),
  );
  const handles: (AssetHandle<'material'> | 0)[] = [];
  const failed = loaded.find((result) => result.status === 'rejected');
  for (const result of loaded) {
    if (result.status !== 'fulfilled') continue;
    if (failed && result.value !== 0) assets.release(result.value);
    handles.push(result.value);
  }
  if (failed) throw failed.reason;
  return handles;
}

export interface EngineWorkspaceProjectHandle {
  readonly project: EngineWorkspaceProject;
  /** The long-lived headed target created while opening the project. */
  readonly target?: EngineWorkspaceTarget;
  readonly handle?: unknown;
  /** Current terminal failure, projected from the session owner rather than probed by a command. */
  readonly failure?: unknown;
  /** Browser realm lifecycle. `starting` covers the first boot and a refresh detach. */
  readonly phase?: 'starting' | 'running' | 'failed' | undefined;
  /** Increments each time a browser page for this session reports ready. */
  readonly browserGeneration?: number | undefined;
}

/**
 * The Engine Host's concrete project boundary. A host creates one App,
 * AssetRegistry and headed target per session, then gives that session to the
 * public workspace provider below. Consumers never construct these values.
 */
export interface EngineWorkspaceProjectSession extends EngineWorkspaceProjectHandle {
  readonly authorPack?: EngineWorkspaceProvider['authorPack'];
  readonly inspectAsset?: (input: {
    readonly guid: string;
    readonly signal?: AbortSignal;
  }) => Promise<unknown>;
  readonly runtimePack?: (
    input: Omit<EngineWorkspaceRuntimePackInput, 'project' | 'handle'>,
  ) => Promise<unknown>;
  readonly startPlay?: (input: { readonly signal?: AbortSignal }) => Promise<EngineWorkspacePlay>;
  /**
   * Local sessions expose the concrete App and AssetRegistry. A browser-realm
   * session may omit them and implement the operation methods below; App/World
   * objects must never cross the transport as serialized handles.
   */
  readonly app?: App;
  readonly assets?: AssetRegistry;
  readonly target: EngineWorkspaceTarget;
  readonly presentation?: EngineWorkspacePresentation;
  readonly capture?: EngineWorkspacePreview['capture'];
  readonly applyInput?: (
    input: EngineWorkspaceCameraInput & { readonly world: World; readonly app: App },
  ) => Promise<unknown> | unknown;
  readonly listAssets?: (input: {
    readonly signal?: AbortSignal;
  }) => Promise<readonly EngineWorkspaceAsset[]> | readonly EngineWorkspaceAsset[];
  /**
   * Optional Engine-owned dispatch for asset kinds other than SceneAsset. The
   * project host remains the owner of the existing type-preview capability;
   * the workspace provider only supplies the common target/session contract.
   */
  readonly openPreview?: (input: {
    readonly project: EngineWorkspaceProject;
    readonly asset: EngineWorkspaceAsset;
    readonly target: EngineWorkspaceTarget;
    readonly width: number;
    readonly height: number;
    readonly signal?: AbortSignal;
  }) => Promise<EngineWorkspacePreview> | EngineWorkspacePreview;
  readonly close?: () => Promise<void> | void;
}

export interface EngineWorkspaceProjectSessionFactory {
  readonly openProjectSession: (input: {
    readonly root: string;
    readonly signal?: AbortSignal;
  }) => Promise<EngineWorkspaceProjectSession> | EngineWorkspaceProjectSession;
}

export interface EngineWorkspaceAssetInput {
  readonly project: EngineWorkspaceProject;
  readonly handle?: unknown;
  readonly guid: string;
  readonly signal?: AbortSignal;
}

export interface EngineWorkspaceRuntimePackInput extends EngineWorkspaceProjectHandle {
  readonly targetId: string;
  readonly worldId: string;
  readonly request: EngineWorkspaceRuntimePackRequest;
  /** Attached by Host/ToolApi, never copied from the caller payload. */
  readonly connectionId?: string;
  readonly signal?: AbortSignal;
}

export interface EngineWorkspaceProvider {
  readonly authorPack?: (
    input: EngineWorkspaceProjectHandle & {
      readonly request: PackDraftRequest;
      readonly previewTargetId?: string;
      readonly signal?: AbortSignal;
    },
  ) => Promise<PackDraftSnapshot | PackDraftUpdate | { readonly closed: string }>;
  readonly runtimePack?: (input: EngineWorkspaceRuntimePackInput) => Promise<unknown>;
  readonly prepareRuntimePackProgram?: (
    input: EngineWorkspaceProjectHandle & {
      readonly source: PackProgramSource;
      readonly signal?: AbortSignal;
    },
  ) => unknown | Promise<unknown>;
  readonly startPlay?: (
    input: EngineWorkspaceProjectHandle & { readonly signal?: AbortSignal },
  ) => Promise<EngineWorkspacePlay>;
  readonly inspectAsset?: (input: EngineWorkspaceAssetInput) => unknown | Promise<unknown>;
  readonly rebuildAssetSource?: (
    input: EngineWorkspaceAssetInput & {
      readonly mode: 'rebuild' | 'cold-cook';
      readonly requestId: string;
      readonly expectedRevision: string;
    },
  ) => unknown | Promise<unknown>;
  readonly openProject: (input: {
    readonly root: string;
    readonly signal?: AbortSignal;
  }) => Promise<EngineWorkspaceProjectHandle> | EngineWorkspaceProjectHandle;
  readonly closeProject: (input: {
    readonly project: EngineWorkspaceProject;
    readonly handle?: unknown;
  }) => Promise<void> | void;
  readonly listAssets: (input: {
    readonly project: EngineWorkspaceProject;
    readonly handle?: unknown;
    readonly signal?: AbortSignal;
  }) => Promise<readonly EngineWorkspaceAsset[]> | readonly EngineWorkspaceAsset[];
  readonly openPreview: (input: {
    readonly project: EngineWorkspaceProject;
    readonly projectHandle?: unknown;
    readonly asset: EngineWorkspaceAsset;
    readonly width: number;
    readonly height: number;
    readonly signal?: AbortSignal;
  }) => Promise<EngineWorkspacePreview> | EngineWorkspacePreview;
  /** Optional provider-owned cleanup for sessions that are still opening. */
  readonly dispose?: () => Promise<void> | void;
}

/**
 * Adapt a concrete Engine Host project-session constructor to the common
 * workspace provider. The constructor is deliberately explicit: it is the
 * only boundary that knows how a project becomes a long-lived headed App
 * target. Every query and preview operation after that point is Engine-owned.
 */
export function createEngineWorkspaceProvider(
  factory: EngineWorkspaceProjectSessionFactory,
): EngineWorkspaceProvider {
  if (!factory || typeof factory.openProjectSession !== 'function') {
    throw new TypeError('Engine workspace provider requires openProjectSession');
  }
  const sessionFor = (handle: unknown): EngineWorkspaceProjectSession => {
    if (
      handle === null ||
      typeof handle !== 'object' ||
      !('target' in handle) ||
      (typeof (handle as { readonly openPreview?: unknown }).openPreview !== 'function' &&
        typeof (handle as { readonly listAssets?: unknown }).listAssets !== 'function' &&
        !('app' in handle && 'assets' in handle))
    ) {
      throw new TypeError('Engine workspace project handle is not a project session');
    }
    return handle as EngineWorkspaceProjectSession;
  };
  return {
    async inspectAsset(input) {
      const session = sessionFor(input.handle);
      if (session.project.id !== input.project.id)
        throw new EngineWorkspaceError(
          'engine-workspace-project-mismatch',
          'The current project session',
        );
      input.signal?.throwIfAborted();
      if (session.inspectAsset) return session.inspectAsset(input);
      if (!session.assets)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'Asset inspection in the project session',
        );
      return inspectEngineWorkspaceAsset(session.assets, input.guid, input.signal);
    },
    async authorPack(input) {
      const session = sessionFor(input.handle);
      if (session.project.id !== input.project.id || !session.authorPack)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'Pack authoring for this project session',
        );
      return session.authorPack(input);
    },
    async runtimePack(input) {
      const session = sessionFor(input.handle);
      if (session.project.id !== input.project.id)
        throw new EngineWorkspaceError(
          'engine-workspace-project-mismatch',
          'The current project session',
        );
      if (!session.runtimePack)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'A runtime Pack project session',
        );
      return session.runtimePack(input);
    },
    async startPlay(input) {
      const session = sessionFor(input.handle);
      if (!session.startPlay)
        throw new EngineWorkspaceError(
          'engine-workspace-capability-unavailable',
          'An Engine Play provider',
        );
      return session.startPlay(input.signal ? { signal: input.signal } : {});
    },
    async openProject(input) {
      const session = await factory.openProjectSession(input);
      if (!session || typeof session !== 'object') {
        throw new TypeError('Engine workspace session factory must return a session');
      }
      assertTarget(session.target);
      return {
        project: session.project,
        get target() {
          return session.target;
        },
        handle: session,
        get failure() {
          return session.failure;
        },
        get phase() {
          return session.phase;
        },
        get browserGeneration() {
          return session.browserGeneration;
        },
      };
    },
    async closeProject(input) {
      const session = sessionFor(input.handle);
      await Promise.resolve(session.close?.());
    },
    async listAssets(input) {
      const session = sessionFor(input.handle);
      if (session.listAssets !== undefined) {
        return session.listAssets(input.signal === undefined ? {} : { signal: input.signal });
      }
      if (session.assets === undefined) {
        throw new TypeError('Engine workspace session must expose listAssets or an AssetRegistry');
      }
      return projectEngineWorkspaceAssets(session.assets.catalogSnapshot()?.entries ?? []);
    },
    async openPreview(input) {
      const session = sessionFor(input.projectHandle);
      if (session.project.id !== input.project.id) {
        throw new Error('Engine workspace project session identity mismatch');
      }
      const target = {
        ...session.target,
        width: input.width,
        height: input.height,
      };
      if (typeof session.openPreview === 'function') {
        return session.openPreview({
          project: input.project,
          asset: input.asset,
          target,
          width: input.width,
          height: input.height,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      }
      if (session.app === undefined || session.assets === undefined) {
        throw new TypeError(
          'Engine workspace session must expose openPreview or a local App and AssetRegistry',
        );
      }
      if (input.asset.kind !== 'scene') {
        throw new Error(
          `Engine workspace preview does not support asset kind ${input.asset.kind}; provide the Engine type-preview capability on the project session`,
        );
      }
      return createEngineWorkspaceAppPreview({
        app: session.app,
        assets: session.assets,
        asset: input.asset,
        project: input.project,
        target,
        ...(session.presentation === undefined ? {} : { presentation: session.presentation }),
        ...(session.capture === undefined ? {} : { capture: session.capture }),
        ...(session.applyInput === undefined ? {} : { applyInput: session.applyInput }),
      });
    },
  };
}

/** Optional Host assembly capability: resolve an admitted caller to its Engine session.
 * Each returned runtime retains the ordinary single-project lifetime contract.
 */
declare module '@forgeax/engine-plugin' {
  interface EngineContextServices {
    engineWorkspaceForCaller?: (
      caller?: ToolCallerIdentity,
      targetId?: string,
    ) => EngineWorkspaceRuntime | undefined;
  }
}

export interface EngineWorkspaceRuntime {
  readonly authorPack?: EngineWorkspaceProvider['authorPack'];
  readonly runtimePack?: EngineWorkspaceProvider['runtimePack'];
  readonly prepareRuntimePackProgram?: EngineWorkspaceProvider['prepareRuntimePackProgram'];
  readonly apiVersion: typeof ENGINE_WORKSPACE_API_VERSION;
  /** Current Engine owners; resource handles remain process-local. */
  readonly project: EngineWorkspaceProjectHandle | undefined;
  /** Most recently opened preview, derived from the owned collection. */
  readonly preview: EngineWorkspacePreview | undefined;
  readonly previews: readonly EngineWorkspacePreview[];
  readonly play?: EngineWorkspacePlay | undefined;
  readonly startPlay?: EngineWorkspaceProvider['startPlay'];
  readonly stopPlay?: (play: EngineWorkspacePlay) => Promise<void>;
  readonly inspectAsset?: EngineWorkspaceProvider['inspectAsset'];
  readonly rebuildAssetSource?: EngineWorkspaceProvider['rebuildAssetSource'];
  readonly openProject: (input: {
    readonly root: string;
    readonly expectedTargetId?: string | null;
    readonly expectedTargetState?: 'lost';
    readonly signal?: AbortSignal;
  }) => Promise<EngineWorkspaceProjectHandle>;
  readonly closeProject: EngineWorkspaceProvider['closeProject'];
  readonly listAssets: EngineWorkspaceProvider['listAssets'];
  readonly openPreview: EngineWorkspaceProvider['openPreview'];
  readonly closePreview: (preview: EngineWorkspacePreview) => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface RuntimeState {
  project?: EngineWorkspaceProjectHandle | undefined;
  previews: Map<string, EngineWorkspacePreview>;
  play?: EngineWorkspacePlay | undefined;
  generation: number;
  disposed: boolean;
}

function abortError(signal: AbortSignal | undefined): never | void {
  if (!signal?.aborted) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw Object.assign(new Error('engine workspace operation was cancelled'), {
    name: 'AbortError',
    cause: reason,
  });
}

function assertTarget(target: EngineWorkspaceTarget): void {
  if (
    typeof target.targetId !== 'string' ||
    target.targetId.length === 0 ||
    typeof target.sessionId !== 'string' ||
    target.sessionId.length === 0 ||
    typeof target.worldId !== 'string' ||
    target.worldId.length === 0 ||
    typeof target.headed !== 'boolean' ||
    !Number.isSafeInteger(target.width) ||
    target.width < 1 ||
    !Number.isSafeInteger(target.height) ||
    target.height < 1
  ) {
    throw new TypeError(
      'Engine workspace preview must return a stable target with session, World, extent, and headed identities',
    );
  }
}

function normalizePreview(preview: EngineWorkspacePreview): EngineWorkspacePreview {
  if (preview === null || typeof preview !== 'object') {
    throw new TypeError('Engine workspace preview must be an object');
  }
  assertTarget(preview.target);
  if (typeof preview.getCamera !== 'function') {
    throw new TypeError('Engine workspace preview must expose the Engine observation camera');
  }
  return preview;
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function finiteInputNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

interface WorkspaceCameraInputController {
  readonly pivot: readonly number[] | undefined;
  readonly setPivot: (value: unknown) => void;
  readonly apply: NonNullable<EngineWorkspaceProjectSession['applyInput']>;
  readonly reset: () => void;
  readonly dispose: () => void;
}

function finiteVector3(value: unknown): [number, number, number] | undefined {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    !('length' in value) ||
    typeof value.length !== 'number' ||
    value.length < 3
  ) {
    return undefined;
  }
  const sequence = value as ArrayLike<unknown>;
  const vector = [Number(sequence[0]), Number(sequence[1]), Number(sequence[2])] as [
    number,
    number,
    number,
  ];
  return vector.every(Number.isFinite) ? vector : undefined;
}

function rotateWorkspaceVector(
  quaternion: ArrayLike<number>,
  vector: readonly [number, number, number],
): [number, number, number] {
  const qx = Number(quaternion[0]);
  const qy = Number(quaternion[1]);
  const qz = Number(quaternion[2]);
  const qw = Number(quaternion[3]);
  const [vx, vy, vz] = vector;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + (qy * tz - qz * ty),
    vy + qw * ty + (qz * tx - qx * tz),
    vz + qw * tz + (qx * ty - qy * tx),
  ];
}

/**
 * Default Engine-owned input path for a headed workspace preview. The consumer
 * transports input samples only; this controller applies pointer-look and
 * motion in the Engine realm. World Update integrates the requested velocity;
 * input adapters own key bindings, sensitivity, speed curves and pitch limits.
 */
function createDefaultWorkspaceCameraInputController(
  observation: NonNullable<App['observation']>,
  isActive: () => boolean,
  world: World,
  systemName: string,
): WorkspaceCameraInputController {
  let velocity: [number, number, number] = [0, 0, 0];
  let pivot: [number, number, number] | undefined;
  const apply: NonNullable<EngineWorkspaceProjectSession['applyInput']> = ({ input }) => {
    const sample = record(input);
    if (sample === undefined) return;
    if (sample.type === 'move') {
      velocity = finiteVector3(sample.velocity) ?? [0, 0, 0];
      return;
    }
    if (!['look', 'orbit', 'pan', 'dolly'].includes(String(sample.type)))
      throw new TypeError('Workspace camera input requires a semantic motion');

    const state = record(observation.camera.get());
    const transform = record(state?.transform);
    const entity = state?.entity;
    const quaternion = transform?.quat;
    const quaternionValues: ArrayLike<number> | undefined = Array.isArray(quaternion)
      ? quaternion
      : ArrayBuffer.isView(quaternion) &&
          'length' in quaternion &&
          typeof quaternion.length === 'number'
        ? (quaternion as unknown as ArrayLike<number>)
        : undefined;
    if (
      !Number.isSafeInteger(entity) ||
      quaternionValues === undefined ||
      quaternionValues.length < 4
    ) {
      return;
    }
    const position = finiteVector3(transform?.pos);
    if (!position) return;
    const dx = finiteInputNumber(sample.x);
    const dy = finiteInputNumber(sample.y);
    const forward = rotateWorkspaceVector(quaternionValues, [0, 0, -1]);
    const origin =
      pivot ??
      position.map(
        (v, i) => v + (forward[i] ?? 0) * Math.max(0.01, finiteInputNumber(sample.distance)),
      );
    const distance = Math.max(0.01, Math.hypot(...position.map((v, i) => v - (origin[i] ?? 0))));
    if (sample.type === 'pan') {
      const right = rotateWorkspaceVector(quaternionValues, [1, 0, 0]);
      const up = rotateWorkspaceVector(quaternionValues, [0, 1, 0]);
      pivot = origin.map((v, i) => v + (dx * (right[i] ?? 0) + dy * (up[i] ?? 0)) * distance) as [
        number,
        number,
        number,
      ];
      observation.camera.set({
        entity,
        transform: {
          ...transform,
          pos: position.map((v, i) => v + (dx * (right[i] ?? 0) + dy * (up[i] ?? 0)) * distance),
        },
      });
      return;
    }
    if (sample.type === 'dolly') {
      const delta = finiteInputNumber(sample.amount);
      const lens = record(state?.lens);
      if (lens?.projection === 'orthographic') {
        const scale = Math.exp(delta);
        observation.camera.set({
          entity,
          lens: {
            left: Number(lens.left) * scale,
            right: Number(lens.right) * scale,
            top: Number(lens.top) * scale,
            bottom: Number(lens.bottom) * scale,
          },
        });
      } else {
        observation.camera.set({
          entity,
          transform: {
            ...transform,
            pos: position.map((v, i) => v - (forward[i] ?? 0) * delta * distance),
          },
        });
      }
      return;
    }
    const yaw = finiteInputNumber(sample.yaw);
    const pitch = finiteInputNumber(sample.pitch);
    let orientation = quat.rotateAxis(
      quat.create(),
      quaternionValues as ReturnType<typeof quat.create>,
      [0, 1, 0],
      yaw,
    );
    quat.rotateAxis(orientation, orientation, [1, 0, 0], pitch);
    if (typeof sample.pitchLimit === 'number' && Number.isFinite(sample.pitchLimit)) {
      const limit = Math.max(0, Math.min(Math.PI / 2, sample.pitchLimit));
      orientation = quat.fromEuler(
        quat.create(),
        Math.max(-limit, Math.min(limit, Math.asin(Math.max(-1, Math.min(1, forward[1]))) + pitch)),
        Math.atan2(-forward[0], -forward[2]) + yaw,
        0,
        'YXZ',
      );
    }
    observation.camera.set({
      entity,
      transform: {
        ...transform,
        quat: Array.from(orientation),
        ...(sample.type === 'orbit'
          ? {
              pos: origin.map(
                (v, i) => v - (rotateWorkspaceVector(orientation, [0, 0, -1])[i] ?? 0) * distance,
              ),
            }
          : {}),
      },
    });
  };
  const tick = (): void => {
    const deltaSeconds = Math.min(0.05, world.getResource(Time).delta);
    if (!isActive() || velocity.every((value) => value === 0) || deltaSeconds === 0) return;
    const state = record(observation.camera.get());
    const transform = record(state?.transform);
    const entity = state?.entity;
    const position = finiteVector3(transform?.pos);
    if (!Number.isSafeInteger(entity) || position === undefined) return;
    const quaternion = transform?.quat;
    const quaternionValues: ArrayLike<number> | undefined = Array.isArray(quaternion)
      ? quaternion
      : ArrayBuffer.isView(quaternion) &&
          'length' in quaternion &&
          typeof quaternion.length === 'number'
        ? (quaternion as unknown as ArrayLike<number>)
        : undefined;
    const forward: [number, number, number] =
      quaternionValues !== undefined && quaternionValues.length >= 4
        ? rotateWorkspaceVector(quaternionValues, [0, 0, -1])
        : [0, 0, -1];
    const right: [number, number, number] =
      quaternionValues !== undefined && quaternionValues.length >= 4
        ? rotateWorkspaceVector(quaternionValues, [1, 0, 0])
        : [1, 0, 0];
    const direction = right.map(
      (v, i) => v * velocity[0] + (i === 1 ? velocity[1] : 0) - (forward[i] ?? 0) * velocity[2],
    );
    observation.camera.set({
      entity,
      transform: {
        ...transform,
        pos: [
          position[0] + (direction[0] ?? 0) * deltaSeconds,
          position[1] + (direction[1] ?? 0) * deltaSeconds,
          position[2] + (direction[2] ?? 0) * deltaSeconds,
        ],
      },
    });
  };
  world.addSystem(Update, { name: systemName, queries: [], fn: tick }).unwrap();
  return {
    apply,
    get pivot() {
      return pivot;
    },
    setPivot(value) {
      pivot = finiteVector3(value);
    },
    reset() {
      velocity = [0, 0, 0];
    },
    dispose() {
      world.removeSystem(Update, systemName);
      velocity = [0, 0, 0];
    },
  };
}

/**
 * Build the Engine-owned project/asset/preview lifecycle used by external
 * host clients. The provider is a dependency boundary for the actual
 * project host (for example DevKit's long-lived headed project session); all
 * stateful replacement, generation fencing and resource cleanup live here.
 */
export function createEngineWorkspaceRuntime(
  provider: EngineWorkspaceProvider,
): EngineWorkspaceRuntime {
  if (!provider || typeof provider.openProject !== 'function') {
    throw new TypeError('Engine workspace provider requires openProject');
  }
  if (typeof provider.closeProject !== 'function' || typeof provider.listAssets !== 'function') {
    throw new TypeError('Engine workspace provider requires closeProject and listAssets');
  }
  if (typeof provider.openPreview !== 'function') {
    throw new TypeError('Engine workspace provider requires openPreview');
  }
  const state: RuntimeState = { previews: new Map(), generation: 0, disposed: false };
  let previewGeneration = 0;
  let mutation = Promise.resolve();
  let disposal: Promise<void> | undefined;

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = mutation.then(operation, operation);
    mutation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const closePreview = async (preview: EngineWorkspacePreview): Promise<void> => {
    if (state.previews.get(preview.target.targetId) !== preview) return;
    await preview.close?.({ targetId: preview.target.targetId });
    if (state.previews.get(preview.target.targetId) === preview)
      state.previews.delete(preview.target.targetId);
  };
  const closePreviews = async (): Promise<void> => {
    for (const preview of [...state.previews.values()]) await closePreview(preview).catch(() => {});
  };
  const closeUnadoptedPreview = async (preview: EngineWorkspacePreview): Promise<void> => {
    const current = state.previews.get(preview.target.targetId);
    if (current === preview) await closePreview(preview);
    else if (!current) await preview.close?.({ targetId: preview.target.targetId });
  };

  const stopPlay = async (play: EngineWorkspacePlay): Promise<void> => {
    if (state.play !== play) return;
    // Its published URL may already be loading modules before the first ready
    // handshake. Keep that server and presentation alive until the browser can
    // acknowledge cleanup. A readiness failure must not become a successful stop.
    const parentRetired =
      state.project?.phase === 'starting' && (state.project.browserGeneration ?? 0) > 0;
    if (play.phase === 'starting' && (play.browserGeneration ?? 0) === 0 && !parentRetired)
      await play.ready();
    await play.close?.({ targetId: play.target.targetId });
    if (state.play === play) state.play = undefined;
  };

  const startPlay = provider.startPlay?.bind(provider);
  const runtime: EngineWorkspaceRuntime = {
    apiVersion: ENGINE_WORKSPACE_API_VERSION,
    ...(provider.runtimePack === undefined
      ? {}
      : {
          async runtimePack(input: EngineWorkspaceRuntimePackInput) {
            const project = state.project;
            if (
              state.disposed ||
              !project ||
              project.project.id !== input.project.id ||
              project.handle !== input.handle
            )
              throw new EngineWorkspaceError(
                'engine-workspace-project-stale',
                'The current project handle',
              );
            abortError(input.signal);
            const result = await provider.runtimePack?.(input);
            abortError(input.signal);
            if (state.project !== project || state.disposed)
              throw new EngineWorkspaceError(
                'engine-workspace-project-stale',
                'The same project after the operation',
              );
            return result;
          },
        }),
    ...(provider.prepareRuntimePackProgram === undefined
      ? {}
      : {
          async prepareRuntimePackProgram(
            input: Parameters<NonNullable<EngineWorkspaceProvider['prepareRuntimePackProgram']>>[0],
          ) {
            const project = state.project;
            if (
              state.disposed ||
              !project ||
              project.project.id !== input.project.id ||
              project.handle !== input.handle
            )
              throw new EngineWorkspaceError(
                'engine-workspace-project-stale',
                'The current project handle',
              );
            abortError(input.signal);
            const result = await provider.prepareRuntimePackProgram?.(input);
            abortError(input.signal);
            if (state.project !== project || state.disposed)
              throw new EngineWorkspaceError(
                'engine-workspace-project-stale',
                'The same project after program preparation',
              );
            return result;
          },
        }),
    ...(provider.inspectAsset === undefined
      ? {}
      : { inspectAsset: provider.inspectAsset.bind(provider) }),
    ...(provider.authorPack === undefined
      ? {}
      : { authorPack: provider.authorPack.bind(provider) }),
    ...(provider.rebuildAssetSource === undefined
      ? {}
      : { rebuildAssetSource: provider.rebuildAssetSource.bind(provider) }),
    get project() {
      return state.project;
    },
    get preview() {
      return [...state.previews.values()].at(-1);
    },
    get previews() {
      return [...state.previews.values()];
    },
    get play() {
      return state.play;
    },
    stopPlay: (play) => enqueue(() => stopPlay(play)),
    ...(startPlay
      ? {
          startPlay: (input: EngineWorkspaceProjectHandle & { signal?: AbortSignal }) =>
            enqueue(async () => {
              abortError(input.signal);
              if (state.disposed || !state.project || input.handle !== state.project.handle)
                throw new EngineWorkspaceError(
                  'engine-workspace-project-stale',
                  'The current project session',
                );
              if (state.play)
                throw new EngineWorkspaceError(
                  'engine-workspace-target-busy',
                  'Stop the current Play before starting another',
                );
              const opened = await startPlay(input);
              try {
                abortError(input.signal);
                if (state.disposed) throw new Error('engine workspace is disposed');
                const play: EngineWorkspacePlay = {
                  ...opened,
                  get phase() {
                    return opened.phase;
                  },
                  get browserGeneration() {
                    return opened.browserGeneration;
                  },
                  get target() {
                    return { ...opened.target, generation: 1 };
                  },
                };
                state.play = play;
                return play;
              } catch (error) {
                await opened.close?.();
                throw error;
              }
            }),
        }
      : {}),
    async openProject(input) {
      abortError(input.signal);
      if (state.disposed) throw new Error('engine workspace is disposed');
      if (
        input.expectedTargetState !== undefined &&
        (input.expectedTargetState !== 'lost' ||
          typeof input.expectedTargetId !== 'string' ||
          !input.expectedTargetId.trim())
      )
        throw new TypeError('Expected lost state requires an exact target identity');
      let generation = input.expectedTargetId === undefined ? ++state.generation : state.generation;
      return enqueue(async () => {
        abortError(input.signal);
        if (input.expectedTargetId !== undefined) {
          if ((state.project?.target?.targetId ?? null) !== input.expectedTargetId)
            throw new EngineWorkspaceError(
              'engine-workspace-target-mismatch',
              'The expected project target must still be current',
              'Another page changed the project. Refresh state and choose explicitly.',
            );
          if (
            input.expectedTargetState === 'lost' &&
            record(state.project?.failure)?.code !== 'engine-workspace-page-lost'
          )
            throw new EngineWorkspaceError(
              'engine-workspace-target-busy',
              'Replacement requires the identified target to be lost',
              'The current target is not known to be lost.',
            );
          generation = ++state.generation;
        }
        if (state.play) await stopPlay(state.play);
        let opened: EngineWorkspaceProjectHandle | undefined;
        try {
          opened = await provider.openProject({
            root: input.root,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          abortError(input.signal);
        } catch (error) {
          // A provider may have already allocated an App/World/renderer before
          // its promise resolves. Never strand that handle when cancellation
          // wins the generation race.
          if (
            opened !== undefined &&
            (input.signal?.aborted || generation !== state.generation || state.disposed)
          ) {
            await Promise.resolve(provider.closeProject(opened)).catch(() => {});
          }
          throw error;
        }
        if (generation !== state.generation || state.disposed) {
          await Promise.resolve(provider.closeProject(opened)).catch(() => {});
          throw new Error('engine workspace project open became stale');
        }
        await closePreviews();
        if (state.project !== undefined) {
          const oldProject = state.project;
          try {
            await provider.closeProject(oldProject);
          } catch (cause) {
            try {
              await provider.closeProject(opened);
            } catch (cleanup) {
              throw new AggregateError([cause, cleanup], 'Workspace replacement cleanup failed');
            }
            throw cause;
          }
        }
        state.project = opened;
        return opened;
      });
    },
    async closeProject(input) {
      if (state.project !== undefined && input.project.id !== state.project.project.id) {
        throw new Error('engine workspace close targets a different project');
      }
      if (input.handle !== undefined && state.project?.handle !== input.handle) {
        throw new EngineWorkspaceError(
          'engine-workspace-project-stale',
          'the active project handle',
          'Discard the stale project handle and refresh the workspace identity.',
        );
      }
      ++state.generation;
      await enqueue(async () => {
        if (state.play) await stopPlay(state.play);
        await closePreviews();
        if (state.project !== undefined) {
          const project = state.project;
          await provider.closeProject(project);
          state.project = undefined;
        }
      });
    },
    async listAssets(input) {
      if (state.disposed) throw new Error('engine workspace is disposed');
      const project = state.project?.project ?? input.project;
      if (state.project !== undefined && state.project.project.id !== input.project.id) {
        throw new Error('engine workspace asset request targets a different project');
      }
      const result = await provider.listAssets({
        ...input,
        project,
        handle: state.project?.handle ?? input.handle,
      });
      return [...result];
    },
    async openPreview(input) {
      abortError(input.signal);
      if (state.disposed) throw new Error('engine workspace is disposed');
      if (state.project !== undefined && state.project.project.id !== input.project.id) {
        throw new Error('engine workspace preview targets a different project');
      }
      const epoch = state.generation;
      return enqueue(async () => {
        abortError(input.signal);
        if (epoch !== state.generation || state.disposed)
          throw new Error('engine workspace preview open became stale');
        const opened = normalizePreview(
          await provider.openPreview({
            ...input,
            projectHandle: state.project?.handle ?? input.projectHandle,
          }),
        );
        const generation = ++previewGeneration;
        const preview = {
          ...opened,
          get target() {
            return { ...opened.target, generation };
          },
        };
        if (input.signal?.aborted || epoch !== state.generation || state.disposed) {
          await closeUnadoptedPreview(preview).catch(() => {});
          abortError(input.signal);
          throw new Error('engine workspace preview open became stale');
        }
        const replaced = state.previews.get(preview.target.targetId);
        if (replaced) await closePreview(replaced);
        state.previews.set(preview.target.targetId, preview);
        return preview;
      });
    },
    closePreview,
    dispose() {
      if (disposal) return disposal;
      state.disposed = true;
      ++state.generation;
      disposal = (async () => {
        const failures: unknown[] = [];
        try {
          await enqueue(async () => {
            if (state.play) await stopPlay(state.play);
            await closePreviews();
            if (state.project !== undefined) {
              await provider.closeProject(state.project);
              state.project = undefined;
            }
          });
        } catch (cause) {
          failures.push(cause);
        }
        try {
          await provider.dispose?.();
        } catch (cause) {
          if (!failures.includes(cause)) failures.push(cause);
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length) throw new AggregateError(failures, 'Workspace cleanup failed');
      })();
      return disposal;
    },
  };
  return runtime;
}

/**
 * Create a preview backed by a real App/World/AssetRegistry.  This helper is
 * intentionally small: project-specific target presentation and capture are
 * supplied by the headed host, while SceneAsset loading, instantiation and
 * observation camera ownership remain Engine code.
 */
export interface EngineWorkspaceAppTargetOptions {
  readonly resize?: (
    input: Parameters<NonNullable<EngineWorkspacePreview['resize']>>[0],
  ) => Promise<void> | void;
  readonly app: App;
  readonly tools?: EngineWorkspaceTargetTools;
  readonly target: EngineWorkspaceTarget;
  readonly presentation?: EngineWorkspacePresentation;
  readonly capture?: EngineWorkspacePreview['capture'];
  readonly close?: EngineWorkspacePreview['close'];
  readonly applyInput?: (
    input: EngineWorkspaceCameraInput & { readonly world: World; readonly app: App },
  ) => Promise<unknown> | unknown;
}

function resourcePreviewControls(
  owner: EngineWorkspaceResourcePreviewOwner | undefined,
): Pick<EngineWorkspacePreview, 'texture' | 'material' | 'display'> {
  return {
    ...(owner?.texture === undefined ? {} : { texture: owner.texture }),
    ...(owner?.material === undefined ? {} : { material: owner.material }),
    ...(owner?.display === undefined ? {} : { display: owner.display }),
  };
}

export async function createEngineWorkspaceAppPreview(
  input: EngineWorkspaceAppTargetOptions & {
    readonly assets: AssetRegistry;
    readonly asset: EngineWorkspaceAsset;
    readonly project?: EngineWorkspaceProject;
    readonly openResourcePreview?: (input: {
      readonly app: App;
      readonly assets: AssetRegistry;
      readonly asset: EngineWorkspaceAsset;
      readonly project?: EngineWorkspaceProject;
      readonly target: EngineWorkspaceTarget;
    }) => Promise<EngineWorkspaceResourcePreviewOwner> | EngineWorkspaceResourcePreviewOwner;
  },
): Promise<EngineWorkspacePreview> {
  assertTarget(input.target);
  if (!input.app.observation)
    throw new Error('Engine App observation is required for a workspace preview');
  let loadedScene: SceneAsset | undefined;
  let sceneRoot: EntityHandle | undefined;
  let fallbackCamera: EntityHandle | undefined;
  let resourceOwner: EngineWorkspaceResourcePreviewOwner | undefined;
  let assetBinding: EngineWorkspaceAssetBinding | undefined;
  if (input.asset.kind === 'scene') {
    (await input.assets.reconcileCatalog()).unwrap();
    let loaded = await input.assets.load(input.asset.guid, 'scene');
    // A producer can finish publishing while the first load is awaiting bytes.
    // Nothing has been instantiated, so retry that superseded read once.
    if (!loaded.ok && loaded.error.code === 'asset-superseded')
      loaded = await input.assets.load(input.asset.guid, 'scene');
    if (!loaded.ok) throw loaded.error;
    const handle = loaded.value;
    try {
      // load() deliberately retains runtime edits. An explicit reopen adopts a
      // newer saved publication before instantiating that retained identity.
      const adopted = input.assets.source(handle).unwrap()?.publication;
      const published = input.assets.catalogEntry(input.asset.guid)?.publication;
      if (adopted && published && adopted.digest !== published.digest)
        (await input.assets.reload(handle, { conflict: 'overwrite' })).unwrap();
      assetBinding = captureEngineWorkspaceAssetBinding(input.assets, handle);
      loadedScene = input.assets.read(handle).unwrap();
      sceneRoot = input.assets.instantiate(handle, input.app.world).unwrap();
    } finally {
      // SceneInstance owns its hold after successful instantiation.
      input.assets.release(handle);
    }
    // A SceneAsset is also a valid standalone preview when it has no authored
    // Camera. Reuse the host fallback-camera owner so the observation API and
    // renderer share the same neutral projection; the temporary entity is
    // released with this preview.
    const fallback = ensureFallbackCamera(
      input.app.world,
      input.target.width / Math.max(1, input.target.height),
    );
    if (fallback !== undefined) {
      if (!fallback.ok) {
        const despawned = worldDespawnScene(input.app.world, sceneRoot);
        if (!despawned.ok) throw despawned.error;
        throw fallback.error;
      }
      fallbackCamera = fallback.value;
    }
  } else {
    if (input.openResourcePreview === undefined) {
      throw new Error(
        `Engine App workspace preview does not support asset kind ${input.asset.kind}; provide the Engine type-preview capability on the project session`,
      );
    }
    resourceOwner = await input.openResourcePreview({
      app: input.app,
      assets: input.assets,
      asset: input.asset,
      ...(input.project === undefined ? {} : { project: input.project }),
      target: input.target,
    });
    if (resourceOwner === null || typeof resourceOwner !== 'object') {
      throw new TypeError('Engine workspace type-preview owner must return a resource owner');
    }
    assetBinding = resourceOwner.assetBinding;
  }
  const authoring = createWorkspaceAssetAuthoring({
    assets: input.assets,
    world: input.app.world,
    ...(sceneRoot === undefined
      ? {}
      : {
          scene: {
            guid: input.asset.guid,
            sourceKey:
              input.asset.sourceKey ?? input.assets.catalogEntry(input.asset.guid)?.sourceKey ?? '',
            get root() {
              if (sceneRoot === undefined) throw new Error('Author scene preview has retired');
              return sceneRoot;
            },
            get asset() {
              return loadedScene;
            },
          },
        }),
  });
  const target = createEngineWorkspaceAppTarget({
    ...input,
    async close(value) {
      let failure: unknown;
      authoring.close();
      try {
        if (sceneRoot !== undefined) {
          worldDespawnScene(input.app.world, sceneRoot).unwrap();
          sceneRoot = undefined;
        }
      } catch (error) {
        failure = error;
      }
      try {
        if (fallbackCamera !== undefined) {
          input.app.world.despawn(fallbackCamera).unwrap();
          fallbackCamera = undefined;
        }
      } catch (error) {
        failure ??= error;
      }
      try {
        await resourceOwner?.close?.();
        resourceOwner = undefined;
      } catch (error) {
        failure ??= error;
      }
      try {
        await input.close?.(value);
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    },
  });
  const targetTools = target.tools;
  return {
    ...target,
    writeAssetField: authoring.write,
    ...(targetTools === undefined
      ? {}
      : {
          tools: {
            ...targetTools,
            async inspect(request) {
              const result = await targetTools.inspect(request);
              const ref =
                sceneRoot === undefined
                  ? undefined
                  : worldSceneEntityAddressOf(input.app.world, sceneRoot, result.entity);
              const address =
                ref && (typeof ref.address === 'string' ? [ref.address] : ref.address);
              const mount = address?.[0];
              const fieldPaths =
                mount === undefined || !address || address.length < 2
                  ? undefined
                  : loadedScene?.entities[mount]?.instance?.overrides?.flatMap((override, index) =>
                      JSON.stringify(override.target) !== JSON.stringify(address.slice(1))
                        ? []
                        : Object.entries(override.components).flatMap(([component, fields]) =>
                            Object.keys(fields ?? {}).map((field) => ({
                              component,
                              field,
                              path: [
                                'entities',
                                mount,
                                'instance',
                                'overrides',
                                String(index),
                                'components',
                                component,
                                field,
                              ],
                            })),
                          ),
                    );
              return ref && input.asset.path
                ? {
                    ...result,
                    source: {
                      guid: input.asset.guid,
                      sourcePath: input.asset.path,
                      sourceKey: ref.sceneSourceKey,
                      address: ref.address,
                      ...(fieldPaths?.length ? { fieldPaths } : {}),
                    },
                  }
                : result;
            },
          },
        }),
    prepareAssetContent: authoring.prepare,
    async commitAssetContent(preparation, fields) {
      if (!isScriptablePackAssetKind(input.asset.kind))
        throw new TypeError('Unsupported author asset kind');
      let nextRoot: EntityHandle | undefined;
      let nextScene: SceneAsset | undefined;
      let nextBinding: EngineWorkspaceAssetBinding | undefined;
      authoring.commit(preparation, fields, (handles) => {
        const handle = handles.get(input.asset.guid.toLowerCase());
        if (handle === undefined)
          throw new Error('Generated Pack no longer contains this preview output');
        nextBinding = captureEngineWorkspaceAssetBinding(input.assets, handle);
        if (input.asset.kind === 'scene') {
          nextScene = input.assets.read(handle as AssetHandle<'scene'>).unwrap();
          // Existing scene spawning owns validation and failed-spawn cleanup.
          // Reject the candidate before publishing any sibling asset replacement.
          nextRoot = input.assets
            .instantiate(handle as AssetHandle<'scene'>, input.app.world)
            .unwrap();
        }
      });
      if (nextRoot !== undefined) {
        if (sceneRoot !== undefined) worldDespawnScene(input.app.world, sceneRoot).unwrap();
        sceneRoot = nextRoot;
        loadedScene = nextScene;
        if (fallbackCamera !== undefined) {
          querySpans: for (const querySpan of input.app.world
            .query({ with: [Camera] })
            .unwrap()
            .spans()
            .unwrap()) {
            const queryEntities = querySpan.entities;
            for (let queryIndex = 0; queryIndex < querySpan.length; queryIndex++) {
              const queriedEntity = queryEntities[queryIndex] as EntityHandle;

              if (queriedEntity === fallbackCamera) continue;
              input.app.world.despawn(fallbackCamera).unwrap();
              fallbackCamera = undefined;
              break querySpans;
            }
          }
        }
        fallbackCamera ??= ensureFallbackCamera(
          input.app.world,
          input.target.width / Math.max(1, input.target.height),
        )?.unwrap();
      }
      assetBinding = nextBinding;
    },
    get target() {
      return target.target;
    },
    asset: input.asset,
    ...resourcePreviewControls(resourceOwner),
    get assetBinding() {
      return assetBinding;
    },
    get scene() {
      return loadedScene;
    },
    handle: {
      app: input.app,
      world: input.app.world,
      get sceneRoot() {
        return sceneRoot;
      },
    },
  };
}

/** Camera transactions and tool access for an existing App; never instantiates a second scene. */
export function createEngineWorkspaceAppTarget(
  input: EngineWorkspaceAppTargetOptions,
): EngineWorkspacePreview {
  assertTarget(input.target);
  if (!input.app.observation)
    throw new Error('Engine App observation is required for a workspace target');
  let version = 0;
  let currentTarget = input.target;
  let active:
    | {
        readonly interactionId: string;
        readonly clientId: string;
        readonly connectionId?: string;
        readonly baseVersion: number;
        readonly camera: unknown;
      }
    | undefined;
  const committedOperations = new Map<
    string,
    { readonly fingerprint: string; readonly result: unknown }
  >();
  const observation = input.app.observation;
  let closed = false;
  const defaultInput =
    input.applyInput === undefined
      ? createDefaultWorkspaceCameraInputController(
          observation,
          () => !closed && active !== undefined,
          input.app.world,
          `workspace-camera:${input.target.targetId}`,
        )
      : undefined;
  let cleanupPromise: Promise<void> | undefined;
  const assertOpen = (): void => {
    if (closed)
      throw new EngineWorkspaceError(
        'engine-workspace-preview-required',
        'Engine workspace preview is closed',
      );
  };
  const assertTargetInput = (value: { readonly targetId?: unknown }): void => {
    assertOpen();
    if (value.targetId !== input.target.targetId) {
      throw new Error(
        `Engine workspace target mismatch: expected ${input.target.targetId}, received ${String(value.targetId)}`,
      );
    }
  };
  const clientId = (value: EngineWorkspaceCameraInput): string => {
    if (typeof value.clientId !== 'string' || value.clientId.trim() === '') {
      throw new TypeError('Engine workspace camera interaction requires clientId');
    }
    return value.clientId;
  };
  const ownsInteraction = (value: EngineWorkspaceCameraInput): boolean =>
    active?.connectionId === undefined
      ? value.connectionId === undefined && active?.clientId === value.clientId
      : active.connectionId === value.connectionId;
  const cameraState = (): unknown => ({
    ...record(observation.camera.get()),
    ...(defaultInput ? { pivot: defaultInput.pivot ?? null } : {}),
  });
  const setCamera = (value: unknown): void => {
    observation.camera.set(value);
    const patch = record(value);
    if (patch && 'pivot' in patch) defaultInput?.setPivot(patch.pivot);
  };
  const camera = (): EngineWorkspaceCameraResult => {
    assertOpen();
    return {
      camera: cameraState(),
      version,
      committed: active === undefined,
      interaction: active
        ? {
            interactionId: active.interactionId,
            clientId: active.clientId,
            baseVersion: active.baseVersion,
          }
        : null,
    };
  };
  const close = async (value: { readonly targetId?: string } = {}): Promise<void> => {
    if (value.targetId !== undefined && value.targetId !== input.target.targetId) {
      throw new Error(
        `Engine workspace target mismatch: expected ${input.target.targetId}, received ${value.targetId}`,
      );
    }
    if (cleanupPromise !== undefined) return cleanupPromise;
    closed = true;
    active = undefined;
    cleanupPromise = (async () => {
      let failure: unknown;
      try {
        defaultInput?.dispose();
      } catch (error) {
        failure = error;
      }
      try {
        observation.release?.();
      } catch (error) {
        failure ??= error;
      }
      try {
        await Promise.resolve(input.close?.({ targetId: input.target.targetId }));
      } catch (error) {
        failure ??= error;
      }
      if (failure !== undefined) throw failure;
    })().catch((error) => {
      cleanupPromise = undefined;
      throw error;
    });
    return cleanupPromise;
  };
  const resize = input.resize;
  const tools = input.tools;
  const control = tools?.control;
  const pick = tools?.pick;
  const highlight = tools?.highlight;
  const preview: EngineWorkspacePreview = {
    get target() {
      return currentTarget;
    },
    ...(resize
      ? {
          async resize(value: Parameters<NonNullable<EngineWorkspacePreview['resize']>>[0]) {
            assertTargetInput(value);
            value.signal?.throwIfAborted();
            if (
              ![value.width, value.height].every((size) => Number.isSafeInteger(size) && size > 0)
            )
              throw new TypeError('Workspace resize requires positive integer output pixels');
            if (active)
              throw new EngineWorkspaceError(
                'engine-workspace-target-busy',
                'Finish the camera interaction before resizing',
              );
            await resize(value);
            assertOpen();
            currentTarget = { ...currentTarget, width: value.width, height: value.height };
            return currentTarget;
          },
        }
      : {}),
    ...(control
      ? {
          setControl(value: EngineWorkspaceCameraInput & { mode: 'player' | 'observer' }) {
            assertTargetInput(value);
            if (active)
              throw new EngineWorkspaceError(
                'engine-workspace-target-busy',
                'Finish the camera interaction before changing control',
              );
            defaultInput?.reset();
            const result = control.set(value);
            version += 1;
            return result;
          },
        }
      : {}),
    ...(tools === undefined
      ? {}
      : {
          tools: {
            ...(pick
              ? {
                  pick: (value: { x: number; y: number }) => {
                    assertOpen();
                    return pick(value);
                  },
                }
              : {}),
            ...(highlight
              ? {
                  highlight: (value: { entityId?: string }) => {
                    assertOpen();
                    return highlight(value);
                  },
                }
              : {}),
            tree: (value) => {
              assertOpen();
              return tools.tree(value);
            },
            inspect: (value) => {
              assertOpen();
              return tools.inspect(value);
            },
            async focus(value) {
              assertOpen();
              if (active !== undefined)
                throw new EngineWorkspaceError(
                  'engine-workspace-target-busy',
                  'The camera interaction must finish before focus',
                );
              const result = await tools.focus(value);
              assertOpen();
              defaultInput?.setPivot(record(result)?.pivot);
              version += 1;
              return result;
            },
          },
        }),
    ...(input.presentation === undefined ? {} : { presentation: input.presentation }),
    // Public operations live on `preview`; this is only the opaque resource
    // bundle a host may retain for diagnostics or renderer integration.
    handle: {
      app: input.app,
      world: input.app.world,
    },
    ...(input.capture === undefined
      ? {}
      : {
          capture: async (value: {
            readonly targetId: string;
            readonly signal?: AbortSignal;
            readonly width?: number;
            readonly height?: number;
          }) => {
            assertTargetInput(value);
            if (active !== undefined)
              throw new EngineWorkspaceError(
                'engine-workspace-target-busy',
                'Engine workspace preview capture is busy',
              );
            return input.capture?.(value);
          },
        }),
    close,
    getCamera(value) {
      assertTargetInput(value);
      return camera();
    },
    async beginCameraInteraction(value) {
      assertTargetInput(value);
      abortError(value.signal);
      if (tools?.control?.mode() === 'player')
        throw new EngineWorkspaceError(
          'engine-workspace-control-required',
          'Eject before controlling the game camera',
        );
      const id = clientId(value);
      if (active !== undefined)
        throw new EngineWorkspaceError(
          'engine-workspace-target-busy',
          'Engine workspace camera interaction is busy',
        );
      if (value.baseVersion !== undefined && value.baseVersion !== version) {
        throw new EngineWorkspaceError(
          'engine-workspace-camera-conflict',
          'Engine workspace camera version conflict',
        );
      }
      const interactionId = value.interactionId;
      if (typeof interactionId !== 'string' || interactionId.trim() === '') {
        throw new TypeError('Engine workspace camera interaction requires interactionId');
      }
      const nextInteraction = {
        interactionId,
        baseVersion: version,
        camera: cameraState(),
        clientId: id,
        ...(value.connectionId === undefined ? {} : { connectionId: value.connectionId }),
      };
      active = nextInteraction;
      return { ...camera(), interactionId };
    },
    async updateCameraDraft(value) {
      assertTargetInput(value);
      abortError(value.signal);
      clientId(value);
      const interaction = active;
      if (interaction === undefined || interaction.interactionId !== value.interactionId) {
        throw new EngineWorkspaceError(
          'engine-workspace-camera-interaction-missing',
          'Engine workspace camera interaction is missing',
        );
      }
      if (!ownsInteraction(value))
        throw new EngineWorkspaceError(
          'engine-workspace-unauthorized',
          'Engine workspace camera interaction owner mismatch',
        );
      if (value.camera !== undefined) setCamera(value.camera);
      else if (value.input !== undefined) {
        const applyInput = input.applyInput ?? defaultInput?.apply;
        if (applyInput === undefined) {
          throw new Error('Engine workspace preview does not provide camera input');
        }
        await applyInput({
          ...value,
          world: input.app.world,
          app: input.app,
        });
      }
      return camera();
    },
    async commitCamera(value) {
      assertTargetInput(value);
      abortError(value.signal);
      const id = clientId(value);
      if (typeof value.operationId !== 'string' || value.operationId.trim() === '') {
        throw new TypeError('Engine workspace camera commit requires operationId');
      }
      const expectedVersion = value.expectedVersion;
      if (
        typeof expectedVersion !== 'number' ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0
      ) {
        throw new TypeError('Engine workspace camera commit requires expectedVersion');
      }
      const operationKey = JSON.stringify([
        value.connectionId ?? null,
        id,
        input.target.targetId,
        value.operationId,
      ]);
      const fingerprint = JSON.stringify({
        targetId: input.target.targetId,
        interactionId: value.interactionId,
        expectedVersion,
        camera: value.camera,
      });
      const previous = committedOperations.get(operationKey);
      if (previous !== undefined) {
        if (previous.fingerprint !== fingerprint) {
          throw new EngineWorkspaceError(
            'engine-workspace-operation-conflict',
            'Engine workspace camera operation payload conflict',
          );
        }
        return structuredClone(previous.result);
      }
      const interaction = active;
      if (interaction === undefined || interaction.interactionId !== value.interactionId) {
        throw new EngineWorkspaceError(
          'engine-workspace-camera-interaction-missing',
          'Engine workspace camera interaction is missing',
        );
      }
      if (!ownsInteraction(value))
        throw new EngineWorkspaceError(
          'engine-workspace-unauthorized',
          'Engine workspace camera interaction owner mismatch',
        );
      if (expectedVersion !== version)
        throw new EngineWorkspaceError(
          'engine-workspace-camera-conflict',
          'Engine workspace camera version conflict',
        );
      if (value.camera !== undefined) setCamera(value.camera);
      version += 1;
      defaultInput?.reset();
      active = undefined;
      const result = { ...camera(), operationId: value.operationId, committed: true };
      committedOperations.set(operationKey, { fingerprint, result: structuredClone(result) });
      return result;
    },
    async abortCameraInteraction(value) {
      assertTargetInput(value);
      clientId(value);
      const interaction = active;
      if (interaction === undefined || interaction.interactionId !== value.interactionId)
        return camera();
      if (!ownsInteraction(value))
        throw new EngineWorkspaceError(
          'engine-workspace-unauthorized',
          'Engine workspace camera interaction owner mismatch',
        );
      setCamera(interaction.camera);
      defaultInput?.reset();
      active = undefined;
      return camera();
    },
    async revokeConnection(value) {
      assertTargetInput(value);
      const interaction = active;
      if (interaction?.connectionId === value.connectionId)
        await preview.abortCameraInteraction?.({
          targetId: input.target.targetId,
          interactionId: interaction.interactionId,
          clientId: interaction.clientId,
          connectionId: value.connectionId,
          reason: 'client-disconnected',
        });
      tools?.control?.revoke(value.connectionId);
      return camera();
    },
  };
  return preview;
}

/**
 * Public Cordis plugin seam. A host assembles one runtime and provides it to
 * consumers; no global registry or second lifecycle is introduced.
 */
export function engineWorkspacePlugin(runtime: EngineWorkspaceRuntime): Plugin {
  if (!runtime || runtime.apiVersion !== ENGINE_WORKSPACE_API_VERSION) {
    throw new TypeError('engine workspace plugin requires a matching runtime');
  }
  return {
    name: ENGINE_WORKSPACE_PLUGIN_ID,
    provide: ['engineWorkspace'],
    apply(ctx) {
      ctx.provide('engineWorkspace', runtime);
      ctx.effect(() => async () => runtime.dispose(), 'engine/workspace');
    },
  };
}

/** Bounded inspection facts from the current Registry payload, without transporting buffers. */
export async function inspectEngineWorkspaceAsset(
  assets: AssetRegistry,
  guid: string,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  const entries =
    assets.catalogSnapshot() === undefined ? undefined : (await assets.enumerateCatalog()).unwrap();
  signal?.throwIfAborted();
  const entry = entries?.find((entry) => String(entry.guid) === guid);
  if (entries && !entry)
    throw new EngineWorkspaceError('asset-not-found', 'The GUID in the current project catalog');
  const identity = entry
    ? {
        guid,
        asset: projectEngineWorkspaceAssets([entry])[0],
        source: {
          path: entry.sourcePath,
          ...(entry.publication === undefined
            ? {}
            : { publication: structuredClone(entry.publication) }),
        },
        ...(entry.publication === undefined
          ? {}
          : { publication: structuredClone(entry.publication) }),
      }
    : undefined;
  // Neutral catalog kinds remain inspectable even without a runtime loader.
  const kind = entry?.kind ?? 'mesh';
  if (kind !== 'mesh' && kind !== 'material' && kind !== 'texture' && kind !== 'equirect')
    return identity;
  const handle = (await assets.load(guid, kind, signal === undefined ? {} : { signal })).unwrap();
  try {
    signal?.throwIfAborted();
    return {
      ...(identity ?? { guid, asset: { guid, kind } }),
      ...captureEngineWorkspaceAssetBinding(assets, handle),
    };
  } finally {
    assets.release(handle);
  }
}

/** Runtime content and its adopted provenance come from the same asset owner. */
export function captureEngineWorkspaceAssetBinding(
  assets: AssetRegistry,
  handle: AssetHandle,
): EngineWorkspaceAssetBinding {
  const payload = assets.read(handle as AssetHandle<Asset['kind']>).unwrap();
  const source = assets.source(handle).unwrap();
  const meta = workspaceAssetFacts(payload);
  return {
    ...(source?.publication === undefined
      ? {}
      : { publication: structuredClone(source.publication) }),
    ...(meta === undefined ? {} : { meta }),
  };
}

/** Convert Engine catalog entries into the consumer-neutral asset projection. */
export function projectEngineWorkspaceAssets(
  entries: readonly CatalogEntry[],
): EngineWorkspaceAsset[] {
  return entries.map((entry) => {
    const kind = workspaceAssetKind(String(entry.kind));
    return {
      guid: String(entry.guid),
      kind,
      ...(entry.name === undefined ? {} : { name: String(entry.name) }),
      ...(entry.sourceKey === undefined ? {} : { sourceKey: String(entry.sourceKey) }),
      ...(entry.packageId === undefined ? {} : { packageId: String(entry.packageId) }),
      ...(entry.lifecycle === undefined ? {} : { lifecycle: entry.lifecycle }),
      path: String(entry.sourcePath),
      previewable: (ENGINE_WORKSPACE_PREVIEWABLE_KINDS as readonly string[]).includes(kind),
    };
  });
}
