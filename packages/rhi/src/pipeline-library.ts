import type {
  ComputePipeline,
  PipelineLayout,
  RenderPipeline,
  Result,
  RhiError,
  ShaderModule,
} from './index';
import type { PipelineRecipeState } from './pipeline-recipe-state';

/** Portable creation recipes, never opaque handles or driver binaries. */
export type PipelineLibraryStage = Omit<GPUProgrammableStage, 'module'> & {
  readonly module: number;
};
export type PipelineLibraryRender = Omit<
  GPURenderPipelineDescriptor,
  'layout' | 'vertex' | 'fragment'
> & {
  readonly layout: number | 'auto';
  readonly vertex: PipelineLibraryStage & Pick<GPUVertexState, 'buffers'>;
  readonly fragment?: PipelineLibraryStage & Pick<GPUFragmentState, 'targets'>;
};
export type PipelineLibraryCompute = Omit<GPUComputePipelineDescriptor, 'layout' | 'compute'> & {
  readonly layout: number | 'auto';
  readonly compute: PipelineLibraryStage;
};

/**
 * Preparation compiles recipes in manifest position order across both tables
 * (render 0, compute 0, render 1, ...): a producer places the recipes it needs
 * first at the front of each table.
 */
export interface PipelineLibraryManifest {
  readonly version: 1;
  readonly backend: 'webgpu';
  readonly shaders: readonly GPUShaderModuleDescriptor[];
  readonly bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[];
  readonly pipelineLayouts: readonly (readonly number[])[];
  readonly renderPipelines: readonly PipelineLibraryRender[];
  readonly computePipelines: readonly PipelineLibraryCompute[];
  /** Build-projected entry closures. Ordinary requests retain their original source identity. */
  readonly computeEntryModules?: readonly {
    readonly module: number;
    readonly entryPoint: string;
    readonly specializedModule: number;
  }[];
}

export interface PipelineLibraryInspection {
  readonly state: 'active' | 'disposed';
  readonly shaders: number;
  readonly renderPipelines: number;
  readonly computePipelines: number;
  readonly shaderHits: number;
  readonly pipelineHits: number;
  readonly synchronousCreations: number;
  readonly asynchronousCreations: number;
  readonly compilationCompleted: number;
  readonly compilationPending: number;
  readonly failures: number;
  readonly unrecordable: number;
  readonly overflow: number;
  readonly sourceBytes: number;
  /** Bounded device-local history of runtime-demanded native requests, including
   * requests completed before an asynchronous inspection reaches the device.
   * Missing means unsupported; overwritten or null pipelines mean incomplete evidence.
   * Timestamps share this library's performance clock, not the caller's realm. */
  readonly runtimeRequests?: {
    readonly libraryId: number;
    readonly capacity: number;
    readonly overwritten: number;
    readonly latestSequence: number;
    readonly observedAtMs: number;
    readonly requests: readonly {
      readonly sequence: number;
      readonly mode: 'sync' | 'async';
      readonly kind: 'render' | 'compute';
      readonly label: string | null;
      readonly origin: 'runtime' | 'startup-warmup' | 'background-warmup';
      readonly preloadAtDemand:
        | 'startup'
        | 'background'
        | 'both'
        | 'absent'
        | 'indexing'
        | 'unavailable';
      readonly requestedAtMs: number;
      readonly demandedAtMs: number;
      readonly startedAtMs: number | null;
      readonly completedAtMs: number | null;
      /** A synchronous returned handle does not prove native compilation completion. */
      readonly outcome: 'pending' | 'completed' | 'failed' | 'returned';
      /** Existing descriptors only; uncached source/semantic digests remain null.
       * History inspection never hashes WGSL. localIdentity is unique in this library. */
      readonly pipeline: {
        readonly localIdentity: number;
        readonly identity: string | null;
        readonly kind: 'render' | 'compute';
        readonly preload: 'startup' | 'background' | 'both' | 'absent' | 'indexing';
        readonly recipe: PipelineLibraryRender | PipelineLibraryCompute;
        readonly shaders: readonly {
          readonly module: number;
          readonly label: string | null;
          readonly sourceDigest: string | null;
        }[];
        readonly bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[] | 'auto';
      } | null;
    }[];
  };
  /** Current scheduled/native compilations, not a coverage verdict or completed history.
   * Explicit runtimeRequests inspection omits this potentially hashing full snapshot. */
  readonly pending?: {
    /** Requests whose opaque dependencies or capacity prevented recipe recording. */
    readonly unidentified: number;
    readonly pipelines: readonly {
      /** Label-independent SHA-256 of shader sources, layouts and complete recipe state. */
      readonly identity: string;
      readonly kind: 'render' | 'compute';
      readonly origin: 'runtime' | 'startup-warmup' | 'background-warmup';
      /** Exact recipe membership in the libraries supplied to this device. */
      readonly preload: 'startup' | 'background' | 'both' | 'absent' | 'indexing';
      readonly stage: 'queued' | 'compiling';
      readonly elapsedMs: number;
      readonly recipe: PipelineLibraryRender | PipelineLibraryCompute;
      readonly shaders: readonly {
        readonly module: number;
        readonly label: string | null;
        readonly sourceDigest: string;
      }[];
      readonly bindGroupLayouts: readonly GPUBindGroupLayoutDescriptor[] | 'auto';
    }[];
  };
  readonly warmup: {
    readonly requested: number;
    readonly completed: number;
    readonly failed: number;
    /** Cumulative prepare wall time, including failed attempts; not summed GPU pass time. */
    readonly elapsedMs: number;
  };
  /**
   * Non-blocking lane started after renderer readiness. Each completed entry is
   * a library hit immediately; a failed entry compiles on first use as before.
   */
  readonly backgroundWarmup: {
    readonly requested: number;
    readonly completed: number;
    readonly failed: number;
    /** Cumulative background prepare wall time, including failed attempts. */
    readonly elapsedMs: number;
    readonly state: 'idle' | 'running' | 'done' | 'failed';
  };
}

