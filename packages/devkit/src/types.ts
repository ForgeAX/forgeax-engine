import type { AnimationPlaybackOptions } from '@forgeax/engine-animation';
import type { GameProjectRoots } from '@forgeax/engine-project';
import type { ArtifactRef, JsonValue, ToolRuntimeError } from '@forgeax/engine-tool-runtime';
import type { BrowserCarrierAdapter, BrowserCarrierRunIdentity } from './tools/display-carrier.js';

/** Physical preview root that a browser host boots. */
export type BootstrapRoot = 'project-bootstrap' | 'resource-bootstrap';

export interface CommandError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type CommandResult<T> =
  | { readonly ok: true; readonly value: T; readonly artifacts?: readonly ArtifactRef[] }
  | {
      readonly ok: false;
      readonly error: CommandError;
      readonly artifacts?: readonly ArtifactRef[];
    };

/** Keep command errors as plain, serializable protocol results. */
export function failCommand<Code extends string, Detail extends Readonly<Record<string, unknown>>>(
  code: Code,
  expected: string,
  hint: string,
  detail?: Detail,
) {
  return {
    ok: false,
    error: { code, expected, hint, detail: detail === undefined ? {} : detail },
  } as const;
}

export function rejectCommand<Failure>(error: Failure) {
  return { ok: false, error } as const;
}

export function completeCommand<Value>(value: Value) {
  return { ok: true, value } as const;
}

export function toolCommandValue<T>(result: CommandResult<T>) {
  return result.ok
    ? result.value
    : rejectCommand({ ...result.error, detail: result.error.detail as unknown as JsonValue });
}

export function failToolRun(failure: ToolRuntimeError, artifacts: readonly ArtifactRef[]) {
  return { outcome: 'failed', failure, artifacts } as const;
}

/** One forge.json `assetLibraries` entry and the read-only asset directory it mounts. */
export interface ProjectAssetLibrary {
  readonly specifier: string;
  readonly root: string;
}

export interface ProjectFacts {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly roots: GameProjectRoots;
  readonly startupTimeoutMs?: number | null;
  readonly frameTimeoutMs?: number | null;
  /** `package.json#forgeax.pointShadows`: build Standard shaders with the point-shadow lane. */
  readonly pointShadows?: true;
  /** Source templates are the default; compiled explicitly requests precomposed programs. */
  readonly shaderPublication?: 'compiled' | 'source';
  readonly assetRoots: readonly string[];
  readonly assetLibraries: readonly ProjectAssetLibrary[];
  readonly packageJson: Readonly<Record<string, unknown>>;
}

export interface ProjectCommandOptions {
  readonly root?: string;
  readonly json?: boolean;
  readonly port?: number;
  /** Opt in to including the viewport debug output visualizer. Default false. */
  readonly viewportDebugView?: boolean;
}

export interface PreviewOptions extends ProjectCommandOptions {
  /** Verify and serve this exact distribution instead of the diagnostic dist. */
  readonly dist?: string;
}

export interface ProjectPortOptions {
  readonly port: number;
  readonly strictPort: boolean;
}

export function resolveProjectPort(port: number | undefined): ProjectPortOptions {
  return { port: port ?? 5173, strictPort: port !== 0 };
}

export interface InitOptions extends ProjectCommandOptions {
  readonly dryRun?: boolean;
  readonly install?: boolean;
}

export interface NewOptions extends ProjectCommandOptions {
  readonly dryRun?: boolean;
  readonly template?: string;
  /** Override the generated project id; defaults to the target directory basename. */
  readonly id?: string;
  /** Override the generated display name; defaults to the generated id. */
  readonly name?: string;
  /** Override the generated npm package name; defaults to the template namespace plus id. */
  readonly packageName?: string;
}

export interface BuildOptions extends ProjectCommandOptions {
  /** Project-relative HTML head fragment included before distribution sealing. */
  readonly htmlHead?: string;
  /** Validation-only storage-capable WebGPU raster programs; omitted publishes portable variants. */
  readonly materialProfile?: 'webgpu-storage';
  readonly target?: 'browser' | 'wechat' | 'tauri' | 'native';
  /** Native addon destination. Defaults to the current build machine. */
  readonly platform?: 'windows' | 'macos' | 'linux';
  readonly arch?: 'x64' | 'arm64';
  /** WeChat application identity; omitted opens the developer-tool tourist project. */
  readonly appid?: string;
  readonly base?: string;
  readonly outDir?: string;
  /** Forward the existing App animation policy into the generated runtime. */
  readonly animation?: AnimationPlaybackOptions;
  /** Emit source maps as build artifacts without adding browser map requests. */
  readonly sourcemap?: 'hidden';
}

