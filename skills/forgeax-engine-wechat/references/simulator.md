# Simulator operations

## Establish the project

The project directory on the DevTools machine contains the actual generated output,
including `game.js`, `game.json` and `project.config.json`. Check `compileType: "game"`
and the AppID before import. Keep personal/private settings separate from generic
source. A Mini Program project (`miniprogram`) and page automator do not qualify a
Mini Game canvas.

With the current official AI CLI:

```text
wechatide -c Codex project_import --project /absolute/project
wechatide -c Codex open_project_window --project /absolute/project
```

`project_import` only adds the project to the list. It can return `alreadyImported`;
that says nothing about compilation or a running window. Inspect tool help for the
installed version and check the actual window/runtime after opening.
Import/open may also write project metadata and default configuration fields;
retain the before/after evidence and follow the
[publication comparison](verification.md#account-for-devtools-project-metadata).

One DevTools root process can host projects from several sessions. Resolve the
exact project selector with `project_list` and close only that project through
`close_project_window`. On the qualified case-insensitive Mac, the returned
selector used lowercase `projects` although the imported filesystem path used
`Projects`; use the returned selector. Confirm the target window/renderer retired
before interpreting post-close GPU load. A shared GPU helper can remain busy
after this game's renderer exits; its load is not attributable to the closed game.

For an explicitly requested recovery of an existing window, the installed
`open_project_window --help` confirms that the exact same project is reused.
Check `type: "reuse"` and the existing `winId`; a reuse acknowledgment alone does
not prove OS foreground focus. If native UI control returns `cgWindowNotFound`,
read the Mac console lock flags through `mac_headroom.py` before retrying UI calls.
An OS-locked console can prevent native desktop control, while reopening the exact
project can still restore continuous simulator frames. Verify actual frame
progress after recovery; lock flags or a stale screenshot alone cannot establish
whether the game is executing.

`project_list` is an imported-project catalogue, not an open-window registry;
its scopes are `miniprogram` (default), `other` and `all`. A successfully opened
game can be absent from that catalogue. Preserve the actual `newopen` receipt,
its `winId`, exact project and observed runtime identity. For a window created
by this task, those facts permit closing its exact project even when the
catalogue omits it; compare the close acknowledgement's `winId` with the owned
receipt. Do not infer ownership of an existing shared window from its absence.

When restarting an owned IDE for a required debugging endpoint, preserve its
original launch mode. In the observed Nightly build, replacing a `--cli` launch
with a normal GUI launch automatically restored a historical project and its GPU
work. Re-enumerate actual windows after restart; a new process is not an empty
simulator. If login must wait, close only the verified owned project or owned IDE
and check GPU headroom again before a browser measurement.

## Drive and observe

### Select the actual game realm

On the qualified Nightly 2.02.2610092 simulator, `automation_evaluate` executes in
a driver context. Its `globalThis` does not expose the game module's globals.
For this version, `GameGlobal.__gameContextWindow` is the actual game realm; read
the generated Host's existing inspection there:

```js
function () {
  const game = GameGlobal.__gameContextWindow;
  const state = game?.__forgeaxGameInspection?.renderer();
  return state && { frame: state.frame, completed: state.completed, presented: state.presented,
    error: JSON.parse(JSON.stringify(state.lastError ?? null, (key, value) =>
      value && typeof value === 'object' && typeof value.message === 'string'
        ? { ...value, name: value.name, message: value.message, cause: value.cause }
        : value)) };
}
```

Use the official tool's `--fn-source` argument. This private simulator property is
version-specific diagnostic access, not an Engine dependency or phone API. If it
is absent, use game-emitted build/stage markers; do not infer an unstarted game
from an empty driver global. Serialize Error fields explicitly across the tool
boundary. Do not use this access to modify DevTools settings or credentials.

The qualified driver `GameGlobal.document` exposes `querySelectorAll`, but not
`querySelector`. Select the explicit canvas through the former and check its
cardinality; the driver document is not a full browser DOM. The shader collector
already uses this boundary. Do not assume a game UI's DOM facade applies to the
automation driver too.

Pair an awaited runtime inspection with the official screenshot of that project
window, then inspect the locally copied image returned as `result.artifact`. The
remote `result.path` is on the DevTools machine. Retain startup phase, root failure,
completed count and scene-ready count together: a visible loading/fatal panel and
successful completed UI frames do not prove gameplay presentation. Reacquire state
after input or refresh rather than attaching an earlier success to a later image.

### Inspect the ordinary game's actual UI

Generated Hosts expose the bounded `ui(request)` observation beside `renderer()`
and script `read()`. It reads the current Blitz document, including open ShadowRoots:

```js
function () {
  return GameGlobal.__gameContextWindow.__forgeaxGameInspection.ui({
    selector: 'input, .vase-panel, .languages button',
    styles: ['display', 'pointer-events', 'font-size', 'overflow-x', 'overflow-y'],
  });
}
```

Check the inner `UiResult.ok`, `truncated` and `visited` values in addition to the
official tool envelope. Nodes include real layout rectangles, scroll/client sizes,
control values and validity, plus their owning asset GUID/source path. Source
identity is inherited from the mounted asset; programmatically created startup
controls can correctly have `source: null`. It is not an author line map.
Hidden descendants can retain computed `display: block` while reporting a zero
rectangle because an ancestor is hidden. Do not infer visibility from display alone.

For a tap, use a nonempty rectangle in the current snapshot and query again with
`point: { x, y }` at its logical-coordinate center. Confirm `hit` equals that
node's snapshot `path`, check the actual native capsule, and scale the point using
the current window and personally reviewed screenshot dimensions. Pass the scaled
point to `automation_game_action` with `coordinate-space: image`; the inspector
does not send input. Paths identify only this observation and are not persistent
handles. Reacquire them after language, layout, input or orientation changes.

Check the actual state before using a toggle as setup. A jump journey blindly
"closed" an already closed vase panel, opening it and hiding the Jump button;
the ensuing tap produced no airborne samples. Inspect `aria-expanded`, close
only when needed, then require a nonempty Jump rectangle and a matching hit.
The corrected native tap observed a 1.097-unit rise and return to the same
height without changing game code. Retain the failed setup separately from the
successful run; an unchanged character alone does not identify a physics bug.

Read the player's controls/camera and adopted geometry before and after a passive
query. Distinguish a same-task passive query from observations separated by live
physics frames: a grounded controller can apply tiny contact corrections without
input. A current ordinary journey observed a 0.0001000166 vertical correction
both during look and in a 24-sample no-input control, with exact look XZ stability.
Retain the original mismatch, compare against the same scene's no-input control
and existing physics tolerances, and still require neutral/released controls,
grounding and correct camera changes. Do not weaken a movement or fall failure
into an arbitrary large tolerance. Native editing should update the inspected value/validity/focus, while the
adopted geometry changes only after the actual Generate action. An unexpected
scroll extent is evidence for the layout owner: preserve it rather than clamping
or rewriting the inspection output. Invalid queries and retired Hosts return
structured `inspection-failed` results; never reuse an old document after Reload.

For input sizing regressions, compare the inspected outer rectangle with both
client and scroll extents before editing, while the native keyboard is open,
and after completion. Also change the value between empty, ASCII and a fallback
glyph: intrinsic height should follow the current font strut and line-height,
not the glyph currently displayed. The ordinary `e4e1e95540b2` simulator journey
at DPR 3 observed input outer/client/scroll widths 88/86/86 and panel widths
240/238/238, with input height 30.671875 logical pixels. These are fixture
observations, not hardcoded dimensions for other projects. The previous input
and panel scroll widths 219/369 were genuine native layout failures; the
inspector remains an observation of the owner rather than a place to hide them.

For an ordinary generated Host, reuse the bounded observer:

```bash
python3 skills/forgeax-engine-wechat/scripts/wait_game.py \
  --config /private/wechat-machine.json --project /absolute/remote/game \
  --out /private/run/readiness --timeout 120
```

The output directory must be new. The observer retains every tool result, reads
the qualified game realm, and requires `phase: ready`, at least 60 scene-presented
completions, consistent counters, no current startup/Renderer error, and a copied
official screenshot. It writes `summary.json`; exit 0 qualifies this readiness
checkpoint only. Inspect its image yourself and test interaction separately.
Pending tool results stop observation without polling their task IDs. The deadline
bounds observation; the final screenshot may add 30 seconds. Run the process
asynchronously when needed to keep user progress updates available.

`get_simulator_console --command 'grep -n .'` can omit long structured game errors.
Also query a known short marker, such as `grep -i forgeax`, before concluding that
the application emitted no error. Keep the original returned strings or arrays.

| Need | Official registered tool | Qualification |
|:--|:--|:--|
| Find known projects | `project_list` | Confirm path and project identity |
| Evaluate game runtime JS | `automation_evaluate` | Actual game realm, not the IDE's DOM |
| Tap, swipe, touch lifecycle | `automation_game_action` | Coordinates and sequence match simulator viewport; independent simultaneous contacts need separate qualification |
| Main-screen pixels | `simulator_screenshot` | Inspect the returned image visually |
| Runtime errors | `get_simulator_console` | Preserve raw code/message/stack and build generation |
| Native requests | `get_simulator_network` | Check status, cancellation and request identity |
| Reload current output | `simulator_refresh` | Wait for the new runtime generation and receipts |

Use `wechatide <tool> --help` for current flags. In official skill 0.3.11,
`automation_evaluate` takes `--project` and a parameterless `--fn-source` function;
the removed `--args` option fails with `INPUT_ERROR` / `deprecated_args`. Embed
validated JSON literals in the function when inputs are necessary. It executes
real code, so mutating evaluation needs the same scope as the operation it
performs. A read-only environment observation is:

```text
function () {
  return {
    system: wx.getDeviceInfo(),
    window: wx.getWindowInfo(),
    app: wx.getAppBaseInfo(),
    clockSample: wx.getPerformance().now()
  };
}
```

Pass this as one quoted argument through the wrapper. Missing APIs produce a real
failure to investigate; API existence alone does not establish graphics, Worker or
WASM behavior. Collect capabilities through the owning Engine interfaces once the
ordinary game is running.

## Recover an already saved large report

When native HTTP export fails, preserve its original failure and the saved-artifact
receipt. Domain validation can reject a loopback request even though the simulator
finished the capture. Do not repeat the measurement or toggle debug merely to export
the saved bytes. A large `automation_evaluate` result can also be truncated: the
qualified CLI returned exactly 65,536 bytes of an incomplete JSON envelope for a
4.5 MB report. Increasing the shell output budget does not repair that boundary.

Use [recover_simulator_report.py](../scripts/recover_simulator_report.py) with the
exact user-data file, length and SHA-256 emitted by the original saved-artifact log:

```sh
python3 skills/forgeax-engine-wechat/scripts/recover_simulator_report.py \
  --config /private/wechat-machine.json --project /absolute/remote/game \
  --file 'http://usr/actual-capture/report.json' \
  --bytes 4549226 --sha256 '<saved-artifact-sha256>' --out /private/new-recovery
```

The example path/length must be replaced with the actual receipt. The tool uses
the same version-qualified game realm as readiness inspection, snapshots at most
24 MiB from that game's user-data directory, and reads 32 KiB byte ranges through
official evaluation. Its local base64 encoder needs neither `btoa` nor
`wx.arrayBufferToBase64` (the latter was absent in the qualified simulator).
It retains private tool receipts and releases its temporary game snapshot after
success or failure. Runtime replacement or a pending/failed tool call stops the
copy; there is no rearm, phone operation, debug change or automatic retry.

Only a matching byte count and original SHA-256 publish `recovered-report.json`.
`success: true` means byte recovery; the original report's `status` and `failure`
are preserved separately and can still say `partial` or `failed`. Incomplete
copies remain `report.partial`; never analyze one as a complete report. Check
`snapshotReleased` and any `cleanupFailure` before closing the owned simulator.
The default total deadline is 600 seconds; each evaluation is bounded to 30 seconds
and final cleanup to 20 seconds. Run asynchronously so progress remains visible.

The regression covers byte-exact UTF-8 recovery, corrupt
hash/range rejection, cleanup after an ambiguous open failure, and the serialized
JavaScript encoder without a native base64 API.

```sh
python3 -m unittest discover -s skills/forgeax-engine-wechat/scripts -p test_recover_simulator_report.py
```

## Representative sequence

Use the same authored game and operation sequence as the browser reference. Wait
for a successful startup and at least 60 successful completed Renderer frames, then
capture the main canvas. Exercise gameplay input and its visible/World consequence;
open menus and edit controls using actual input. Background and foreground the game,
resize/change orientation when the qualified tool exposes it, reload, and repeat.
Record unsupported automation actions as missing evidence rather than substituting
an unrelated page or claiming a callback emulates native lifecycle.

### Native orientation and current image coordinates

The official [Mini Game `wx.setDeviceOrientation` API](https://developers.weixin.qq.com/minigame/dev/api/device/orientation/wx.setDeviceOrientation.html)
accepts `value: 'portrait' | 'landscape'` and success/fail/complete callbacks from
base library 2.26.0. It does not provide native Promise style. Call the actual
game realm's API, keep its original callback result and bound any asynchronous
observation. Do not change the package's `game.json`, DevTools settings or canvas
dimensions to imitate a native transition. PC fullscreen is excluded by the API.

Observe both `onDeviceOrientationChange` and `onWindowResize` through temporary
passive listeners with matching cleanup. The qualified Nightly simulator emitted
only the orientation event after a successful portrait request: `getWindowInfo`
changed from 844 x 390 to 390 x 844 at DPR 3, but no window-resize event followed.
The earlier Platform subscribed only to window resize, leaving its ordinary
Host's canvas at 2532 x 1170; the official portrait screenshot visibly stretched
the landscape scene and UI. This is a missing Platform display event, not shader
or material evidence. Both native notifications now use the existing validated
display projection; Host owns canvas/UI resizing.

Read actual native window/safe-area facts and the selected canvas's drawing extent,
then obtain and personally inspect a new official screenshot while ordinary
Renderer completions continue. API success and a portrait screenshot extent alone
do not prove that the game rendered portrait. Preserve the first mismatch and stop
dependent input until its owner is repaired.

When those dimensions agree but the image is cropped or stretched, compare the
actual GL viewport and `renderer().output.presentationProof` with the captured
scene, UI and swapchain texture extents. The next observed failure had a correct
1170 x 2532 canvas, scene and UI, but the native Surface and final viewport still
used 2532 x 1170. The real frame tape traced FXAA and `screen-ui-composite` into
that old swapchain. This belongs to RHI surface acquisition/configuration; changing
CSS or the camera cannot repair it. The adapter now follows canvas extent changes
through its existing configuration and image-retirement path. A seedless tape
qualifies these dimensions and dependencies, not replay pixels.

If the final target extent is correct but only the 3D scene is stretched, inspect
the actual submitted View projection. In the next captured failure, the full
View uniform retained aspect 1.777777806 while the portrait target required
0.462085308. The native Host had omitted the App's existing camera-aspect policy.
Browser and native hosts now share that policy; Renderer continues to consume
the camera rather than mutating World. Keep this distinct from Surface resizing:
the first repair fixed cropping, while the second fixed scene proportions.

Read `wx.getMenuButtonBoundingClientRect()` in the actual game realm when controls
approach the native capsule. The qualified portrait simulator reports logical
left/top/right/bottom 292/44/380/76; these are observations for that environment,
not portable constants. Reflowing the original language controls in the guide's
Grid removed the overlap without a separate native UI. Confirm both languages
with actual taps, then open the original numeric editor and generate geometry;
layout appearance alone does not establish that native chrome leaves hits free.

Recalibrate input against the new image, whose extent can differ from logical
window pixels. In the failed observation, the screenshot was 591 x 1280 while
the logical window was 390 x 844. Persist touch coordinates together with their
image width/height so cleanup can release a contact using the same mapping after
a failed step. A drag on content that fits is not scrolling evidence: compare
actual displaced content, then confirm UI input did not move the game. Restore
landscape through the same native API and remove only this run's listeners.

### Native startup modal

An early failure before portable UI is ready can use `wx.showModal`. Inspect its
actual screenshot and the generated entry's JSON-safe
`__forgeaxGameInspection.error`; the concise modal message does not replace the
complete original cause and cleanup diagnostics. A screenshot taken after a state
read can already show a later startup phase, so read again before asserting the
failure state.

On Nightly 2.02.2610092, the game's `automation_game_action` touchstart/end returned
success without reaching the native modal's Reload button. A coordinate
`automation_element_action tap` returned `timeout waiting for automator response`;
the game driver's document contained no native-modal button. Retain this as an
automation limitation. Use a separately qualified control of the actual native
button when available; invoking its saved success callback only tests the local
Host contract. Native recovery requires actual confirmation, the original display
Canvas, fresh ordinary scene completions and recovered authored input. A locked
desktop with no working modal control leaves that target check unverified.

For UI, cover the whole current authored surface: layout including Grid, ShadowRoot
styles/events, dynamic numeric values, focus, scrolling, UI/game input isolation,
startup/fatal panels and Reload. Capture before/after images and runtime state for
the same actions. A screenshot without interaction does not prove the form works.

Keep an ordinary game build immutable during a run. If code changes, refresh/import
the new output, record its identity, and reacquire every runtime handle. A successful
evaluation of stale code is not evidence for the new build.

## Reproduce the native host fixture

In an Engine source checkout with dependencies and the Platform dependency built:

```bash
pnpm --filter @forgeax/engine-platform-wechat build:probe --appid wx0000000000000000 --out /absolute/new-fixture
```

Supply the user's actual local AppID. Transfer the resulting files to the DevTools
machine, import/open that directory, and use the tools above. The producer refuses
an existing output directory and prints the emitted game.js digest. Match the
`FORGEAX_HOST_PROBE_COMPLETE` log, clock measurement and visible touch count with the
same screenshot; callback count is only a platform test. The owner source is
`packages/platform-wechat/__tests__/native-host-probe.ts`.

After the checkpoint the fixture keeps sampling input through the actual
World/InputFrameStartScan system. A tap at logical `(110, 215)` on the qualified
390 x 844 / DPR 3 simulator produced ordered down/up at drawing coordinates
`(330, 645)` in `FORGEAX_HOST_INPUT`, with `pointerLocked: false`. Check the actual
display facts before reusing these expected coordinates on another target. This
qualifies native input acquisition; UI focus routing and gameplay remain separate.

If refresh runs old source, compare the transferred digest and emitted marker first.
For this disposable fixture, clearing only its compiled cache through
`debug_clear_cache --action cleanCompileCache` and refreshing recovered source
freshness. Do not clear user storage, authentication or unrelated project caches.
A closed window may retire after its close acknowledgement; reopening immediately
can reuse that retiring window. Verify the new runtime before evaluating.

After replacing a flat project with a subpackage build, the qualified DevTools
window once rejected `game.json: subpackages[0].root does not exist` although SSH
confirmed the directory and its `game.js`. Clearing compile cache alone did not
refresh that file tree. Closing and reopening only that project's window restored
compilation with the unchanged `root: "payload/"`. Check actual files first;
do not rewrite a valid package configuration to hide an IDE file-tree problem.

## Bounded console queries and subpackages

The qualified official CLI truncated a large console response at 65,536 bytes,
leaving invalid JSON. Query an exact, low-volume marker; stop a failing fixture
after its first structured error instead of emitting the same error every frame.
The wrapper retains raw stdout/stderr when no complete envelope can be parsed.

A Mini Game subpackage's `game.js` executes during `wx.loadSubpackage`. Keep its
program in that entry or modules it imports. In the qualified simulator, requiring
`./graphics/probe.js` from the main package after the load callback returned
`module is not defined`; use the native subpackage entry execution boundary.

## Native keyboard round trip

For a keyboard that immediately closes, use `trace_simulator_keyboard.py` with
`--config`, the exact `--project`, a new `--out` and `--action install`. Perform
the original tap, then use `--action read` and finally `--action release`, each
with its own new output directory. The bounded observer records native show/hide,
keyboard, window, visibility and touch-cancel events with the existing UI focus
path. It records input lengths, never entered text; the hide call retains a short
stack. Its own callbacks/method wrappers retire automatically after 120 seconds,
and explicit release removes its simulator handle. Preserve unavailable hooks.
This is intrusive input diagnosis, not a performance sample. A keyboard staying
open here is a simulator control, not evidence that the phone issue is resolved.

On the phone, `diagnose_phone_startup.py --observe-startup --observe-keyboard`
reuses that same observer for a 60-second window after the first ready scene
snapshot. Keep the existing source-bound receiver and reviewed native-input
workflow. Scene completion remains independently required; keyboard traces do not
qualify editing success or FPS by themselves.

The qualified official Mini Game touch tool does not expose typing. Tap a real
Blitz input first and inspect the native keyboard in `simulator_screenshot`.
`automation_element_action input` timed out on this Mini Game; it did not prove
that keyboard editing failed.

For the native API route, write `[{"value":"0.9"}]` to a private JSON file **on the
DevTools machine**, then call:

```text
wechatide -c Codex automation_wx_api --project /absolute/project --action call --method updateKeyboard --args-file /absolute/keyboard-args.json
wechatide -c Codex automation_wx_api --project /absolute/project --action call --method hideKeyboard
```

Skill CLI 0.3.11 advertises `--args` in this tool's help but rejects it with
`deprecated_args`; `--args-file` works. Use `call`, not `mock`. After closing the
keyboard, tap the actual submit button and inspect the game-consumed value. The
qualified guide diagnostic changed radius from `0.75` to `0.9` through this path.
This covers native API display/completion and the real form callback, not physical
keystrokes, selection ranges, composition phases or phone behavior.

The same real API route also qualified the ordinary game: three edited values
changed the actual vase geometry while player position and camera stayed fixed.
It can be issued through the existing SSH CLI while the desktop is locked; the
official contract does not provide or qualify physical typing through the lock
screen. `automation_game_action` exposes only tap/swipe/touchstart/touchmove/touchend;
the page-element `input` action requires a selector and is not a Mini Game keyboard
driver. Use discrete touchstart/move/end if the official swipe action times out,
and keep that tool failure separate from game input results.

### Preserve the default value and unlimited HTML input

The [Mini Game keyboard contract](https://developers.weixin.qq.com/minigame/dev/api/device/keyboard/wx.showKeyboard.html)
requires `maxLength` but does not define HTML's `-1` sentinel. The ordinary game
passed `defaultValue: "2.4"` correctly with `maxLength: -1`, yet the qualified
simulator displayed an empty native editor and closing it cleared the untouched
field. A controlled observation changed only the native maximum: `2147483647`
displayed and retained the default, and 200 digits survived real `updateKeyboard`
and `onKeyboardComplete` exactly. A smaller `140` value also restored the default
but would add an unrelated authoring limit.

`platform-wechat` now projects absent HTML `maxlength` to that finite maximum and
preserves explicit nonnegative limits. Keep this adaptation at the native boundary;
do not ignore empty completion values, which must still support intentional deletion.
The controlled native observation and [adapter regression](../../../packages/platform-wechat/src/__tests__/keyboard.test.ts) are evidence for the
repair; verify the rebuilt ordinary package before treating it as deployed.
