# Official DevTools setup

## Select a machine and version

Use an existing authorized macOS or Windows desktop machine. The official download
metadata currently lists those operating systems; a Linux shell is a controller,
not evidence that the WeChat simulator runs on Linux. Check existing project/global
instructions for a remote machine before asking for another one.

```bash
python3 skills/forgeax-engine-wechat/scripts/download_info.py --channel stable --os macOS --arch ARM64
```

Prefer stable when it provides the required official AI tools. If it does not, inspect
current release notes and choose a supported newer channel explicitly. Record the
resolved version, URL, OS and architecture with the run. `--from-file` replays saved
metadata; it does not prove the metadata is current. Windows uses `64`/`32` and macOS
uses `ARM64`/`x64` as the metadata's architecture vocabulary.

On 2026-10-25 the live official metadata resolved Stable `2.02.2608080`
(2026-09-30) and Nightly `2.02.2610212` (2026-10-21). Re-resolve those versions
before reuse. The [Stable 2.02.2608080 release notes](https://devtools.wxqcloud.qq.com.cn/WechatWebDev/nightly/versions/logs/stable_v2.02.2608080.json)
explicitly list a Mini Game `loadSubPackage` timeout/missing-callback fix. For that
symptom on the preceding Stable `2.02.2608070`, compare the same publication on
the official patch before attributing it to Engine package IO. The notes do not
establish an FPS improvement; that still needs new completed-frame evidence.

## macOS installation

Download the selected HTTPS URL on the target machine. Before installing a PKG, run
`pkgutil --check-signature` and require the trusted Tencent Developer ID Installer
identity and Apple notarization. Verify the copied application's code signature
with `codesign --verify --deep --strict` and inspect its signing identity. Do not
remove quarantine or disable OS signature checks as an installation workaround.

For an authorized user-local installation without administrator access, this flow
was exercised with the signed Electron PKG:

```bash
pkgutil --expand-full /path/to/wechat-devtools.pkg /path/to/new-expanded-directory
```

Inspect the expanded payload and postinstall first. For the observed package the app
payload can be copied with `ditto` into `~/Applications/wechatwebdevtools.app`; the
postinstall only adds system CLI symlinks, which are unnecessary when using absolute
paths. Recheck this on a new package: an arbitrary future postinstall is not assumed
optional. Preserve an existing installation unless replacement is authorized.

Open the installed application in the logged-in desktop session. First launch and
client authorization may require interaction. Noninteractive SSH may not contain
Homebrew's PATH; locate Node explicitly instead of changing system shell profiles.

## Locate the official AI entrypoint

For the qualified Electron macOS distribution, paths relative to the application are:

| Purpose | Relative path |
|:--|:--|
| Official AI CLI | `Contents/MacOS/wechatide` |
| Official skill | `Contents/Resources/app.asar.unpacked/wechatide-skill/SKILL.md` |
| Installation check | `Contents/Resources/app.asar.unpacked/wechatide-skill/skills/installer/scripts/check-installation.mjs` |

Read the installed SKILL and the references it selects. Run its installation check
with `--install-root /absolute/path/to/wechatwebdevtools.app`. Invoke registered
operations as `wechatide -c Codex <tool> ...`. The older executable named `cli` has a
different command vocabulary; do not send AI tool names to it or infer new AI flags
from legacy CLI documentation. For Windows, locate the installed official skill and
executable from the official installer; the macOS file layout is not portable.

## Select an existing Mini Game identity

Inspect the selected project's `project.config.json` and earlier ordinary build
outputs before asking for an AppID. After official client/login readiness, use
the installed initializer's `get_user_appids --type minigame` to discover Mini
Games managed by the current account. Match the returned identity to the intended
project; an unrelated project is not authorization to reuse its AppID. Keep IDs
and account responses in private run evidence.

The current Engine CLI accepts an omitted `appid` for tourist-mode builds. A
missing ID need not block source/build or simulator diagnosis; phone preview
requires an admitted project identity. Use the selected checkout's
`forgeax help project build --json` to verify its actual options. A built source
checkout can run its own CLI without a separate SDK archive.

## Remote access

Validate the existing SSH target with its prescribed identity and strict host-key
checking. A refused port indicates connectivity; `Permission denied` indicates
identity/authorization. Do not conflate them or disable host-key checks. The private
machine JSON in [Tooling](tooling.md) supports SSH aliases and explicit ports/keys.

Project and image paths returned by the official tools refer to the remote machine.
Copy build outputs to a dedicated project directory there. Inline images and file-path results from `simulator_screenshot` are copied locally
by the wrapper. Other file-only artifacts require an explicit transfer.
Do not use another project's working directory merely because it exists on the Mac.