export interface PackageOptions extends ProjectCommandOptions {
  readonly output?: string;
  readonly format?: PackageFormat;
  /** Destination platform. Native packages support Windows x64 and macOS arm64. */
  readonly platform?: TauriPlatform;
  readonly arch?: 'x64' | 'arm64';
  readonly publisher?: string;
  readonly version?: string;
  readonly channel?: string;
  readonly nodeDist?: string;
  readonly vcRuntime?: string;
  readonly signThumbprint?: string;
  readonly signStore?: 'user' | 'machine';
  readonly timestampUrl?: string;
  readonly bundleId?: string;
  readonly signIdentity?: string;
  readonly notaryKeychainProfile?: string;
  /** Export the Tauri project without installing or invoking native toolchains. */
  readonly prepareOnly?: boolean;
  /** Store large Web ZIP JSON documents zstd-compressed; `false` keeps plain JSON. Defaults to true. */
  readonly compress?: boolean;
}

export type PackageFormat = 'web-zip' | 'single-html' | 'tauri' | 'native';
export type TauriPlatform = 'windows' | 'macos' | 'linux' | 'android' | 'ios';

export type CaptureBackend = 'auto' | 'software' | 'hardware';
/** Adapter lane observed in the browser; `unknown` when no adapter is reported. */
export type CaptureBackendObserved = Exclude<CaptureBackend, 'auto'> | 'unknown';

export interface BrowserCaptureOptions extends ProjectCommandOptions {
  /** Prefer a rendering lane, or let the browser choose and report it. */
  readonly backend?: CaptureBackend;
  readonly output?: string;
  readonly browser?: string;
  readonly width?: number;
  readonly height?: number;
  readonly waitMs?: number;
  readonly requireUi?: boolean;
  readonly deterministic?: boolean;
  readonly headless?: boolean;
  /**
   * Existing browser-page owner for an eligible headed run. The owner keeps
   * the Page alive; DevKit only borrows and releases its exact lease.
   */
  readonly carrier?: BrowserCarrierAdapter;
  readonly carrierRun?: BrowserCarrierRunIdentity;
  readonly carrierGeneration?: number;
}

export interface AssetAddOptions extends ProjectCommandOptions {
  readonly path: string;
  readonly dryRun?: boolean;
}

export interface AssetListOptions extends ProjectCommandOptions {
  /** Filter by the producer-declared asset kind (for example `mesh`). */
  readonly type?: string;
  /** Maximum number of rows in one response. */
  readonly limit?: number;
  /** Opaque numeric continuation cursor returned by the previous page. */
  readonly cursor?: string;
}

export interface AssetInspectOptions extends ProjectCommandOptions {
  readonly catalog?: string;
  readonly parametersOnly?: boolean;
  readonly subject: string;
  /** Select one output when subject is a Pack source path. */
  readonly sourceKey?: string;
}

export interface AssetResolveOptions extends ProjectCommandOptions {
  readonly subject?: string;
  readonly packageId?: string;
  readonly sourceKey?: string;
  readonly require?: 'identity' | 'present' | 'ready';
  readonly requestId?: string;
}

export interface ShaderCheckOptions extends ProjectCommandOptions {
  readonly path?: string;
}

export interface PluginCreateOptions extends ProjectCommandOptions {
  readonly path: string;
  readonly module?: string;
  readonly export?: string;
  readonly packageId?: string;
  readonly sourceKey?: string;
  readonly config?: unknown;
  readonly dryRun?: boolean;
}
export interface PluginInspectOptions extends ProjectCommandOptions {
  readonly guid?: string;
}
export interface PluginRootOptions extends ProjectCommandOptions {
  readonly realm: keyof GameProjectRoots;
  readonly guid: string | null;
  readonly dryRun?: boolean;
}
