import {
  appendPluginPackCleanup,
  createPluginPackFailure,
  type PluginPackFailure,
} from '../errors.js';

export interface ProductionDeclaration {
  readonly sourceKey: string;
  /** Absolute source path captured by the inventory generation. */
  readonly sourcePath?: string;
  readonly guids: readonly string[];
  readonly format?: 'meta.json' | 'pack.json' | 'pack.ts';
}

type ProductionRequest = Readonly<{
  generation: number;
  sourceKeys: readonly string[];
}>;

export interface ProductionSourceChange {
  readonly sourceKey: string;
}

export interface ProductionStateContext<TState = undefined> {
  readonly generation: number;
  readonly sourceKeys: readonly string[];
  readonly intent: 'attempt' | 'materialize';
  readonly signal: AbortSignal;
  readonly acceptedState: TState | undefined;
}

export interface ProductionInventoryContext<TState = undefined> {
  readonly generation: number;
  readonly sourceKeys: readonly string[];
  readonly signal: AbortSignal;
  readonly state: TState;
}

export interface ProductionProduceContext<TState = undefined> {
  readonly generation: number;
  readonly declaration: ProductionDeclaration;
  readonly intent: 'attempt' | 'materialize';
  readonly signal: AbortSignal;
  readonly state: TState;
}

export interface ProductionPublication<TState = undefined> {
  readonly generation: number;
  readonly intent: 'attempt' | 'materialize';
  readonly signal: AbortSignal;
  readonly state: TState;
}

export interface ProductionDiscardContext<TState = undefined>
  extends ProductionPublication<TState> {
  readonly error?: PluginPackFailure;
}

export interface ProductionSessionOptions<TState = undefined> {
  readonly createState?: (context: ProductionStateContext<TState>) => TState;
  readonly inventory: (
    context: ProductionInventoryContext<TState>,
  ) => Promise<readonly ProductionDeclaration[]>;
  readonly produce: (context: ProductionProduceContext<TState>) => Promise<void>;
  readonly publish: (publication: ProductionPublication<TState>) => Promise<void>;
  readonly discard?: (publication: ProductionDiscardContext<TState>) => Promise<void>;
  readonly initialGeneration?: number;
  readonly sourceKeys?: () => readonly string[];
}

export type ProductionRunResult =
  | {
      readonly status: 'accepted';
      readonly generation: number;
    }
  | { readonly status: 'stale'; readonly generation: number }
  | { readonly status: 'failed'; readonly generation: number; readonly error: PluginPackFailure };

export interface ProductionSession<TState = undefined> {
  readonly runtimeGeneration: number;
  readonly signal: AbortSignal;
  readonly acceptedState: () => TState | undefined;
  start(): Promise<ProductionRunResult>;
  materialize(guid: string): Promise<ProductionRunResult>;
  rebuild(changes: readonly ProductionSourceChange[]): Promise<ProductionRunResult>;
  close(): Promise<void>;
}

function runKey(input: ProductionRequest): string {
  return `${input.generation}\0${[...new Set(input.sourceKeys)].sort().join('\0')}`;
}

