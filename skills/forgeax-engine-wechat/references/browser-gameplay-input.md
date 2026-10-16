# Browser gameplay input observation

[browser_gameplay_input.mjs](../scripts/browser_gameplay_input.mjs) observes two
boundaries in one Browser realm: dispatched window-capture pointer events and
calls to the current `MessagePort.prototype.postMessage` for
`channel: 'game-3d/player-controls'`. Use it in an independent short diagnostic
when CDP acknowledgements, DOM displacement, control messages and actual camera
motion disagree. This adds observation overhead and is not an FPS acceptance run.
It does not support native WeChat or prove delivery to the game.

Install before the game's scripts so saved methods cannot bypass the hook:

```js
import { installBrowserGameplayInput } from './browser_gameplay_input.mjs';

await page.addInitScript(installBrowserGameplayInput, { capacity: 16384 });
await page.goto(gameUrl);
// Complete ordinary-game readiness and semantic qualification first.
await page.evaluate(() => __forgeaxGameplayInput.start());
try {
  // Execute the existing fixed input timeline; do not add inspection here.
  await executeTimeline(timeline, dispatch, timelineOptions);
} finally {
  const observation = await page.evaluate(() => {
    const probe = __forgeaxGameplayInput;
    const stopped = probe.stop();
    const restored = probe.restore();
    return { ...stopped, restoration: restored.coverage.restoreConflicts };
  });
  // Retain observation with source, workload, geometry and before/after player state.
}
```

`browserGameplayInputSource(options)` supplies the same self-contained installer
as a source string for `page.addInitScript({ content })`. The default global is
`__forgeaxGameplayInput`; `globalName` can select a different unused identifier.
`start()` resets the bounded recording and returns its `performance.now` start.
`stop()` ends observation and returns JSON-compatible data. `snapshot()` exports
without changing state. `restore()` stops, removes only its own listeners and
restores only the method/global still owned by this instance. A later hook stays
installed and is reported as a restoration conflict. No port is closed, no input
is synthesized, and no App, World, timer or animation scheduling is changed.

Pointer rows retain the event type, pointer ID/type, client coordinates,
`event.timeStamp`, trust flag and observed `performance.now` time. Capture happens
at `window`, before document handlers can stop propagation. `pointerup` and
`pointercancel` coordinates are retained exactly; the observer does not compensate
for application handling or infer a final move. Coalesced physical samples are
outside this record. Synthetic events remain explicitly `trusted: false`.

Message rows retain a local weak port identity, call start/end time, whether the
original call threw, and only the control's raw fields: look `x/y`, move
`horizontal/vertical`, run `held`, or jump/reset kind. The original receiver,
complete argument list, transfer list, return value and exception remain intact.
Observation reads own data fields after the original call; it does not invoke
payload accessors again. Other channels and extra payload fields are never copied.
Invalid/non-data fields and unknown control kinds have coverage counters.

The buffer accepts 8–262144 rows and reports dropped pointer/message counts plus
first/last overflow times. Missing hooks, observation errors, overflow or saved
pre-install methods limit coverage; absent rows then cannot establish lost input.
Workers, iframes, custom nonstandard ports and game consumption are separate
boundaries. Compare per-contact DOM deltas with raw look-message sums and the
ordinary game's before/after yaw using the same declared workload. CDP ACK alone
does not prove any of these quantities, and a discrepancy does not identify a
production owner without the boundary evidence.

In the partial-release diagnosis, trusted DOM and public wx agreed: CDP explicit
`touchEnd` points were the fingers being ended, while the driver had sent the
retained fingers. Linux Chromium 141 and Mac Chrome 155/official DevTools reproduced
the same semantics. The [two/three/four-contact regression](../scripts/__tests__/gameplay-cdp.test.mjs)
failed before the driver correction and passed afterward. Earlier yaw deficits
and platform departures cannot be attributed to game consumption or the intended
route from those faulty-input captures alone.

The focused tests use real sandboxed Chromium DOM events and MessageChannel,
without creating a GPU context:

```sh
FORGEAX_PLAYWRIGHT_MODULE=/absolute/node_modules/playwright/index.mjs \
  node --test skills/forgeax-engine-wechat/scripts/__tests__/browser-gameplay-input.test.mjs
```

Without that module path the browser cases are skipped; a skipped case is not
browser evidence. `FORGEAX_CHROMIUM_EXECUTABLE` optionally selects an installed
Chromium executable. Keep `chromiumSandbox: true`.
