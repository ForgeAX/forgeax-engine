# Browser platform

`createBrowserPlatform(canvas)` binds a connected canvas's actual Window, including
an iframe owner. It borrows the canvas and returns the shared
[Platform contract](../platform/README.md).

```ts
import { createBrowserPlatform } from '@forgeax/engine/platform-browser';
const platform = createBrowserPlatform(canvas).unwrap();
const cancel = platform.requestFrame(() => console.log(platform.now().unwrap())).unwrap();
cancel();
platform.dispose();
```

| Fact / lifetime | Source |
|:--|:--|
| Clock / native frame | Canvas Window's `performance`, `requestAnimationFrame`, `cancelAnimationFrame` |
| Logical / drawing size | Canvas `clientWidth`/`clientHeight` versus actual `width`/`height` |
| Safe area | Browser CSS environment insets intersected with the canvas bounds |
| Visibility | Document visibility plus pagehide/pageshow state |
| Size events | Window resize and native ResizeObserver when available |
| Ownership | Cancellation and event leases; disposal leaves the borrowed canvas connected |

Safe-area reads use a temporary hidden element in the owning Document and remove
it immediately. Platform observes dimensions; the surface owner decides how to
resize the drawing buffer. A missing native clock/frame API or disconnected canvas
fails before allocation. Native teardown attempts every release and preserves
failures according to Platform.

Each platform owns one native lifecycle subscription and ResizeObserver, regardless
of subscriber count. Page visibility remains current before the first subscriber
and after the last release. A detached canvas fails `display()` and a subsequent
native size notification reports `surface-lost`; it is not a valid zero-size surface.

Real-browser regression cases live in
[src/__tests__/platform.browser.test.ts](src/__tests__/platform.browser.test.ts).
The focused test configuration retains Chromium sandboxing. Synthetic page events
only test event-to-state consistency; they do not qualify browser background throttling.