export function createProductionSession<TState = undefined>(
  options: ProductionSessionOptions<TState>,
): ProductionSession<TState> {
  const inFlight = new Map<string, Promise<ProductionRunResult>>();
  const pending = new Set<Promise<ProductionRunResult>>();
  const controllers = new Map<
    AbortController,
    { readonly generation: number; readonly intent: 'attempt' | 'materialize' }
  >();
  const sessionController = new AbortController();
  let acceptedDeclarations: readonly ProductionDeclaration[] | undefined;
  let acceptedGeneration: number | undefined;
  let acceptedGenerationState: TState | undefined;
  let currentGeneration = options.initialGeneration ?? 0;
  let closed = false;
  let started: Promise<ProductionRunResult> | undefined;

  const schedule = (
    input: ProductionRequest,
    selectedDeclarations?: readonly ProductionDeclaration[],
    intent: 'attempt' | 'materialize' = 'attempt',
  ): Promise<ProductionRunResult> => {
    if (closed) {
      return Promise.reject(
        createPluginPackFailure({
          code: 'cleanup-failed',
          expected: 'the ProductionSession to accept work before close',
          hint: 'create a new generation-scoped session and retry the production request',
          detail: { stage: 'cleanup', subject: 'production-session' },
        }),
      );
    }
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      return Promise.reject(new TypeError('Production generation must be a positive safe integer'));
    }
    const supersedesAttempt = intent === 'attempt' && input.generation > currentGeneration;
    if (supersedesAttempt) {
      // A rebuild owns the next production generation.  Abort every older
      // attempt and any materialization tied to the accepted generation so
      // that an in-flight DDC commit cannot turn an obsolete lease into a
      // user-visible commit failure.
      for (const [controller, request] of controllers) {
        if (
          request.intent === 'materialize' ||
          (request.intent === 'attempt' && request.generation < input.generation)
        ) {
          controller.abort();
        }
      }
    }
    currentGeneration = Math.max(currentGeneration, input.generation);
    const key = `${intent}\0${runKey(input)}`;
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing;
    const controller = new AbortController();
    const abortAttempt = (): void => controller.abort();
    sessionController.signal.addEventListener('abort', abortAttempt, { once: true });
    controllers.set(controller, { generation: input.generation, intent });
    const task = execute(input, controller.signal, selectedDeclarations, intent);
    inFlight.set(key, task);
    pending.add(task);
    const release = (): void => {
      inFlight.delete(key);
      pending.delete(task);
      controllers.delete(controller);
      sessionController.signal.removeEventListener('abort', abortAttempt);
    };
    void task.then(release, release);
    return task;
  };

  async function execute(
    input: ProductionRequest,
    signal: AbortSignal,
    selectedDeclarations: readonly ProductionDeclaration[] | undefined,
    intent: 'attempt' | 'materialize',
  ): Promise<ProductionRunResult> {
    const state =
      options.createState?.({
        generation: input.generation,
        sourceKeys: input.sourceKeys,
        intent,
        signal,
        acceptedState: acceptedGenerationState,
      }) ?? (undefined as TState);
    const publication: ProductionPublication<TState> = {
      generation: input.generation,
      intent,
      signal,
      state,
    };
    const isCurrent = (generation: number): boolean =>
      intent === 'materialize'
        ? generation === acceptedGeneration
        : generation === currentGeneration;
    let stage: 'scan' | 'produce' | 'commit' = 'scan';
    try {
      const declarations =
        selectedDeclarations ??
        (await options.inventory({
          generation: input.generation,
          sourceKeys: input.sourceKeys,
          signal,
          state,
        }));
      stage = 'produce';
      for (const declaration of declarations) {
        await options.produce({
          generation: input.generation,
          declaration,
          intent,
          signal,
          state,
        });
      }
      if (closed || !isCurrent(input.generation)) {
        await discard(publication);
        return { status: 'stale', generation: input.generation };
      }
      stage = 'commit';
      await options.publish(publication);
      if (closed || signal.aborted || !isCurrent(input.generation)) {
        await discard(publication);
        return { status: 'stale', generation: input.generation };
      }
      if (selectedDeclarations === undefined) {
        acceptedDeclarations = declarations;
        acceptedGeneration = input.generation;
      }
      acceptedGenerationState = state;
      return { status: 'accepted', generation: input.generation };
    } catch (error) {
      if (closed || signal.aborted || !isCurrent(input.generation)) {
        try {
          await discard(publication);
        } catch {
          // The session is already closing; no late candidate may publish.
        }
        return { status: 'stale', generation: input.generation };
      }
      let failure = createPluginPackFailure({
        code: `${stage}-failed`,
        expected: 'the production task completes with a validated product',
        hint: 'inspect the source, repair the producer, rebuild, verify, and retry',
        detail: {
          stage,
          ...(input.sourceKeys[0] === undefined ? {} : { subject: input.sourceKeys[0] }),
        },
        cause: error,
      });
      try {
        await discard({ ...publication, error: failure });
      } catch (cleanupError) {
        failure = appendPluginPackCleanup(
          failure,
          createPluginPackFailure({
            code: 'cleanup-failed',
            expected: 'the failed candidate is discarded',
            hint: 'inspect the candidate lease, repair cleanup, and retry',
            detail: {
              stage: 'cleanup',
              ...(input.sourceKeys[0] === undefined ? {} : { subject: input.sourceKeys[0] }),
            },
            cause: cleanupError,
          }),
        );
      }
      return { status: 'failed', generation: input.generation, error: failure };
    }
  }

  async function discard(publication: ProductionDiscardContext<TState>): Promise<void> {
    if (options.discard === undefined) return;
    await options.discard(publication);
  }

  const start = (): Promise<ProductionRunResult> => {
    if (started !== undefined) return started;
    started = schedule({
      generation: Math.max(currentGeneration, 1),
      sourceKeys: options.sourceKeys?.() ?? [],
    });
    return started;
  };

  const materialize = (guid: string): Promise<ProductionRunResult> =>
    (async (): Promise<ProductionRunResult> => {
      // Startup is a one-shot attempt; a later accepted rebuild owns readiness.
      if (acceptedGeneration === undefined) {
        const startedResult = await start();
        if (acceptedGeneration === undefined) return startedResult;
      }
      const generation = acceptedGeneration;
      const guidLower = guid.toLowerCase();
      const declaration = acceptedDeclarations?.find((candidate) =>
        candidate.guids.some((candidateGuid) => candidateGuid.toLowerCase() === guidLower),
      );
      if (declaration === undefined) {
        return {
          status: 'failed',
          generation,
          error: createPluginPackFailure({
            code: 'route-failed',
            expected: `the accepted inventory to declare ${guid}`,
            hint: 'rebuild the Catalog and retry materialization for the declared GUID',
            detail: { stage: 'route', subject: guid },
          }),
        };
      }
      return schedule(
        {
          generation,
          sourceKeys: [declaration.sourceKey],
        },
        [declaration],
        'materialize',
      );
    })();

  const rebuild = (changes: readonly ProductionSourceChange[]): Promise<ProductionRunResult> =>
    schedule({
      generation: Math.max(currentGeneration + 1, 1),
      sourceKeys: changes.map((change) => change.sourceKey),
    });

  return {
    get runtimeGeneration() {
      return currentGeneration;
    },
    signal: sessionController.signal,
    acceptedState: () => acceptedGenerationState,
    start,
    materialize,
    rebuild,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      sessionController.abort();
      for (const controller of controllers.keys()) controller.abort();
      await Promise.allSettled([...pending]);
      inFlight.clear();
      controllers.clear();
    },
  };
}
