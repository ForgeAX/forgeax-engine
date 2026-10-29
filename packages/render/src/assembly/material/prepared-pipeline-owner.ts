import {
  err,
  type PipelineLayout,
  type PipelineRecipeState,
  type RenderPipeline,
  type RenderPipelineDescriptor,
  type Result,
  type RhiDevice,
  RhiError,
  type ShaderModule,
} from '@forgeax/engine-rhi';
import type { ShaderSource } from '@forgeax/engine-types';

type Flight = {
  readonly source: string | ShaderSource;
  readonly layout: RenderPipelineDescriptor['layout'];
  readonly state?: PipelineRecipeState;
  readonly vertex?: ShaderModule;
  readonly fragment?: ShaderModule;
  result?: Result<RenderPipeline, RhiError>;
};

/** Only a completed backend result can be consumed by the existing PSO publication owner. */
export class PreparedRenderPipelineOwner {
  private readonly flights = new Map<string, Flight>();
  private readonly pending = err(
    new RhiError({
      code: 'rhi-not-available',
      expected: 'render pipeline compilation to finish',
      hint: 'retry the same generation-owned PSO request after backend completion',
    }),
  );

  constructor(
    private readonly device: RhiDevice,
    private readonly isAlive: () => boolean,
    private readonly onStart: () => void = () => undefined,
  ) {}

  isPending(result: Result<RenderPipeline, RhiError>): boolean {
    return result === this.pending;
  }

  has(key: string): boolean {
    return this.flights.has(key);
  }

  lookup(
    key: string,
    source: string | ShaderSource,
    layout: RenderPipelineDescriptor['layout'],
  ): Result<RenderPipeline, RhiError> | undefined {
    if (!this.isAlive()) {
      this.flights.clear();
      return this.pending;
    }
    const previous = this.flights.get(key);
    return previous !== undefined && previous.source === source && previous.layout === layout
      ? (previous.result ?? this.pending)
      : undefined;
  }

  requestState(
    key: string,
    source: string | ShaderSource,
    state: PipelineRecipeState,
    dependencies: { layout: PipelineLayout; vertex: ShaderModule; fragment?: ShaderModule },
    materialize: () => RenderPipelineDescriptor,
  ): Result<RenderPipeline, RhiError> {
    if (!this.isAlive()) {
      this.flights.clear();
      return this.pending;
    }
    const previous = this.flights.get(key);
    if (
      previous !== undefined &&
      previous.source === source &&
      previous.layout === dependencies.layout &&
      previous.state?.key === state.key &&
      previous.vertex === dependencies.vertex &&
      previous.fragment === dependencies.fragment
    )
      return this.isAlive() ? (previous.result ?? this.pending) : this.pending;
    this.flights.delete(key);
    const selected = this.device.pipelineLibrary?.selectRender?.(state, dependencies, true);
    if (selected === undefined)
      return this.requestStateMiss(key, source, state, dependencies, materialize);
    if ('ok' in selected) {
      if (selected.ok && selected.value === undefined)
        return this.requestStateMiss(key, source, state, dependencies, materialize);
      return selected as Result<RenderPipeline, RhiError>;
    }
    // A matching pending record owns the completion; do not materialize again.
    return this.observe(
      key,
      source,
      dependencies.layout,
      selected.then((result) => {
        if (result.ok && result.value === undefined)
          throw new Error('Selected pipeline disappeared');
        return result as Result<RenderPipeline, RhiError>;
      }),
      state,
      dependencies,
    );
  }

  private requestStateMiss(
    key: string,
    source: string | ShaderSource,
    state: PipelineRecipeState,
    dependencies: { layout: PipelineLayout; vertex: ShaderModule; fragment?: ShaderModule },
    materialize: () => RenderPipelineDescriptor,
  ): Result<RenderPipeline, RhiError> {
    if (!this.isAlive()) return this.pending;
    const result = this.request(key, source, materialize());
    const flight = this.flights.get(key);
    if (flight !== undefined)
      Object.assign(flight, {
        state,
        vertex: dependencies.vertex,
        fragment: dependencies.fragment,
      });
    return result;
  }

  request(
    key: string,
    source: string | ShaderSource,
    descriptor: RenderPipelineDescriptor,
  ): Result<RenderPipeline, RhiError> {
    const previous = this.lookup(key, source, descriptor.layout);
    if (previous !== undefined) return previous;
    const create = this.device.createRenderPipelineAsync;
    if (create === undefined) return this.device.createRenderPipeline(descriptor);
    this.onStart();
    try {
      return this.observe(key, source, descriptor.layout, create.call(this.device, descriptor));
    } catch (cause) {
      return this.observe(key, source, descriptor.layout, Promise.reject(cause));
    }
  }

  private observe(
    key: string,
    source: string | ShaderSource,
    layout: RenderPipelineDescriptor['layout'],
    completion: Result<RenderPipeline, RhiError> | Promise<Result<RenderPipeline, RhiError>>,
    state?: PipelineRecipeState,
    dependencies?: { vertex: ShaderModule; fragment?: ShaderModule },
  ): Result<RenderPipeline, RhiError> {
    const flight: Flight = {
      source,
      layout,
      ...(state === undefined ? {} : { state }),
      ...(dependencies ?? {}),
    };
    this.flights.set(key, flight);
    const complete = (result: Result<RenderPipeline, RhiError>): void => {
      if (this.isAlive() && this.flights.get(key) === flight) flight.result = result;
    };
    try {
      // forgeax-async-whitelist: dom-native - backend pipeline compilation completion.
      if ('ok' in completion) {
        complete(completion);
        return flight.result ?? this.pending;
      }
      void completion.then(complete, (cause: unknown) =>
        complete(
          err(
            cause instanceof RhiError
              ? cause
              : new RhiError({
                  code: 'webgpu-runtime-error',
                  expected: 'backend pipeline compilation to complete',
                  hint: cause instanceof Error ? cause.message : String(cause),
                }),
          ),
        ),
      );
    } catch (cause) {
      complete(
        err(
          cause instanceof RhiError
            ? cause
            : new RhiError({
                code: 'webgpu-runtime-error',
                expected: 'backend pipeline compilation to start',
                hint: cause instanceof Error ? cause.message : String(cause),
              }),
        ),
      );
    }
    return this.pending;
  }
}

export function preparedRenderPipelineOwner<State extends object>(
  owners: WeakMap<State, PreparedRenderPipelineOwner>,
  state: State,
  device: RhiDevice,
  scope: { isAlive(): boolean },
  onStart: () => void,
): PreparedRenderPipelineOwner {
  let owner = owners.get(state);
  if (owner === undefined) {
    owner = new PreparedRenderPipelineOwner(device, () => scope.isAlive(), onStart);
    owners.set(state, owner);
  }
  return owner;
}
