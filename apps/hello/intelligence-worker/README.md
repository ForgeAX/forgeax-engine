# Hello M38 Intelligence Worker

> [!NOTE]
> This app is an evidence host for the `@forgeax/engine-intelligence` contract. The provider stays on the Host; the Engine World and its `Update` polling system run in a real `engine-worker`. The legacy M26 page remains available at `/`; M27 uses `/m27.html`; M28 uses `/m28.html`; M29 uses `/m29.html`; M30 uses `/m30.html`; M31 uses `/m31.html`; M32 uses `/m32.html`; M33 uses `/m33.html`; M34 uses `/m34.html`; M35 uses `/m35.html`; M36 uses `/m36.html`; M37 uses `/m37.html`; M38 uses `/m38.html`.

## Run the gauntlet

```sh
pnpm --filter @forgeax/hello-intelligence-worker gauntlet
```

The `gauntlet` script runs the M27 input-boundary baseline and the M28 close-fault scenario, each with a normal case plus a red falsifier case. With `maxInputChars = 4`, M27 proves exact-limit input, structured invalid-input refusal, healthy sibling progress, and same-provider `SessionRef` retry.

M28 makes the Host provider reject during disposal while one Worker activity is still active. The normal case proves terminal-only World mutation, close idempotency, late callback quarantine, and a valid activity through a fresh same-page `MessageChannel`/runtime/client. Its close-ordering probe observes the legacy failure if callbacks become visible during `runtime.close()`.

M29 makes the Worker optimistic limit larger than the Host runtime limit. The
normal case keeps activity A live, accepts B optimistically, receives one
structured Host capacity rejection for B, proves B is removed from the Worker
active set, completes A, and retries B through the same SessionRef and binding.
The falsifier drops the `intelligence-rejected` message at the Host/realm seam;
the Worker must catch that missing terminal instead of claiming recovery.

M30 creates provider-A and provider-B bindings on the same page. Provider A first returns a terminal
`SessionRef`; provider B's Worker client rejects that ref synchronously before allocating identity,
capacity, or sending a MessagePort submission. A valid provider-B request and provider-A same-session
retry then complete through the same Worker. Its falsifier bypasses the provider-B client guard and sends
the mismatched submission directly to the Host runtime, which the browser runner must catch.

M31 constrains both sides of the transport to `maxPollEvents = 1`. Two Host
activities emit interleaved text and terminal events while the Worker issues
one poll credit at a time. The normal case records exact request/response
accounting, per-activity sequence delivery, no starvation, terminal-only
authoritative mutation, and a same-client activity after both terminals free
optimistic capacity. The falsifier duplicates one event at the Host/realm seam;
the Worker must reject the sequence violation while the normal control remains
green.

M32 starts provider-B work and one outstanding B poll, then the Host directly
 calls `IntelligencePortBinding.close()`. The normal case proves that the Worker
 receives `intelligence-closed`, clears active/rejected/backlog/poll-credit
 state, refuses submit and cancel with structured `intelligence-closed`, and
 keeps provider-A usable. It creates provider-C through a fresh same-page
 `MessageChannel`/runtime/client, proves terminal-only World mutation, and
 settles repeated client, binding, provider, and `ExecutionApp.stop()` cleanup.
 Provider-B intentionally invokes two late callbacks after close; the runtime
 quarantines both. The headed Chrome falsifier suppresses the Host closed
 notification and keeps the raw port open, so post-close identity/transport
 effects and the hanging client close are observable and must be caught.

M33 keeps the M32 live-work/poll setup but injects a synchronous throw only while
the Host binding publishes `intelligence-closed`. The binding's shared close task
must settle, release the physical port exactly once, remove Host authority, and
quarantine provider callbacks even though the Worker cannot receive that failed
terminal notification. The page then creates a fresh same-page provider-C
`MessageChannel`/runtime/client/binding and proves valid work plus terminal-only
World mutation. The paired falsifier preserves the notification fault while
suppressing physical release; it must expose the uncontained release failure.

M35 moves the synchronous throw to the Worker client's `intelligence-submit`
publication. The normal headed case proves that `submit()` returns structured
`intelligence-closed`, clears optimistic activity/capacity/backlog/rejection/poll
state, releases the listener and physical port exactly once, and sends no failed
command into Host/provider/World authority. It then quarantines late provider
callbacks and recovers through a fresh same-page provider-C binding using the
retained provider-scoped `SessionRef`. The red falsifier preserves the old
optimistic admission before an uncontained command throw and must observe the
post-fault identity and transport leak.

M36 moves the synchronous throw to the Worker client's next
`intelligence-poll` publication, after one normal `maxPollEvents = 1` credit has
delivered a real staged event into the Worker client. The normal headed case
proves that `poll()` returns an empty list without throwing, discards the staged
event, clears active/rejected/event/poll-credit state, releases the listener and
physical port exactly once, and never sends the failed command to the Host. It
then explicitly closes the Host binding once, quarantines two late provider
callbacks, and recovers in the same page with a fresh channel/client/binding,
the retained `SessionRef`, and a new ActivityId. The red falsifier retains the
old staged-event removal plus `pollPending = true` before an uncontained post;
it must expose the throw, credit/resource leak, and absent staged event without
letting that path become a World mutation.

Run the headed M36 journey, including its red falsifier, with:

