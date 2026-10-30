# @forgeax/engine-host

A business-neutral frontend/backend pair. Each side owns a native Cordis Context. Protocol v2 transfers one frozen root program/configuration projection with a revision and sessionGeneration; activation returns a native Fiber.

```ts
import { createBackendHost } from '@forgeax/engine-host/backend';
import { createFrontendHost } from '@forgeax/engine-host/frontend';

const backend = await createBackendHost();
const frontend = await createFrontendHost({ assembly: backend.assembly.current });
await frontend.dispose();
await backend.dispose();
```

| Boundary | Contract |
|:--|:--|
| Root resolution | Inject `resolveRoot`; code must already be compiled for the target |
| Asset integration | Inject `activateRoot` to use the domain's validated asset reader |
| Readiness | External native startup barrier; pending descendants are not active |
| Replacement | New revision requires a fresh JavaScript environment |
| Cancellation | Disconnect aborts activation and releases owned contributions |
| Cleanup | Finite deadline; failures remain observable, borrowed Contexts survive |

Offline clients pass an assembly directly. Connected clients request it over Host transport and report the accepted revision/generation. Backend subscriptions observe reports without controlling publication. Stale reports are rejected. The existing capability request, cancellation and disconnection protocol remains the transport owner.

Connecting a native WebSocket already in `CLOSING` or `CLOSED` rejects with `host-transport-failure` before installing connection listeners.

Local request cancellation rejects the pending request even while its socket is closing. The transport sends the cancellation notice only through an open socket; a late native close event never authorizes another send.

Host does not depend on Pack, project schema, World or Renderer. Those domain owners install ordinary plugins. `entryId` survives only in the external activation-report projection for wire consumers; it names a native Fiber within its session.

An owner may bind a distinct frontend projection to an authenticated connection:
`backend.bindProjection(caller, { assembly })` returns its disposer.
Only a live caller with its transport-issued capability is accepted; superseded reports are rejected. Use the caller supplied by the transport admission event, and register the
returned disposer with the owning plugin Fiber. Assembly fetches and activation
reports then use that connection's declared projection; default-assembly
notifications do not reach it. This does not activate backend plugins or change
peer assemblies. Rebinding replaces the projection, while an older disposer
cannot withdraw a replacement. Withdrawal fails the connection closed until
explicit rebinding or disconnect; it never falls back to another realm's
assembly. Disconnect and Host disposal release the retained binding.

The Host owns only this connection/assembly seam. Project, execution, admission
policy, snapshot lifetime and target semantics remain in the consuming domain
plugin. Hosts without a bound projection retain their normal assembly path.

The `host-assembly-not-ready` error detail uses `HostActivationEntry`: its
`entryId`, native `fiberState` and optional structured `failure` describe the
same pending Fiber as an activation report entry.

Frontend activation states follow `HostActivationReport.state`. The backend
adds `unavailable` for a disconnected frontend; local status errors remain
`unknown`, while reports serialize `HostErrorSummary`.

Both Host options select `context`, `startupTimeoutMs` and `startupPlugins`
from `HostStartupOptions`, matching the fields actually forwarded to native
startup. A positive `startupTimeoutMs` sets a startup deadline; `null` or
omission disables it while cancellation remains available. Assembly, transport
and frontend cleanup options stay on their owners. The frontend's custom
`activateRoot` callback receives the resolved startup budget, including `null`
when no deadline is configured, so its native activation can use the same policy
instead of starting a second timer.

## Frontend platform

The `@forgeax/engine-host/platform` subpath owns realm capabilities: Window,
Document, fetch, public Host transport, document frames, optional navigation, clipboard and observable host
appearance. `createFrontendPlatformPlugin` projects a borrowed platform through a
native Cordis Fiber. The browser factory supplies ordinary runtime behavior;
an explicitly selected host may provide an embedded implementation before
FrontendHost connects. Platform adapters do not own project, asset or Engine state.

`createFrame(url)` returns an isolated document handle with its iframe element,
transport `ready` Promise and idempotent asynchronous `dispose()`. The browser
adapter navigates normally; embedded adapters deliver the same document through
their admitted transport. Transport readiness is not Renderer readiness.
The consumer owns disposal; removing or hiding a panel only changes placement.
An embedded owner acknowledges child teardown before retiring the bridge and frame,
and cancellation during preparation releases the unfinished document.

Document navigation is an optional host capability. The ordinary
`createBrowserFrontendPlatform()` does not install `navigate`, so a standalone
game does not retain `location.assign` / `location.replace` through its default
platform. The consuming View workspace owns `navigateBrowserDocument` in
`@forgeax/view/workspace/document-navigation`, or supplies its embedding host's
`navigate` implementation. That workspace helper retains
cancellation and page-departure completion. This changes capability assembly,
not iframe ownership: `createFrame(url)` still loads the supplied URL directly.
The platform module exports no navigation implementation, including when native
program delivery retains its complete module namespace. Games need no workspace
detection or View adapter.

The optional `addConversationReference({title, text})` capability appends a titled
reference to a host conversation draft without submitting it. A host without this
capability offers no conversation action. Asset identity and reference text belong
to the asset consumer; the adapter only transports the draft operation.

Failed connection admission rolls back the server-owned caller and contributions.
The WebSocket adapter reports that failure through the ordinary response envelope
and retires only the rejected socket; the server and other connections remain live.

Frontend inspection covers the supplied native Context scope, including startup
services and a borrowed platform owner. It derives entries from real Fibers;
assembly root resolution and disposal ownership remain separate.

`HostTransportClient.close()` retires the local connection immediately and may
return a Promise for remote lease release. Owners await that Promise before
removing a carrier or closing its parent transport. A borrower never closes a
connection owned by another native Fiber.

WebSocket connection setup settles on open, error or close and releases all setup
listeners. An active connection has one terminal cleanup path for socket error,
remote close and explicit close: it retires physical listeners, closes the socket,
rejects pending requests, releases abort handlers and withdraws subscriptions.

The in-process transport’s accepted client set owns connection liveness. Closing
removes membership before aborting work, so cancellation callbacks observe the
same connection state, identity admission, and connected-client count.

Each service disposer retains its registered record. It withdraws only that exact
record, independently of the numeric generation carried by requests.
