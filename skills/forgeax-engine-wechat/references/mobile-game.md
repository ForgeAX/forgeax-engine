# Mobile controls in the ordinary game

Use the generated `game-3d` source and the same authored guide on browser and
WeChat. The [template contract](../../../templates/game-3d/README.md) owns bindings;
the [player control source](../../../templates/game-3d/assets/ui/player-controls.ts)
owns gesture identity, deadzone, reset and the borrowed Host port.

Routes: [input ownership](#input-ownership),
[animation/physics/camera timing](#animation-physics-and-camera-timing),
[gesture CSS](#declare-gesture-ownership-in-css), and
[representative sequence](#representative-sequence).

## Input ownership

All touch gameplay controls send semantic intents through the existing
`GameHost.port`. Player movement, jump consumption, camera and run speed remain
World system work. The UI never writes a transform or advances physics.

Do not mix raw left-screen touches with a UI Jump button: UI acquisition revokes
raw gameplay contacts. A single gesture path must own joystick, look and held
buttons. Removing one finger must release only that contact; focus changes and
touch `pointerout` must not cancel other held controls. Hide, resize, mode change,
opening the editor and disposal reset all pending intentions.

The generated browser Host discovers touch mode from the initial input media
query and real pointer events; pointer lock remains an explicit browser fact.
Touch-generated compatibility clicks must not request pointer lock. A locked
camera label and disappearing controls after a tap route to the Engine Input
owner, not a template workaround.

## Animation, physics and camera timing

Separate stale state from fixed-step quantization before treating visible jitter
as a rendering or FPS problem. The ordinary template samples intent once in
Update, selects animation weight before animation sampling, reuses movement/Run
in FixedUpdate, and consumes a pending jump once even after an Update with no
fixed step. Camera following runs after physics and before Scene propagation.
The [temporal regression](../../../templates/game-3d/assets/player/__tests__/temporal-alignment.test.ts)
uses real World, Scene, Animation and native Rapier to cover zero, one and several
fixed steps. Compare current local/world player, joints and camera values through
that owner; retain one App loop and the existing physics time authority.

Correct ordering does not prove smooth displayed motion. A retained numerical
sweep at 24 Hz alternated two and three fixed ticks per Update, while 30 Hz used
two each time. Local/world transforms and animation were aligned, yet the
player-to-camera displacement still alternated. That experiment had no Renderer
or displayed frame and was not rerun for later releases; see its
[scope and unresolved quantization](../../../packages/platform/VERIFICATION.md#latest-qualified-phone-source-40db).
Frame-time tails, interpolation and camera smoothing therefore remain separate
questions. Do not flatten the fixed-step accumulator to hide the observation.

## Declare gesture ownership in CSS

Use `touch-action: none` on joystick, look and held-button hit regions. The
portable profile and native input share this policy; browser-only
`touchstart`/`touchmove` cancellation listeners are unnecessary. Native input
samples computed permissions per contact before `pointerdown` handlers and
keeps them until release, including policy on shadow hosts. `preventDefault()`
on Pointer Events controls their other defaults, not pan permission. Ordinary
scroll regions retain `auto` or an explicit `pan-x`/`pan-y`; wheel and
programmatic scrolling are unaffected.

For a pan regression, use an actual overflowing container and a non-focusable
control like the joystick. A large button can scroll during focus before the
gesture begins and invalidate the comparison. Drive trusted browser touch
events (for example CDP `Input.dispatchTouchEvent`) to verify native browser pan;
synthetic `PointerEvent` dispatch alone cannot exercise this default. Then drive
the Engine native input port against the real WASM and check offsets,
`pointercancel`/`pointerup`, independent contacts and wheel behavior. The
[maintained native cases](../../../packages/ui-blitz/src/__tests__/touch-pan.unit.test.ts)
cover the Engine policy. Desktop browser evidence does not establish simulator
or phone input behavior.

## Representative sequence

| Operation | Observe through the existing inspector |
|:--|:--|
| Portrait and landscape | All controls fit the viewport, leave the WeChat capsule/home areas usable, and show the actual touch instructions |
| Joystick hold/release | Player moves; release returns movement axes and walking state to zero |
| Look | Camera yaw/pitch change while player translation stays independent |
| Jump and held Run | Jump raises the real physics body; Run remains held only while its contact lives |
| Simultaneous controls | Keep move/look/Jump/Run contacts independently; releasing one must not clear the others |
| Editor | A real tap opens the form, hides gameplay controls, and cancels movement; native keyboard edit/Generate changes the same vase identity |
| Lifecycle | Cancel, resize, hide/show and Reload do not retain old contacts or intentions |

For browser comparison use the template's
[mobile probe](../../../templates/game-3d/scripts/mobile-controls-probe.mjs) through
the existing DevKit `game-3d-runtime-vase` integration. It sends trusted CDP touch
events in main and Worker modes and retains the original form and 60-completion
checks. It does not dispatch synthetic DOM events or write game state.

Save raw pointer observations before asserting them. A desktop browser can
deliver trusted mouse input alongside touch; requiring every document pointer
event to have type `touch` rejects a valid mouse-to-touch transition. The probe
retains an explicit real mouse movement before the first touch, requires all
observations to be trusted, and applies contact/cancellation checks to the touch
subset. Preserve the full raw stream rather than filtering away evidence. If an
older failure omitted that stream, a new controlled reproduction cannot establish
which event caused the older failure.

The installed official `automation_game_action` in the qualified tool version
exposes one contact. Its joystick/look/jump/run sequence qualifies those native
actions separately. Browser CDP four-contact success does not prove simultaneous
native contacts. Record this tooling limit; do not fabricate a native multi-touch
pass by calling internal handlers. A secondary browser touch may not emit a
compatibility click; test the editor with an ordinary single-contact tap, and label
keyboard activation while other contacts remain held as a separate reset check.

A remote read after `tap` can miss a complete jump: the official call and next
inspection may take longer than flight. Observe the existing player read inside
the game realm for a bounded interval around the real native action, retaining
height and grounded transitions; cancel its timer and remove the observer after
collection. Do not advance physics or inject a jump intent from the observer.
The qualified ordinary journey sampled every 25 ms for 6.5 seconds and observed
height 0.960 → 2.057 → 0.960 with airborne and landed states. This is functional
evidence, not a frame-performance sample. Compare stationary physics positions
with a small numeric tolerance rather than demanding identical floating values.

For Android movement, release and native-keyboard observations, retain the
source-bound [device evidence](android-device.md#actual-phone-evidence) and
[parameter receipts](android-device.md#parameter-interaction-receipts).
Bounded sample histories must report truncation: an observed landing or accepted
mesh change does not qualify the omitted interaction tail. Final neutral input
needs its own observed state. A stable-FPS claim additionally needs the continuous
[performance workload](performance.md#qualify-the-workload-before-measuring).

Retain each candidate's SDK identity and authored source digest. A template copied
onto an already-published SDK is useful diagnosis; final delivery still needs the
ordinary publication containing that change and verification on the requested
delivery target. Reuse unchanged host checks instead of requiring a new simulator
run for every phone-only fix.
