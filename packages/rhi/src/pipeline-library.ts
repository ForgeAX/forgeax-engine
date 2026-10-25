import type { Result, RhiError } from './index';

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
  inspect(): PipelineLibraryInspection;
  export(): Result<PipelineLibraryManifest, RhiError>;
  prepare(
    manifest: PipelineLibraryManifest,
    options?: PipelineLibraryPrepareOptions,
  ): Promise<Result<PipelineLibraryInspection, RhiError>>;
}