```sh
pnpm build:engine
pnpm --filter @forgeax/hello-intelligence-worker build
FORGEAX_BROWSER_HEADLESS=0 node apps/hello/intelligence-worker/scripts/m36-smoke-browser.mjs --gauntlet
```

The falsifiers deliberately write partial output into authoritative World state before a terminal and retain the pre-fix close-ordering oracle. They must be caught while the controls remain green and the page and Worker remain free of uncaught errors.

M37 moves the synchronous throw to the Worker client's `intelligence-cancel`
publication for one real target Activity after a staged event has arrived. The
normal headed case proves that `cancel()` returns structured
`intelligence-closed` instead of throwing, clears active/event/rejection/poll
state, releases the Worker listener and physical port exactly once, and sends
no cancel to Host or provider authority. A separate control Activity keeps
running while the target transport is faulted. The Host binding is then closed
explicitly; late provider callbacks are quarantined, and a fresh same-page
binding accepts the retained provider-scoped `SessionRef` with a new ActivityId.
The red falsifier preserves the old uncontained cancel throw and catches the
active-state, staged-event, identity, listener, port, and post-fault command
leaks.

Run the headed M37 journey, including its red falsifier, with:

```sh
pnpm build:engine
pnpm --filter @forgeax/hello-intelligence-worker build
FORGEAX_BROWSER_HEADLESS=0 node apps/hello/intelligence-worker/scripts/m37-smoke-browser.mjs --gauntlet
```

M38 moves the synchronous throw to the Host binding's non-empty
`intelligence-events` response, after `runtime.poll()` has destructively drained
the event. The normal headed case proves that the Host binding catches the
publication failure, enters one terminal cleanup task, cancels active work,
quarantines late callbacks, closes the Host listener and physical port exactly
once, and lets the Worker client settle explicitly before it resumes a retained
control `SessionRef` through a fresh same-page binding. The target event is
never delivered or projected into the authoritative World. The red falsifier
keeps the pre-M38 uncontained Host listener alive, exposing the drained-event,
active-work, and poll-credit leak.

Run the headed M38 journey, including its red falsifier, with:

```sh
pnpm build:engine
pnpm --filter @forgeax/hello-intelligence-worker build
FORGEAX_BROWSER_HEADLESS=0 node apps/hello/intelligence-worker/scripts/m38-smoke-browser.mjs --gauntlet
```

## Evidence

Set `FORGEAX_GAUNTLET_ARTIFACT_DIR` to persist the canvas PNG and JSON reports. The M27, M28, and M29 scripts publish their respective evidence files when the red cases are enabled.

| Boundary | Witness |
| :-- | :-- |
| Host / Worker transport | `MessageChannel`, `bootstrapPort`, and `createIntelligencePortClient` |
| Frame authority | Worker plugin polls from an ECS `Update` system |
| Input recovery | exact-limit `abcd`, empty and limit-plus-one structured refusal, no identity/port/provider dispatch, healthy sibling, same-`SessionRef` retry |
| Close recovery | rejecting Host provider, terminal runtime state, idempotent close, late callback quarantine, fresh same-page binding |
| Host rejection recovery | Worker limit two versus Host limit one, one failed capacity terminal, optimistic-set release, sibling preservation, same-`SessionRef` retry |
| Provider-scoped session recovery | Provider-A terminal `SessionRef`, provider-B synchronous mismatch before identity/capacity/port/runtime/provider effects, same-page B success, A retry, and raw-submit falsifier |
| One-credit backlog | Host/client `maxPollEvents=1`, one outstanding poll, interleaved two-activity sequence proof, terminal capacity release, same-client recovery, duplicate-event falsifier |
| Host binding close recovery | Direct Host binding close during a live Worker activity/poll, synchronous `intelligence-closed` publication throw, awaited physical release, Host authority removal, provider-A survival, fresh provider-C channel, late callback quarantine, physical-release falsifier |
| Worker submit recovery | Synchronous `intelligence-submit` publication throw, structured `intelligence-closed`, optimistic-state clearing, exactly-once listener/port release, no failed Host/provider/World effects, late callback quarantine, retained-`SessionRef` fresh binding, and uncontained-release falsifier |
| Worker poll recovery | One normal `maxPollEvents=1` credit, real staged event outside World, synchronous next-poll publication throw, empty terminal poll, exact listener/port release, no Host/provider/World fault command, explicit Host cleanup, late callback quarantine, retained-`SessionRef` fresh binding, and staged-event/poll-credit falsifier |
| Worker cancel recovery | Real staged target event, synchronous `intelligence-cancel` publication throw, structured `intelligence-closed`, active/event/rejection/poll-credit clearing, exact listener/port release, no Host/provider cancel, live control Activity, explicit Host cleanup, late callback quarantine, retained-`SessionRef` fresh binding, and uncontained-cancel falsifier |
| Host poll-response recovery | Real `maxPollEvents=1` target response, destructive Host `runtime.poll()` followed by synchronous publication throw, terminal Host cleanup/cancel, no delivered target event or World mutation, explicit Worker cleanup, fresh retained-`SessionRef` binding, and uncontained Host-listener falsifier |
| Lifecycle | Worker client, Host binding/provider, and App `stop()` are called repeatedly |
| Visual/live path | Chrome, WebGPU canvas, explicit `execution.tier = 'engine-worker'` |
