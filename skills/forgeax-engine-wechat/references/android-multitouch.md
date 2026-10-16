# Android multi-touch through the official scrcpy server

Use this path when an ordinary game's joystick and Run/Jump/look need independent
simultaneous fingers. Android 16's `adb shell input` constructs a single-pointer
`MotionEvent`; concurrent commands do not establish multiple held contacts.
Genymobile's scrcpy server maintains up to ten pointer IDs and combines them into
native Android multi-touch events. No desktop scrcpy window or APK installation is
required: the existing ADB plus the official server and Python are sufficient.

## Qualify the connection without input

Run [scrcpy_handshake.py](../scripts/scrcpy_handshake.py) on the machine that owns
ADB. For the configured remote phone this is the Mac; Linux `127.0.0.1` is a
different host. Reuse the SSH transport from [Setup](setup.md) to transfer/run the
script there. Supply the already-selected device serial and private absolute paths:

```sh
python3 /absolute/scrcpy_handshake.py \
  --adb /absolute/platform-tools/adb --serial SELECTED_SERIAL \
  --cache /absolute/private/scrcpy-cache --out /absolute/private/new-handshake
```

The script downloads or verifies the pinned official **5.0.1** server, pushes its
JAR to a unique `/data/local/tmp/forgeax-scrcpy-SCID.jar`, allocates one ADB forward,
and launches `app_process`. This is a temporary device operation, not a read-only
inventory. It connects once, requires the zero-byte handshake, then closes and
checks cleanup. It has no touch/input command. A cached file with an unexpected
digest fails before device operations.

On 2026-10-11 this flow passed on the actual Android 16 phone: handshake `00`,
server exit 0, forwarding removed, JAR removed, no matching server process, and
zero input messages. The reusable script adds bounded failure cleanup; its offline
tests do not establish another device result. A connection pass does not qualify
gameplay, multi-touch reception, cancellation, or performance.

Keep three distinct evidence levels: the socket handshake, accepted native touch
serialization, and the game's observed independent contacts. Only report the
level actually exercised on the selected phone. Separate `adb input` swipes,
a standalone Run hold, or a browser's four-contact pass do not promote the phone
to a multi-touch gameplay pass. A later phone journey qualified move/look/jump
and release through sequential input; simultaneous movement plus Run remained
unverified in that run.

The official [5.0.1 server](https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/scrcpy-server-v5.0.1)
has SHA256 `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`
in its [release checksum list](https://github.com/Genymobile/scrcpy/releases/download/v5.0.1/SHA256SUMS.txt).
The exact version argument matters: the tagged development document still contains
4.0 examples, while the server rejects a mismatched client version.

## Subsequent touch client

The reusable [continuous gameplay driver](android-continuous-input.md) now consumes
the shared four-contact timeline through this connection owner, with source/capture
binding, independent sparse guards, cancellation and release receipts. Its offline
protocol tests do not promote the earlier handshake to a phone gameplay pass.

The handshake helper deliberately ends before this stage. A gesture client uses
the same control-only server options and retains its connection while sending:

```text
video=false audio=false control=true tunnel_forward=true display_id=0
send_device_meta=false send_dummy_byte=true clipboard_autosync=false
power_on=false power_off_on_close=false stay_awake=false show_touches=false
keep_active=false cleanup=true
```

Use a unique positive 31-bit hexadecimal SCID and matching `scrcpy_%08x` abstract
socket. Enabled sockets are ordered video, audio, control; with the options above
there is just one socket and its only initial metadata is `b"\x00"`.

`INJECT_TOUCH_EVENT` is exactly 32 bytes, big endian, without a length prefix:

```python
packet = struct.pack(
    '>BBQiiHHHII', 2, action, pointer_id,
    x, y, width, height, pressure, 0, 0,
)
```

Use DOWN=0, UP=1, MOVE=2; independent positive pointer IDs such as 1 and 2;
pressure `0xffff` for down/move and 0 for up. The final integers are zero finger
button fields. Width/height are unsigned 16-bit values. This encoder matched all
32 bytes of the official C touch serialization fixture in an offline comparison.
The server converts additional ordinary DOWN/UP actions to POINTER_DOWN/UP itself.

Without video the server uses raw display coordinates and does not reject stale
width/height metadata. Derive coordinates from a freshly reviewed actual phone
screenshot and retain the exact foreground ActivityRecord/user/component/task/PID
guard from [Android device evidence](android-device.md). Simulator pixels and
portrait `wm size` are not substitutes for the current landscape framebuffer.
The shared capture helper's `--for-input` mode prepares that identity plus actual
default-display rotation and dimensions. Its single-action input helper is for
sparse taps/swipes/edits; repeated SSH/ADB/dumpsys round trips are not a continuous
gesture driver or input-latency measurement. A persistent scrcpy client must retain
its own authorized connection, monitor ownership changes, and stop/release rather
than operating a newly foregrounded application.

First qualify a bounded two-finger operation: hold/move the joystick with finger 1,
press Run with finger 2, release 2 while 1 remains active, then release 1. Capture
the actual input/World consequence and pixels. Socket writes have no per-touch
acknowledgement, so successful transmission alone proves no game behavior.

Send explicit UP for every held pointer before closing, including recoverable
failure paths. Socket closure is not a release guarantee. ACTION_CANCEL does not
mark all scrcpy pointers removable in this version; do not substitute it for
per-pointer UP or claim cancellation from a release-only test. Preserve incomplete
release evidence if the connection breaks.

Closing control ends the server. Its cleanup child unlinks the exact classpath JAR
at startup and restores any requested settings after server exit; the options above
request no power, clipboard, touch-visualization or awake-state changes. Remove only
the owned forwarding port. If cleanup fails, inspect the reported exact SCID/path;
do not use global server kills or `adb forward --remove-all`.

## Source authorities

- Android's [single-pointer shell implementation](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/services/core/java/com/android/server/input/InputShellCommand.java).
- scrcpy [standalone development](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/develop.md) and [control-only mode](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/control.md).
- [Control serialization and official test vector](https://github.com/Genymobile/scrcpy/blob/v5.0.1/app/tests/test_control_msg_serialize.c), [numeric message constant](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/control/ControlMessage.java), and [parser](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/control/ControlMessageReader.java).
- [Pointer state](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/control/PointersState.java), [native injection/raw coordinates](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/control/Controller.java), [connection](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/device/DesktopConnection.java), and [cleanup](https://github.com/Genymobile/scrcpy/blob/v5.0.1/server/src/main/java/com/genymobile/scrcpy/CleanUp.java).
