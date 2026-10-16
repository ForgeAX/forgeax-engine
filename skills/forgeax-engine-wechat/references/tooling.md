# CLI transport, login and results

## Private machine configuration

Create a JSON file outside the repository with restrictive permissions. Only `cli`
is required; omit SSH fields to execute on the DevTools machine itself.

```json
{
  "cli": "/absolute/path/to/wechatwebdevtools.app/Contents/MacOS/wechatide",
  "client": "Codex",
  "ssh": "configured-wechat-host",
  "port": 22,
  "identity": "/absolute/path/to/existing/private-key"
}
```

The identity is a path, never key contents. Existing SSH aliases may carry port/key
configuration instead. The wrapper builds local argument arrays and POSIX-quotes
remote arguments. Do not concatenate a JS function, project path or JSON payload
into an unquoted remote shell command. The SSH wrapper's remote shell is POSIX;
Windows uses local invocation or another explicitly qualified transport.

```bash
python3 skills/forgeax-engine-wechat/scripts/wechatide.py \
  --config /private/wechat-machine.json --out /private/run/status \
  call check_wechatide_status --skill-version 0.3.11
```

Use the version read from the installed official skill; the value above is a tested
example, not a minimum or a pinned installer requirement. Each `--out` directory must
be new. The wrapper prints structured JSON with local image paths, writes `result.json`
and `stderr.txt`, and retains unparseable output as `stdout.txt`. For a successful
`simulator_screenshot`, it also copies the returned PNG/JPEG from the configured
machine into the local artifact directory, preserving the remote path in the result.
A copy failure preserves the tool result and exits 1 with `artifactError`. Image payloads are
removed from printed JSON and written as private files. Inspect original failures;
do not equate process exit zero with a successful nested tool result.

Before rectangle-driven native input, initialize the caller's screenshot calibration
from the actual ready screenshot result, including its local artifact and image
dimensions. Readiness does not create a caller-specific `latest-screen.json`.
If that local receipt is missing, stop dependent actions, preserve the tool failure
and use the reviewed screenshot result; do not guess coordinates or reopen the game.
Refresh calibration after orientation or viewport changes.

A process deadline returns exit 1 with `error.code: process-timeout`, `timedOut: true`
and the configured `timeoutSeconds`. The wrapper retains captured stdout/stderr as
private raw files, including partial or non-UTF-8 output; the printed envelope contains
neither their contents nor command arguments. This is a transport failure, not a
pending task or proof that the remote action stopped. Inspect the actual project
state before repeating a mutating action.

| Exit | Meaning | Next action |
|:--|:--|:--|
| `0` | CLI process and tool response completed successfully | Check the requested operation's actual evidence |
| `1` | Process, protocol, tool, cancellation or expiry failure | Read result/stderr and recover the named boundary |
| `3` | Pending interaction/task | Retain task ID and follow the official task rules |

## Client authorization and tokens

Read `references/approval-policy.md` and `references/async-task-polling.md` from the
installed Tencent skill. Complete the actual client authorization dialog through
the UI within existing user authorization; otherwise identify the exact pending
interaction for the user. Do not rewrite private DevTools settings or use hidden
IPC to bypass it.

CLI and MCP tokens are distinct. `cliTokenRequired: false` permits CLI use even when
`mcpTokenRequired: true`. If a token is required, follow the official Settings/Security
flow and reuse an already-authorized secure credential store. Never search install
or profile files for tokens, guess values, put them in this machine JSON, or log them.
The wrapper passes through ordinary tool flags and rejects token flags; it is not a
credential provisioning tool.

## Login QR

```bash
python3 skills/forgeax-engine-wechat/scripts/wechatide.py \
  --config /private/wechat-machine.json --out /private/run/login \
  call login --type image
```

Open the extracted image with the image viewer and show it to the user. Send an
explicit user-input notification when that tool is available; a progress image alone
may not notify them. Ask them to scan using an account with development access to the game AppID and confirm on the
phone. A QR image or successful `login` invocation does not establish login success.

```bash
python3 skills/forgeax-engine-wechat/scripts/wechatide.py \
  --config /private/wechat-machine.json --out /private/run/login-polls \
  poll login_returned-task-id --attempts 10
```

The wrapper polls only `login_`/`auth_` IDs, at ten-second intervals after the first
query, with at most ten queries. Run longer polling asynchronously so user updates
remain possible. It exits early on success or failure and preserves every result.
For other pending tasks, retain the ID, tell the user what is awaited, and follow the
installed official skill instead of starting an automatic polling loop. Refresh an
expired QR through `login`, then use the newly returned ID. Verify final readiness
again with `check_wechatide_status`.

## Help and unavailable screenshot capture

Read tool help directly using the installed executable (`wechatide <tool> --help`)
or the installed tool index. Help is text, so it is intentionally outside the JSON
wrapper's `call` mode. Discover flags before invoking; do not guess from tool names.

Prefer `login --type image` and `simulator_screenshot` to desktop capture. macOS
`screencapture` can fail in an SSH session without screen recording access. During
initial bootstrap, an authorized Electron DevTools screenshot of the visible login
webview can expose the real QR; it remains a GUI fallback, not game acceptance.
Bind any temporary debug port locally, use SSH forwarding, and retire it after use.
Do not inspect credential pages or private application state through that channel.
