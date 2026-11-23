import { RhiError } from '@forgeax/engine-rhi';
import type { GpuSceneSourceResource } from './gpu-scene-source-rows';

/** A Source owns callbacks only until exact release; a failed release is never retried blindly. */
export function sourceResource<
  T extends Omit<GpuSceneSourceResource, 'isCurrent' | 'release' | 'adopt'>,
>(
  facts: T,
  current: () => boolean,
  release: () => void,
  adopt: () => void,
): T & GpuSceneSourceResource {
  let scope: { current(): boolean; release(): void; adopt(): void } | undefined = {
    current,
    release,
    adopt,
  };
  let failure: { cause: unknown } | undefined;
  const api = Object.defineProperties({} as T, Object.getOwnPropertyDescriptors(facts));
  return Object.freeze(
    Object.assign(api, {
      adopt: () => {
        if (failure !== undefined) throw failure.cause;
        const held = scope;
        if (held === undefined) throw resourceHoldInvalid();
        try {
          held.adopt();
        } catch (cause) {
          failure = { cause };
          throw cause;
        }
      },
      isCurrent: () => {
        const held = scope;
        return (
          failure === undefined &&
          held !== undefined &&
          held.current() &&
          scope === held &&
          failure === undefined
        );
      },
      release: () => {
        if (failure !== undefined) throw failure.cause;
        const held = scope;
        if (held === undefined) return;
        scope = undefined;
        try {
          held.release();
        } catch (cause) {
          scope = held;
          failure = { cause };
          throw cause;
        }
      },
    }),
  );
}

export function releaseSourceParts(parts: readonly (() => void)[]): void {
  const failures: unknown[] = [];
  for (const release of parts)
    try {
      release();
    } catch (cause) {
      failures.push(cause);
    }
  if (failures.length > 0)
    throw new AggregateError(failures, 'Source resource custody release failed');
}

export function resourceHoldInvalid(): RhiError {
  return new RhiError({
    code: 'rhi-descriptor-invalid',
    expected: 'one live sealed resource frame issued by this GPU Scene, transferred once',
    hint: 'seal a fresh source/read-domain probe before transferring its hold-only references',
  });
}