export interface PipelineLibraryPrepareOptions {
  /** Existing generation/roster owner; retention ends with this object. */
  readonly owner?: object;
  readonly inputLimits?: PipelineLibraryLimits;
  /** Already admitted CPU source owners, in manifest module order. */
  readonly sources?: readonly import('@forgeax/engine-types').ShaderSource[];
  /** Outstanding native compilations: background 1..4, blocking 1..16; backend default otherwise. */
  readonly concurrency?: number;
  /** Account the request on the background lane instead of the blocking startup warmup. */
  readonly background?: boolean;
}

/**
 * One physical device owns its library; initialization awaits the startup
 * prepare before drawing, and a background prepare may run after readiness.
 */
export interface PipelineLibrary {
  /** Diagnostic route scope: retain the current graph and subsequent records until disposal. */
  collect?(): { dispose(): void };
  /** @internal Borrow a previously admitted state using a lazy final-state projection. */
  findRenderState?(
    dependencies: {
      readonly layout: PipelineLayout | 'auto';
      readonly vertex: ShaderModule;
      readonly fragment?: ShaderModule;
    },
    matches: (state: PipelineRecipeState) => boolean,
  ): PipelineRecipeState | undefined;
  /** @internal Query the existing record before materializing a native descriptor. */
  selectRender?(
    state: PipelineRecipeState,
    dependencies: {
      readonly layout: PipelineLayout | 'auto';
      readonly vertex: ShaderModule;
      readonly fragment?: ShaderModule;
    },
    completed: boolean,
  ):
    | Result<RenderPipeline | undefined, RhiError>
    | Promise<Result<RenderPipeline | undefined, RhiError>>;
  /** @internal Compute entry projection is applied before the same record query. */
  selectCompute?(
    state: PipelineRecipeState,
    dependencies: { readonly layout: PipelineLayout | 'auto'; readonly compute: ShaderModule },
    completed: boolean,
  ):
    | Result<ComputePipeline | undefined, RhiError>
    | Promise<Result<ComputePipeline | undefined, RhiError>>;
  inspect(options?: { readonly runtimeRequests?: boolean }): PipelineLibraryInspection;
  export(limits?: PipelineLibraryLimits): Result<PipelineLibraryManifest, RhiError>;
  prepare(
    manifest: PipelineLibraryManifest,
    options?: PipelineLibraryPrepareOptions,
  ): Promise<Result<PipelineLibraryInspection, RhiError>>;
}

/** Limits for one input/export action, never a device resource capacity. */
export interface PipelineLibraryLimits {
  readonly outputBytes?: number;
  readonly temporaryBytes?: number;
  readonly entries?: number;
}

/** Default finite policy shared by import, export and transport receipts. */
export const PIPELINE_LIBRARY_LIMITS = Object.freeze({
  outputBytes: 512 * 1024 * 1024,
  temporaryBytes: 4 * 1024 * 1024 * 1024,
  entries: 65_536,
});
