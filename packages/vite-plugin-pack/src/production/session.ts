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
  repairTransport?: boolean;
}>;

export interface ProductionSourceChange {
  readonly sourceKey: string;
}

interface ProductionStateContext<TState = undefined> {
  readonly generation: number;
  readonly sourceKeys: readonly string[];
  readonly intent: 'attempt' | 'materialize';
  readonly signal: AbortSignal;
  readonly acceptedState: TState | undefined;
}

interface ProductionInventoryContext<TState = undefined> {
  readonly generation: number;
  readonly sourceKeys: readonly string[];
  readonly signal: AbortSignal;
  readonly state: TState;
}

interface ProductionProduceContext<TState = undefined> {
  readonly generation: number;
  readonly declaration: ProductionDeclaration;
  readonly repairTransport: boolean;
  readonly intent: 'attempt' | 'materialize';
  readonly signal: AbortSignal;
  readonly state: TState;
}

interface ProductionPublication<TState = undefined> {
  readonly generation: number;
  readonly intent: 'attempt' | 'materialize';
  readonly signal: AbortSignal;
  readonly state: TState;
}

interface ProductionDiscardContext<TState = undefined> extends ProductionPublication<TState> {
  readonly error?: PluginPackFailure;
}

interface ProductionSessionOptions<TState = undefined> {
  readonly createState?: (context: ProductionStateContext<TState>) => TState;
  readonly inventory: (
    context: ProductionInventoryContext<TState>,
  ) => Promise<readonly ProductionDeclaration[]>;
  readonly produce: (context: ProductionProduceContext<TState>) => Promise<void>;
  readonly publish: (publication: ProductionPublication<TState>) => Promise<void>;
  readonly discard?: (publication: ProductionDiscardContext<TState>) => Promise<void>;
  /** Serialize watcher and explicit import work when both publish the same source graph. */
  readonly serial?: boolean;
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
  materialize(guid: string, repairTransport?: boolean): Promise<ProductionRunResult>;
  rebuild(changes: readonly ProductionSourceChange[]): Promise<ProductionRunResult>;
  track<T>(task: Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function runKey(input: ProductionRequest): string {
  return `${input.generation}\0${[...new Set(input.sourceKeys)].sort().join('\0')}`;
}

export function createProductionSession<TState = undefined>(
  options: ProductionSessionOptions<TState>,
): ProductionSession<TState> {
  const inFlight = new Map<
    string,
    {
      readonly controller: AbortController;
      readonly generation: number;
      readonly task: Promise<ProductionRunResult>;
    }
  >();
  const hostTasks = new Set<Promise<unknown>>();
  const sessionController = new AbortController();
  let accepted:
    | {
        readonly declarations: readonly ProductionDeclaration[];
        readonly generation: number;
        readonly state: TState;
      }
    | undefined;
  let currentGeneration = options.initialGeneration ?? 0;
  let closing: Promise<void> | undefined;
  let started: Promise<ProductionRunResult> | undefined;
  let queue = Promise.resolve<unknown>(undefined);

  const closedFailure = () =>
    createPluginPackFailure({
      code: 'cleanup-failed',
      expected: 'the ProductionSession to accept work before close',
      hint: 'create a new generation-scoped session and retry the production request',
      detail: { stage: 'cleanup', subject: 'production-session' },
    });

  const run = (work: () => Promise<ProductionRunResult>): Promise<ProductionRunResult> => {
    if (sessionController.signal.aborted) return Promise.reject(closedFailure());
    if (!options.serial) return work();
    const task = queue.then(() => {
      if (sessionController.signal.aborted) throw closedFailure();
      return work();
    });
    queue = task.catch(() => undefined);
    return task;
  };

  const schedule = (
    input: ProductionRequest,
    selectedDeclarations?: readonly ProductionDeclaration[],
    intent: 'attempt' | 'materialize' = 'attempt',
  ): Promise<ProductionRunResult> => {
    if (sessionController.signal.aborted) return Promise.reject(closedFailure());
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) {
      return Promise.reject(new TypeError('Production generation must be a positive safe integer'));
    }
    const supersedesAttempt = intent === 'attempt' && input.generation > currentGeneration;
    if (supersedesAttempt) {
      // A rebuild owns the next production generation.  Abort every older
      // attempt and any materialization tied to the accepted generation so
      // that an in-flight DDC commit cannot turn an obsolete lease into a
      // user-visible commit failure.
      for (const attempt of inFlight.values()) {
        if (attempt.generation < input.generation) attempt.controller.abort();
      }
    }
    currentGeneration = Math.max(currentGeneration, input.generation);
    const key = `${input.repairTransport ? 'repair-transport' : intent}\0${runKey(input)}`;
    const existing = inFlight.get(key);
    if (existing !== undefined) return existing.task;
    const controller = new AbortController();
    const signal = AbortSignal.any([sessionController.signal, controller.signal]);
    const task = Promise.resolve().then(() => execute(input, signal, selectedDeclarations, intent));
    inFlight.set(key, { controller, generation: input.generation, task });
    const release = (): void => {
      inFlight.delete(key);
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
        acceptedState: accepted?.state,
      }) ?? (undefined as TState);
    const publication: ProductionPublication<TState> = {
      generation: input.generation,
      intent,
      signal,
      state,
    };
    const isCurrent = (generation: number): boolean =>
      intent === 'materialize'
        ? generation === accepted?.generation
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
          repairTransport: input.repairTransport === true,
          intent,
          signal,
          state,
        });
      }
      if (sessionController.signal.aborted || !isCurrent(input.generation)) {
        await discard(publication);
        return { status: 'stale', generation: input.generation };
      }
      stage = 'commit';
      await options.publish(publication);
      if (sessionController.signal.aborted || signal.aborted || !isCurrent(input.generation)) {
        await discard(publication);
        return { status: 'stale', generation: input.generation };
      }
      accepted = {
        declarations:
          selectedDeclarations === undefined ? declarations : (accepted?.declarations ?? []),
        generation: input.generation,
        state,
      };
      return { status: 'accepted', generation: input.generation };
    } catch (error) {
      if (sessionController.signal.aborted || signal.aborted || !isCurrent(input.generation)) {
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

  const materialize = (guid: string, repairTransport = false): Promise<ProductionRunResult> =>
    (async (): Promise<ProductionRunResult> => {
      // Startup is a one-shot attempt; a later accepted rebuild owns readiness.
      if (accepted === undefined) {
        const startedResult = await start();
        if (accepted === undefined) return startedResult;
      }
      const { declarations, generation } = accepted;
      const guidLower = guid.toLowerCase();
      const declaration = declarations.find((candidate) =>
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
          repairTransport,
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
    acceptedState: () => accepted?.state,
    start: () => run(start),
    materialize: (guid, repairTransport) => run(() => materialize(guid, repairTransport)),
    rebuild: (changes) => run(() => rebuild(changes)),
    track<T>(task: Promise<T>): Promise<T> {
      if (sessionController.signal.aborted) {
        void task.catch(() => undefined);
        const rejected = Promise.reject(closedFailure());
        void rejected.catch(() => undefined);
        return rejected;
      }
      hostTasks.add(task);
      const release = () => {
        hostTasks.delete(task);
      };
      void task.then(release, release);
      return task;
    },
    close(): Promise<void> {
      if (closing !== undefined) return closing;
      closing = Promise.allSettled([
        queue,
        ...hostTasks,
        ...[...inFlight.values()].map(({ task }) => task),
      ]).then(() => {});
      sessionController.abort();
      return closing;
    },
  };
}
