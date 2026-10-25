# Sources and observed tooling baseline

Each dated section describes its own source, workload and target. A historical
"not qualified" statement is not a current unsupported-feature declaration;
consult the current owner contract and newer evidence before deciding what needs
retesting. The [field guide](field-guide.md) routes reusable decisions without
requiring a replay of this history.

## Authorities

| Source | Use |
|:--|:--|
| [Official DevTools downloads](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html) | Supported platforms, channels and release notes |
| [Live version metadata](https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/config.json) | Current exact download selection; consumed by download_info.py |
| Installed `wechatide-skill/SKILL.md` and its `tools.yaml` / tool index | Exact executable tool contract matching the installed version |
| Installed `references/environment-readiness.md` | Setup and status interpretation |
| Installed `references/approval-policy.md` / `references/async-task-polling.md` | Client authorization, CLI/MCP tokens, pending task behavior |
| [Mini Game Performance.now](https://developers.weixin.qq.com/minigame/dev/api/base/performance/Performance.now.html) | Native microsecond unit |
| [Mini Game documentation](https://developers.weixin.qq.com/minigame/dev/guide/) | Current native APIs, build/subpackage limits and target restrictions |
| [Mini Game showKeyboard](https://developers.weixin.qq.com/minigame/dev/api/device/keyboard/wx.showKeyboard.html) | Required default value and maximum length; no HTML `-1` sentinel is documented |
| [Mini Game setDeviceOrientation](https://developers.weixin.qq.com/minigame/dev/api/device/orientation/wx.setDeviceOrientation.html) | Since base library 2.26.0: callback-based `landscape` / `portrait` requests; successful calls trigger `onDeviceOrientationChange`. Actual window, canvas and scene output still require target qualification. |
| [Mini Game createWebAudioContext](https://developers.weixin.qq.com/minigame/dev/api/media/audio/wx.createWebAudioContext.html) / [WebAudioContext](https://developers.weixin.qq.com/minigame/dev/api/media/audio/WebAudioContext.html) | Native graph and lifecycle API; validate actual listener/panner AudioParam shape and decode behavior on the target |
| [Code package contract](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/code-package.html) | On 2026-10-10: 30 M total, 4 M main, no individual subpackage limit. On 2026-10-11 official `auto_preview` rejected 22,101 KB at its 20 MB limit (code 10); the build budget follows preview admission. |
| [Mini Game subpackage loading](https://developers.weixin.qq.com/minigame/dev/guide/base-ability/subPackage/useSubPackage.html) | Directory root uses `game.js`; `loadSubpackage` executes code after downloading, while `preDownloadSubpackage` only downloads |
| [WXWebAssembly](https://developers.weixin.qq.com/minigame/dev/guide/performance/perf-webassembly.html) | Native package paths accept `.wasm` and `.wasm.br`; Brotli support starts at base library 2.14.0 |
| [FileSystemManager.readCompressedFile](https://developers.weixin.qq.com/minigame/dev/api/file/FileSystemManager.readCompressedFile.html) | Base library 2.21.1; reads Brotli from code-package or user-file paths as decompressed bytes |

The Tencent `wechat-miniprogram/ai-mode-skills` repository serves AI application
interfaces/components. It is not interchangeable with the installed DevTools AI
skill used for game import, runtime evaluation, input and simulator screenshots.
Read current official quotas instead of freezing older upstream limits here.

## Observed on 2026-10-10

| Item | Observed result |
|:--|:--|
| Target machine | macOS 26.3.1, ARM64, interactive desktop session |
| Distribution | Official Nightly 2.02.2610092, Electron 36.6 package |
| Install provenance | Tencent Developer ID Installer signature, Apple notarization; app code signature checked |
| User-local installation | Signed app payload copied into user Applications; absolute CLI path used |
| Official skill | Version 0.3.11; installation diagnostic passed |
| Official AI CLI | `check_wechatide_status` and `login --type image` returned structured results |
| Client first use | Actual visible Allow dialog enabled the service port; no profile/token edits |
| Token distinction | `cliTokenRequired: false`, `mcpTokenRequired: true`; CLI remained usable |
| Remote QR capture | Official inline JPEG extracted locally; direct macOS desktop capture was unavailable |
| Game tool help | `automation_evaluate` explicitly documents Mini Game runtime; actual game qualification is still required |

These are setup observations, not Engine or phone compatibility claims. Replace or
extend a row only with fresh evidence, and retain the environment/version scope.
Machine addresses, personal AppIDs, login state and credentials belong to the local
run, not this reusable baseline.

## Native simulator findings from the same session

| Observation | Implementation consequence |
|:--|:--|
| Real game module rAF returned an object token stringifying as `9999`; AI evaluate returned a number | Retain the actual opaque token and return it unchanged to cancellation; qualify the game module itself |
| DevTools device platform is `devtools`; native clock delta 255.4, normalized delta 255.3 ms, independent wall interval 256 ms | Explicit DevTools millisecond branch; device documentation still specifies microseconds, requiring separate phone measurements |
| Main canvas 390 x 844 logical, DPR 3, drawing buffer 1170 x 2532 | Preserve logical/drawing/safe-area facts independently |
| Corrected host probe rendered 120 native callbacks, canceled callback did not run; official tap changed visible touch count from 0 to 1 | Native host fixture and AI input/screenshot route exercised; still not 60 Renderer receipts or a 3D game claim |
| Native touch adapter plus real World/InputFrameStartScan observed ordered down/up at logical (110, 215), drawing coordinates (330, 645), with pointerLocked false | Actual native input reaches the ordinary InputSnapshot contract; no fabricated mouse or pointer-lock state |
| `simulator_refresh` initially retained earlier compiled source after file copy | Verify a build marker; `debug_clear_cache --action cleanCompileCache` followed by refresh selected the updated fixture |
| Immediate reopen after close returned `reuse`, then the window disappeared | Close acknowledgement precedes full retirement; reacquire an actual new window before evaluating |
| `automation_evaluate` did not expose the game module's assigned `GameGlobal` property | Require a known realm/build marker or use explicit game logs; tool success alone cannot identify the application's realm |
| Owner-generated native wgpu binding initialized in 257.3 ms; actual native main Canvas/context admitted without browser constructors | Use the verified `wgpu-wasm/native-build` producer and platform's immutable-path native loader; never intercept global WebAssembly |
| RHI clear submitted and native WebGL2 fence completed; pixel `[26,102,178,255]`, GL error 0 | Native graphics boundary qualified for this simulator; no ordinary game/Renderer receipt claim |
| Official console queries with `grep -n .` omitted some long entries and `tail -n 15` returned empty | Query a specific producer marker as well; empty tool output never proves an error-free runtime |

Blitz source, locked build recipe, observed costs, known gaps and the reproducible
Grid fixture are maintained in [Blitz](blitz.md). Neither graphics nor layout
fixtures qualify the complete authored UI or phone execution.

## UI qualification on 2026-10-11

The clean Blitz fork `684ee232` and matched WASM identity are recorded in
[Blitz](blitz.md#measure-the-current-wasm). These observations used that publication:

| Path | Verified result and limit |
|:--|:--|
| Native Bullet registration, real WASM | Closed/open disclosure and inside/outside disc, circle, square and ordered markers matched the explicit-font reference; prepared Host fonts no longer suppress the builtins. This does not add arbitrary authored Unicode coverage. |
| Native checkbox/radio, real WASM and sandboxed Chromium | Pointer/label/Space/radio-arrow behavior, current/default checkedness, form/name groups, event order and canceled preactivation passed; real pointer captures changed checkbox/radio state from `[false,true,false]` to `[true,false,true]`. No official WeChat checkable-control run was performed. |
| Full guide, official simulator native 2D canvas | Real Generate tap delivered `{height:2.4,radius:0.75,sides:32}` once; the fixture's intentional failure response restored retry controls; real French tap updated the authored guide. This qualifies number/localization controls, not ordinary Renderer composition or phone behavior. |
| Actual native bundle | UI parser/resource projection used css-tree's published portable ESM entry; no Node `module/createRequire` shim was required. |
| Ordinary UI source publication | Absolute-disk source → importer → HTTP publication → AssetRegistry decoder regression failed before the sourcePath repair and passed afterward, including localization and image bytes. Linux/Windows path tests retain dependency identities. This is a loading regression, separate from full game startup. |
| Ordinary game-3d, sandboxed Chromium with `wgpu-webgl2` | Full scene and UI rendered through 62 completed Renderer frames; English/French actions worked; changing values to `{height:3.2,radius:1,sides:24}` kept the vase GUID/entity, changed its bounds and reduced vertices from 495 to 375. Editing UI with W/Space retained the player's position and unlocked camera while simulation advanced. This browser result does not qualify the ordinary WeChat package or phones. |

Static unchecked screenshots cannot qualify `.checked` mutation: an earlier
unsupported facade assignment only created an expando while native pixels stayed
checked. Preserve that failure separately from the final real-input evidence.

## Settings controls on the current native publication

The official Nightly 2.02.2610092 simulator qualified the maintained `--scene settings`
fixture at 390 × 844 on 2026-10-11. It used clean Blitz fork
`0b2252f8447b74ce0051f65e81db66c21e6051f6`, WASM SHA-256
`57a4245c661a4f43cde1b99c7d2ae8a6c3b304f0136520ff31b88d98b1682208`
(16,495,694 bytes), and live `programSha256`
`a066906e752b6addc45c7368b067e1100c94bd052d3cea394442b792fff75358`.
The complete emitted `ui/game.js` SHA-256 was
`60af9981af8561b3e15fd06eb27fb6b97e8633839cb3c653dfac03c0bdf69339`.
The producer's live identity matched after clearing only that project's compile cache.

| Observation | Result and owner |
|:--|:--|
| Exact settings UiAsset and real `mountSettings`, public WeChat input backend | The untouched HTML/CSS displayed music 70, FXAA and checked Bloom. Real taps opened the None/MSAA/FXAA popup and selected None, then MSAA. |
| Range, checkbox and color operations | Taps produced 25 then 75; the real 0→100 drag emitted `input:0`, `input:100`, `change:100`. Bloom changed to false, music mute to true, and clear color to Purple. The controller state matched each native control. |
| Close and reopen | Done hid the modal; the real controller's `open()` restored the modified state. The terminal snapshot recorded 16 paints, 12 touches, 17 ordered input/change events, no errors and `focusedText: null`. Initial, popup, range, checkbox, hidden and reopened screenshots were inspected. |
| Labeled select failure before the fix | A real tap first caused unbounded label→select→label activation, then later native calls reported WASM `borrow_fail`. The same full UiAsset reproduced stack exhaustion and poisoned cleanup in real WASM. Including select/textarea in the TS activation candidates fixed direct clicks and label-caption forwarding; disabled/canceled cases and all 26 UI browser differential tests passed. Rust/WASM bytes were unchanged by this repair. |
| Font path failure before the successful run | `readFile` rejected `ui/font.woff2`. Regenerating through the maintained builder's permitted `ui/font.ttf` path retained the exact Noto WOFF2 bytes and license, and the native decoder rendered them successfully. |

This is native 2D UI-owner evidence from a separate fixture. It qualifies the stated
controls, labels and controller behavior, not radio controls, ordinary 3D composition,
Renderer completion, physical typing or phones. See [the reproducible settings route](blitz.md#actual-settings-controls).

## Ordinary package diagnosis on 2026-10-11

The earlier failed runs remain useful diagnosis. The later ordinary-project run
qualifies scene/UI presentation and the stated form operation; it does not qualify
phone targets, complete touch gameplay or every lifecycle case.

| Observation | Owning consequence |
|:--|:--|
| Publication capture repeated native reads for resident identity artifacts; its fixed path passed identity reuse, mutated-byte rejection, raw zstd preservation, bounded complete closure and retry regressions | Use the [existing capture cache and revalidation path](engine-integration.md#publication-capture-and-resident-bytes), preserving original transport bytes for encoded bodies. This does not implement a persistent WeChat cache. |
| The rebuilt ordinary package passed the formerly timed-out activation, then failed with App `render-system-no-camera` observations; state showed 20 completed frames and 0 scene-presented frames | The App loop started before root activation while UI-only selection ended at shader readiness. Diagnose [scene admission](engine-integration.md#separate-graphics-readiness-from-scene-admission); this no-camera occurrence was early extraction, unlike the older failed-root cleanup occurrence. |
| The official tool's driver global lacked the game inspection; the actual game realm exposed the phase, completed/presented counters and structured causes | Read the [qualified game realm](simulator.md#select-the-actual-game-realm), pair it with the official screenshot, and keep the failed result. CLI exit success does not imply game success. |
| Ordinary game build manifest SHA-256 `f984be35a11b8f590c4f7f329ab562a46d9ec917b2cc73c1a14701e1dea32da5` reached 61 scene-ready completions, then 239 completed / 214 presented with actual scene and guide pixels | Scene admission and one-acquisition-per-submit Surface lifetime repairs closed the earlier 20/0 failure. These are Renderer receipts from the ordinary App/World/Catalog path, not the independent 2D fixture. |
| Real French tap, three focused native `updateKeyboard`/`hideKeyboard` edits and Generate changed values from `{height:2.4,radius:0.75,sides:32}` to `{height:3.2,radius:1,sides:24}` | Same vase GUID/entity, vertices 495→375 and bounds changed; Renderer remained alive at 500 completed / 475 presented. Player position/facing/camera stayed at baseline while simulation advanced. This qualifies native API form editing and UI/game isolation, not physical typing or phone input. |
| Discrete official game touchstart/move/end succeeded, but the same build's keyboard/mouse-only template left player/camera unchanged at 565 completed / 540 presented | Touch gameplay remained a template consumer gap. Do not claim it from the successful form operation; preserve the native input and World repro while fixing the consumer. |
| A temporary failure in the actual game's `wx.showKeyboard` produced `platform-operation-failed` with the original cause, then real Diagnostics and Reload taps reached generation 2 at 83 completed / 62 presented without errors | The ordinary runtime-failure surface, disclosure and same-Host restart were exercised. Restore the original function immediately after injection; a successful `automation_wx_api mock` response had not affected this game realm and did not reproduce the failure. The reusable [readiness observer](simulator.md#select-the-actual-game-realm) captured the restored run. |
| The actual game passed `defaultValue: "2.4"` and `maxLength: -1`, but the native keyboard displayed blank and an untouched close cleared the field; changing only the maximum to `2147483647` preserved the displayed default and 200 digits completed exactly | Mini Game documents no HTML `-1` sentinel. The [native keyboard adapter](simulator.md#preserve-the-default-value-and-unlimited-html-input) maps unlimited HTML input to a finite signed-32-bit maximum, preserving authored nonnegative limits and genuine empty edits. Adapter/input regressions, typecheck, lint and build passed; the final rebuilt package requires its own observation. |

## Ordinary package using the a78d9bd SDK native publication

The official simulator independently qualified manifest SHA-256
`aee801a9623de1d9608f41ca41dd901e112f627f8fc7cfe760a43c9364733038`,
containing the [measured SDK WASM](blitz.md#measure-the-current-wasm).
Generation 1 reached 180 completed / 153 scene-presented frames. Real movement,
look and release passed; opening and dismissing the native keyboard retained
Height `2.4` through Generate. French selection and native API edits changed the
same vase from 495 to 375 vertices at `3.2 / 1 / 24`.

A self-restoring actual `wx.showKeyboard` failure exercised collapsed/expanded
Diagnostics with correct disclosure markers and the original cause. Actual Reload
reached generation 2 at 81 completed / 61 presented; the terminal observation was
96 / 76 with no errors. All 11 screenshots were inspected. The deployed manifest
and compressed UI payload stayed unchanged across the sequence.
This result qualifies this ordinary package and native API editing; physical
typing, phone targets, Tauri and the SDK's other consumers remain separate gates.

## Orientation-only display event on 2026-10-12

The ordinary SDK publication with manifest
`cbf1d80370fe1fcac601764a9807313cc285b9a517a3a238b4ee71b57b1bebd1`
ran under official Nightly 2.02.2610092. Real French/English taps updated its HUD
and form toggle while player, camera and vase stayed unchanged. Four original
language screenshots were inspected; number labels and explanatory form text
remained English as authored.

The real `wx.setDeviceOrientation({ value: 'portrait', ... })` returned
`setDeviceOrientation:ok` and emitted `DeviceOrientationChange` with `portrait`.
Native window facts changed from 844 x 390 to 390 x 844 at DPR 3, including the
portrait safe area. No `WindowResize` event arrived. The game canvas remained
2532 x 1170 and the 591 x 1280 official screenshot stretched its landscape scene
and HUD. Generation 1 continued from 7786/7761 to 7958/7933 completed/presented
frames without errors. The orientation journey correctly rejected this result;
continuing frame counters did not hide the display failure.

The [Platform owner](../../../packages/platform-wechat/README.md) now projects both
native notifications through the same validated display event and existing Host
resize path. The observed event sequence failed its deterministic regression
before the repair and passed afterward, including safe area, invalid display,
reverse subscription rollback and disposal. This source repair still needs the
next ordinary publication's genuine portrait/landscape journey; the failed package
does not qualify portrait forms, scrolling or phones. See the
[native orientation procedure](simulator.md#native-orientation-and-current-image-coordinates).

## Native queue and binding retirement on 2026-10-13

The final source of [PR #3869](https://github.com/ForgeaX-Games/forgeax-engine/pull/3869),
`7c90ac2b04c69b50b3d662c63fe5b417cbcc6b92`, combined the WeChat sync-status adapter,
native wgpu queue-completion retirement, binding registry/descriptor cleanup and
Renderer completion-failure admission. The published evidence
contains source-bound CSVs, browser regressions, actual-phone images and numeric
interaction results; raw device/account reports remain private.

| Observation | What it established |
| --- | --- |
| Failing ordinary-phone source exhausted 4 GiB near 6,000 scene frames despite active JavaScript finalizers | Wrapper GC and an independent GL fence did not establish native wgpu retirement. |
| Native completion repair reached 9,009 frames at 68.1875 MiB, with slow residual growth | Fence backlog was controlled; binding lifetime still needed its own diagnosis. |
| Repeated actual WebGL resource batches exposed retained views, samplers, bind-group layouts and creation descriptors | Release registry leases symmetrically; borrow temporary descriptors. Native bind groups/pipelines must remain valid after source wrappers retire. |
| Final phone idle run completed 10,013 scene presentations; 382 consecutive capacity samples stayed at 44.4375 MiB for 383.315 seconds | No further WASM capacity expansion in that workload/window. This is not process/GPU-memory or indefinite leak-freedom evidence. |
| Separate phone run completed 5,009 presentations with actual movement, look, jump, release and keyboard taps | `3`, `.`, `5` entered `3.5`; sides `16` regenerated the same vase GUID/entity from 495 to 255 vertices with the expected bounds and ready material slots. |
| Final snapshots remained healthy; four GL collector installation/restoration notes remained | Coverage notes are distinct from native thrown calls. Missing records and bounded sample drops must remain visible in analysis. |
| Both diagnostics were retired, original stay-awake settings restored and ordinary preview delivered through official `auto_preview` | Tool cleanup and source restoration were verified independently of diagnostic success. |

The full-source CI passed, including all 20 required checks. Those checks and the
phone diagnostics do not establish stable 60 FPS during continuous gameplay.
Use [memory diagnosis](memory-diagnosis.md), [parameter receipts](android-device.md#parameter-interaction-receipts)
and [performance](performance.md) for the reusable methods and their current tools.

## Maintained startup diagnostics on 2026-10-24

The ordinary game-3d publication was rebuilt from the source worktree, retaining
187 artifacts and 16,951,275 artifact bytes. Manifest
`ea428c09eab94cdb64cf38b637855741760f8e2388f2d4ac0b4382835dbb32fa`
and root entry `05340a35a39193df0d544f0fb9cfb161244f295a40e77413d9ebb66e2b2794b1`
identify this candidate; these are historical identities, not current release claims.

The maintained `diagnose_phone_startup.py --observe-startup` route, with no
generated-chunk edits, delivered six early checkpoints and one 4,269-byte terminal
report through an explicitly owned ADB reverse. The receiver verified source/run
identity and exact body hash
`f95e33650f643538a271c744156d72a6314dc61f00a6cb3b2b5d27ff8f3b09c6`.
A reviewed Android screenshot matched that run's native caption. The native
package hook retained accessor-backed `errMsg` and `loadInfo`, while the generic
serializer continued marking those original accessors unavailable.

The result was `startup-failed`: `wx.loadSubpackage('payload')` returned
`loadSubpackage:fail module not found (no errMsg)` after 30.254 seconds;
`loadInfo` reported `loaded:false`, `progress:0`, `hitOptimizations:{}`. No Host,
WASM instance, GL context or scene presentation had started. Static analysis
found 45 JavaScript files with all eager literal references present; a deferred
external import and eight computed requests stayed explicitly unqualified.
This establishes diagnostic collection and the failing native admission boundary.
It does not establish a missing on-disk module, a network/driver cause, scene
correctness or any FPS result.

A second run of the same frozen publication opened and then closed only its
owned official project window before preview, checking the documented IDE file-tree
recovery. The receiver started after that simulator retired. The phone again
returned the same native error after 30.258 seconds with `loaded:false` and
`progress:0`. That recovery did not resolve this native failure; do not cite the
earlier simulator file-tree incident as its established cause.

A third run entered through an official preview QR, with the user's scan and a
matching Android run caption. It returned the same error after 30.297 seconds.
Changing preview entry did not resolve the failure; ordinary follow-up continues
through automatic preview rather than requiring repeated scans. All three runs
retained the same native AppBrand process, so they do not establish behavior in a
fresh native process.

The user then restarted WeChat; the prior AppBrand PID was verified absent.
Automatic preview of the same candidate still failed after 30.253 seconds in
the new native process. The maintained package controls narrowed the boundary:

| Diagnostic control | Native subpackage bytes | Native callback result / elapsed |
| --- | ---: | --- |
| Dependency-free entry, retaining every other payload file | 16,948,293 | Same failure / 30.225 s |
| Empty subpackage, dependency-free marker only | 135 | Marker executed / 0.373 s |
| Non-JS resources retained, other JS/MJS/CJS removed | 10,321,350 | Same failure / 30.261 s |
| Marker plus unchanged UI WASM | 2,249,507 | Marker executed / 18.068 s |
| Marker plus unchanged UI and wgpu WASM | 3,521,877 | Same failure / 51.686 s |
| Marker plus unchanged wgpu WASM | 1,272,505 | Marker executed / 10.172 s |

All results used source/run-bound hashed reports and official automatic preview;
the original distribution was preserved. The empty control proves native loading
can work with that configuration. Failure without other JS means the deferred
Node transport import is not required to reproduce it. The varying callback
times do not establish a universal 30-second limit, a fixed package-size cap,
network throughput or a WASM compilation cause. Native task progress and separate
CPU observations are needed to distinguish those hypotheses. These controls
activate no Engine scene and cannot provide FPS evidence.

Offline collector/native-hook, real loopback receiver, clone/module-closure and
reverse-port regressions passed, as did the generated Host's real Cordis Fiber
inspection tests. Required rendering gates still had separate browser alpha-hash
and Dawn SSR pixel failures; there was no all-green delivery or 60 FPS acceptance.
Use [the maintained startup workflow](android-device.md#retrieve-structured-startup-errors)
for future investigations and keep raw phone/account artifacts private.

### Network recovery and the subsequent completion failure

The generated root's native task progress exposed a later failed full-package
download at 30%, or 3,600,483 of 12,204,242 wire bytes, despite the native failure's
`loadInfo` claiming zero progress. After the user connected Wi-Fi and disabled
the phone VPN, the same frozen publication
`a61656f3ee51e0abc81c346ac814ccd7dca9fd4c9c4ed6d91dc652d2050105b2`
loaded the subpackage successfully in 2.069 seconds. This qualifies an environment
change, not an Engine optimization, and does not identify the individual network
cause.

Startup then failed in native queue completion before any scene frame. Polling
the actual ticket before applying an expired deadline repaired a separate late-wake
bug in deterministic tests, but did not resolve this phone failure. The following
source-bound publication
`fbb96812c6d8262ebc617041f30d0644d5b939342d2d98d24c2a367e7fe13fc7`
retained 40 actual polls over 123,058 ms, with a maximum inter-poll gap of
123,011 ms and a final incomplete native ticket. Resource trace events continued
through that gap; their maximum adjacent gap was 3,395 ms. Only the first periodic
checkpoint ran. These facts select Host execution/scheduling and asset preparation
for further diagnosis; they do not establish a 123-second GPU workload.

Separate native instantiation observations completed UI, wgpu, Basis and Rapier
WASM within 148, 42, 10 and 17 ms respectively in one run. Callback delivery timing
is included, so these are not pure compiler timings. Disabling the native diagnostic
loading/result UI still reproduced the completion failure, and an unchanged ordinary
publication remained on its loading screen. Neither control established a scene
pass or 60 FPS. Do not loosen completion bounds or remove asset integrity checks
to turn this startup failure into an apparent pass.

The maintained per-URL package-reader counters then exposed 592 reads of the
23,476,844-byte material Bundle. These counters include retained transport
responses, so they must not be described as 592 native filesystem reads. The
fixed dependency capture cached native bytes but recreated a whole response and
verified the complete Bundle for each of its 591 artifact references. A Mac
regression reproduced 24 complete-Bundle hashes for 24 references, in both cold
and Registry-owned capture. The Engine repair verifies each captured URL/digest
once and still verifies all 24 individual artifacts; corrupt bytes in a later
capture still fail. All 1,049 Assets Runtime tests passed.

The rebuilt ordinary publication
`f0b5df26ef5502a37e2a9378edd006f26c0aafd4f572c3b9130b536a1f476d3e`
reached ready on the phone and produced 61 new scene-ready completions by
17.028 seconds from diagnostic startup. The material Bundle's package-reader
count fell to two (ordinary source loading plus capture), with no current Renderer
error. A reviewed screenshot showed the complete scene and controls. The same
ordinary publication also reached ready in the official simulator. This resolves
the reproduced startup stall; neither those frame counts nor the displayed FPS
overlay establishes stable 60 FPS. The user observed under 30 FPS on the phone,
and the simulator also remained below a stable 60 FPS; performance work continues.
