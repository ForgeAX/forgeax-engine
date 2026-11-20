# Platform

Realm-neutral host facts and native callback leases. App owns frame admission and
Renderer completion; World owns simulation time. A platform never advances World
or treats a host callback as GPU completion.

| Surface | Contract |
|:--|:--|
| `now()` | Result of finite, non-negative monotonic milliseconds in the realm's native origin |
| `requestFrame(callback)` | One future native callback and an idempotent cancellation lease |
| `display()` | Logical display size, DPR, safe area and independently measured drawing buffer |
| `visible()` / `subscribe(listener)` | Current visibility and leased host lifecycle observations |
| `dispose()` | Fence stale callbacks, release every acquired listener/frame, retain native cleanup failures |

`createPlatformClock(read, unit)` normalizes milliseconds or microseconds exactly
once and rejects backward/invalid time without updating its last valid baseline.
Native clock exceptions retain their cause; no wall-clock fallback exists.

`createPlatformLifecycle()` owns subscriber leases, pending-frame cancellation,
one-shot asynchronous frame delivery and disposal fencing for both native bindings.
Bindings retain native tokens inside cancellation closures. `bind(subscribe)`
provides a release stack: register each release before its native acquisition.
The lifecycle unwinds that stack in reverse order on acquisition failure or
`dispose()`, preserving both startup and cleanup causes. Display and clock facts
remain host-owned.

`releasePlatformResources` attempts every supplied release. If any fails, it throws
a structured `PlatformError` containing an `AggregateError` of original causes.
Native release leases and `dispose()` use this exceptional teardown boundary; normal
acquisition and read failures return `Result`. A retired lease remains retired after
a native cleanup failure, so late callbacks cannot re-enter a disposed consumer.

Read [errors.ts](src/errors.ts) for the closed error union. A startup operation can
retain both its original `cause` and a `cleanupCause`; do not overwrite the former
with the latter. A subscriber owns its own lease even when it supplies the same
callback twice.

Concrete bindings live in [platform-browser](../platform-browser/README.md) and
[platform-wechat](../platform-wechat/README.md). They report host facts and keep
native objects in their own realm. App borrows a supplied platform and releases
its own leases; the host disposes the platform after all consumers have retired.

## Scoped cancellation

`withCombinedSignal(signals, operation)` runs an operation with a realm-local
signal that aborts when any input aborts. It preserves the first cancellation
reason, accepts already-aborted inputs and removes input listeners on abort or
operation settlement. It never cancels the input owners or calls `AbortSignal.any`.
Window, Worker and native hosts use the same implementation.

```ts
import { withCombinedSignal } from '@forgeax/engine/platform';

const result = await withCombinedSignal([request.signal, lifetime.signal], (signal) =>
  readAsset({ signal }),
);
```

> [!IMPORTANT]
> Return or await all signal-consuming work inside the callback, including response
> body reads. The signal's subscription lease ends when that callback settles; this
> helper does not race or force-cancel an operation that ignores cancellation.

## Cross-platform verification

The implementation verification record identifies the tested
browser and official WeChat simulator builds, retained evidence, and incomplete
targets. It does not expand this package's runtime contract.

## Task pool

`createTaskPool({ kinds, workerFactory?, workers? })` runs registered task kinds
(`TaskModule` from `@forgeax/engine-types`) on lazily spawned Workers, or inline
in the calling realm when no factory is given. Queues are per priority
(critical, normal, background) and FIFO; idle Workers are reused most recently
idle first; one Worker is kept from background tasks while the pool has more
than one; `maxInFlight` caps a kind. `cancel()` withdraws a queued task, or
discards a running task's value; `dispose()` rejects everything unfinished. A
crashed Worker rejects its running task and is replaced on demand; a kind that
crashes Workers `crashLimit` times in a row runs inline from then on.
Register a kind with `workerOnly: true` when running it in the submitting realm
would violate its contract. The pool rejects queued and future work for that
kind when no Worker can run it. A kind's `shared()` value is produced once by the pool and handed to each Worker's
`init`. `serveTaskWorker` is the Worker side; `createTaskClient` and
`serveTaskClient` let another realm submit through the pool with values
returned on a per-task port directly from the executing Worker.

`parallelFor({ kind, input, count, run, timeoutMs })` runs `count` indices of
one job within the current frame. The calling realm and every started Worker
claim indices from one shared atomic cursor, so each index runs exactly once
and the job completes even when no Worker joins; the caller blocks until the
last index finished. A slice job reaches a Worker as a message, so it starts
once the Worker's current task returns, ahead of every queued task; task
modules keep each uninterrupted run within the 8 ms slice and yield or split
longer work. `prepareSlices(kind, value)` announces what a slice kind needs to
every Worker, replays it to Workers started later, and grows the pool to full
size. A Worker joins a job only once its `SliceModule` reports `ready` for the
job's input; until then the caller and the other Workers take its share. A
Worker still holding an index at the deadline is replaced and the outcome
reports `timedOut`. The Worker side registers kinds through
`serveTaskWorker(port, registry, { slices })`.
