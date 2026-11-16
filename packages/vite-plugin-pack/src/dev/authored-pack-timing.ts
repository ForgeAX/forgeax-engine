import type { ScriptablePackProductionOptions } from '@forgeax/engine-import';
import { stringifyPluginDiagnostic } from '../structured-plugin-error.js';

type Progress = NonNullable<ScriptablePackProductionOptions['onProgress']>;
type ProgressEvent = Parameters<Progress>[0];

function emit(record: Readonly<Record<string, unknown>>): void {
  console.error(
    '[forgeax.authored-pack.timing]',
    stringifyPluginDiagnostic({ ...record, atMs: Math.round(performance.now()) }),
  );
}

function elapsed(startedAt: number): number {
  return Math.round(performance.now() - startedAt);
}

/** Observe the existing worklist; phase transitions include its original admission waits. */
export function createAuthoredPackProgressTiming() {
  const startedAt = performance.now();
  const pending = new Map<string, { readonly event: ProgressEvent; readonly startedAt: number }>();
  const end = (sourcePath: string, status: 'end' | 'unfinished', failure?: unknown) => {
    const previous = pending.get(sourcePath);
    if (previous === undefined) return;
    emit({
      stage: 'produce-source',
      ...previous.event,
      status,
      elapsedMs: elapsed(startedAt),
      durationMs: elapsed(previous.startedAt),
      ...(failure === undefined ? {} : { failure }),
    });
    pending.delete(sourcePath);
  };
  return {
    onProgress(event: ProgressEvent): void {
      end(event.sourcePath, 'end');
      emit({
        stage: 'produce-source',
        ...event,
        status: event.phase === 'ready' ? 'end' : 'start',
        elapsedMs: elapsed(startedAt),
        ...(event.phase === 'ready' ? { durationMs: 0 } : {}),
      });
      if (event.phase !== 'ready')
        pending.set(event.sourcePath, { event, startedAt: performance.now() });
    },
    finish(failure?: unknown): void {
      for (const sourcePath of pending.keys()) end(sourcePath, 'unfinished', failure);
      emit({
        stage: 'produce-and-cook',
        status: failure === undefined ? 'end' : 'failed',
        elapsedMs: elapsed(startedAt),
        ...(failure === undefined ? {} : { failure }),
      });
    },
  };
}

/** Recipe identity is the registered cooker key; never derive a new cache key. */
export async function timeAuthoredPackRecipe<T>(
  stage: 'native-discover' | 'native-cook',
  recipe: string,
  input: unknown,
  invoke: () => T | Promise<T>,
): Promise<T> {
  const identity =
    input !== null && typeof input === 'object'
      ? (input as {
          readonly sourcePath?: unknown;
          readonly sourceKey?: unknown;
          readonly guid?: unknown;
        })
      : {};
  const record = {
    stage,
    recipe,
    sourcePath: identity.sourcePath,
    sourceKey: identity.sourceKey,
    guid: identity.guid,
  };
  const startedAt = performance.now();
  emit({ ...record, status: 'start', durationMs: 0 });
  try {
    const result = await invoke();
    emit({ ...record, status: 'end', durationMs: elapsed(startedAt) });
    return result;
  } catch (failure) {
    emit({ ...record, status: 'failed', durationMs: elapsed(startedAt), failure });
    throw failure;
  }
}
