import {
  err,
  type RenderPipeline,
  type RenderPipelineDescriptor,
  type Result,
  type RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';

type Flight = {
  readonly source: string;
  readonly layout: RenderPipelineDescriptor['layout'];
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

  has(key: string): boolean {
    return this.flights.has(key);
  }

  lookup(
    key: string,
    source: string,
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

  request(
    key: string,
    source: string,
    descriptor: RenderPipelineDescriptor,
  ): Result<RenderPipeline, RhiError> {
    const previous = this.lookup(key, source, descriptor.layout);
    if (previous !== undefined) return previous;
    const create = this.device.createRenderPipelineAsync;
    if (create === undefined) return this.device.createRenderPipeline(descriptor);
    const flight: Flight = { source, layout: descriptor.layout };
    this.flights.set(key, flight);
    this.onStart();
    const complete = (result: Result<RenderPipeline, RhiError>): void => {
      if (this.isAlive() && this.flights.get(key) === flight) flight.result = result;
    };
    try {
      // forgeax-async-whitelist: dom-native - backend pipeline compilation completion.
      void create.call(this.device, descriptor).then(complete, (cause: unknown) =>
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
