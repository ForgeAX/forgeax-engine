import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectFacts } from '../types.js';
import { tauriResourceProtocol, tauriResourceServerSource } from './tauri-resource-server.js';
import { tauriBuildScript, tauriLibrarySource, tauriSmokeScript } from './tauri-source.js';

/** Tauri embeds the ordinary browser closure; it owns no second runtime or renderer. */
export async function writeTauriProject(facts: ProjectFacts, outDir: string): Promise<void> {
  // Android requires a nonzero application version.
  const version = '0.0.1';
  const files = await readdir(outDir);
  await mkdir(resolve(outDir, 'web'));
  for (const name of files) await rename(resolve(outDir, name), resolve(outDir, 'web', name));
  const identifier = facts.id
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  const config = {
    $schema: 'https://schema.tauri.app/config/2',
    productName: facts.name,
    version,
    identifier: `com.forgeax.game.g${identifier.replace(/-/g, '') || 'game'}`,
    build: { frontendDist: '../web' },
    app: {
      windows: [],
      withGlobalTauri: true,
      security: {
        // A static style nonce would override unsafe-inline and reject runtime UiAsset CSS.
        dangerousDisableAssetCspModification: ['style-src'],
        csp: "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' data: ipc: http://ipc.localhost; worker-src 'self' blob:",
      },
    },
    bundle: {
      active: true,
      targets: 'all',
      icon: ['icons/icon.icns', 'icons/icon.ico', 'icons/32x32.png', 'icons/128x128.png'],
      windows: { wix: { language: { 'en-US': { localePath: 'locales/en-US.wxl' } } } },
    },
  };
  const manifest = {
    name: `forgeax-tauri-${identifier || 'game'}`,
    version,
    private: true,
    type: 'module',
    scripts: {
      tauri: 'tauri',
      build: 'node scripts/build.mjs',
      'build:windows': 'node scripts/build.mjs --platform windows',
      'build:macos': 'node scripts/build.mjs --platform macos',
      'build:linux': 'node scripts/build.mjs --platform linux',
      'build:android': 'node scripts/build.mjs --platform android',
      'build:ios': 'node scripts/build.mjs --platform ios',
      smoke: 'node scripts/smoke.mjs',
    },
    devDependencies: { '@tauri-apps/cli': '2.11.4' },
  };
  const sources: Record<string, string> = {
    // WiX accepts Unicode database strings; summary information requires an ANSI code page.
    'src-tauri/locales/en-US.wxl': `<?xml version="1.0" encoding="utf-8"?>
<WixLocalization Culture="en-US" Codepage="65001" xmlns="http://schemas.microsoft.com/wix/2006/localization">
  <String Id="TauriLanguage">1033</String>
  <String Id="TauriCodepage">1252</String>
  <String Id="InstallAppFeature">Install application</String>
  <String Id="PathEnvVarFeature">Add the application to PATH</String>
  <String Id="LaunchApp">Launch application</String>
</WixLocalization>
`,
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src-tauri/tauri.conf.json': `${JSON.stringify(config, null, 2)}\n`,
    'src-tauri/Cargo.toml': `[package]
name = "forgeax-game"
version = "${version}"
edition = "2021"
rust-version = "1.87"
publish = false

[lib]
name = "forgeax_game_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "=2.6.3", features = [] }

[dependencies]
tauri = { version = "=2.11.5", features = [] }
# Keep the Tauri family coherent: newer semver-compatible runtime/macros changed internal APIs.
tauri-runtime = "=2.11.3"
tauri-runtime-wry = { version = "=2.11.4", default-features = false }
tauri-macros = "=2.6.3"
tauri-utils = "=2.9.3"
serde_json = "1"

[target.'cfg(any(target_os = "windows", target_os = "android"))'.dependencies]
tiny_http = "=0.12.0"

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "=0.6.5"
objc2-app-kit = "=0.3.2"
objc2-foundation = "=0.3.2"
objc2-web-kit = "=0.3.2"
block2 = "=0.6.2"

[features]
custom-protocol = ["tauri/custom-protocol"]
`,
    'src-tauri/build.rs': `fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
        println!("cargo:rustc-link-arg=-Wl,-z,common-page-size=16384");
    }
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["smoke_report", "finish_close", "request_close"])
    )).expect("Tauri application permissions could not be built");
}\n`,
    'src-tauri/capabilities/main.json': `${JSON.stringify(
      {
        identifier: 'main-host',
        description:
          'Only the packaged main WebView may finish Host cleanup and publish opt-in smoke evidence.',
        windows: ['main'],
        permissions: ['allow-smoke-report', 'allow-finish-close', 'allow-request-close'],
      },
      null,
      2,
    )}\n`,
    'src-tauri/src/main.rs':
      '#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]\nfn main() { forgeax_game_lib::run(); }\n',
    'src-tauri/src/lib.rs': tauriLibrarySource,
    'src-tauri/src/asset_server.rs': tauriResourceServerSource,
    'src-tauri/android/loopback-network.xml': `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">${tauriResourceProtocol}.localhost</domain>
  </domain-config>
</network-security-config>
`,
    'scripts/build.mjs': tauriBuildScript,
    'scripts/smoke.mjs': tauriSmokeScript,
    'icon.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#10151d"/><path d="M108 360 256 88l148 272h-78l-70-132-70 132z" fill="#81d4fa"/></svg>\n',
    '.gitignore': 'node_modules/\nsrc-tauri/target/\nsrc-tauri/icons/\nsrc-tauri/gen/\nreport/\n',
    'README.md': `# ${facts.name}

This application embeds the ordinary ForgeAX browser distribution in a Tauri WebView.
Rendering uses WebView WebGPU or the existing WebGL2 fallback.

Install Node.js, pnpm, Rust and the [Tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/).
Run \`pnpm install\`, then select a build command:

| Platform | Command | Build host and tools | Native output |
|:--|:--|:--|:--|
| Windows | \`pnpm build:windows\` | Windows, MSVC, WebView2 | NSIS EXE and MSI |
| macOS | \`pnpm build:macos\` | macOS, Xcode tools | APP and DMG |
| Linux | \`pnpm build:linux\` | Linux, WebKitGTK 4.1 and packaging dependencies | AppImage, DEB and RPM |
| Android | \`pnpm build:android\` | JDK 17+, Android SDK/NDK, JAVA_HOME, ANDROID_HOME, NDK_HOME | APK and AAB |
| iOS | \`pnpm build:ios\` | macOS, Xcode, XcodeGen, Apple signing team | IPA |

\`pnpm build\` selects the current desktop OS. Mobile commands initialize their native project once.
Forward Tauri CLI flags after the command, for example \`pnpm build:android --target aarch64\`.
Configure Android release keystores in the generated Gradle project and Apple signing through
\`APPLE_DEVELOPMENT_TEAM\` and Xcode provisioning. Signing keys remain external to the distribution.
Use the generated project's ordinary Tauri configuration to customize identity, version and signing.

## Automation and human setup

| Owner | Responsibility |
|:--|:--|
| ForgeAX | Seal the game code/resources, generate the native host and scripts, invoke the selected native builder, and collect its artifacts. For native builds, the package command installs the pinned Tauri CLI in temporary project storage. |
| Platform tools | Compile/link, apply configured signing, maintain automatic provisioning where available, and provide device installation/debugging commands. |
| Developer or operator | Prepare system toolchains; supply the signing identity/team; complete account login, two-factor checks, keychain prompts, device trust and physical-device confirmations. |

The exporter does not install Xcode, Android SDK/NDK or system compilers, sign in to
accounts, enable phone developer settings, install the app on every target device,
create desktop shortcuts, or submit store releases. An agent/operator may perform
some of that setup separately. It is not part of a successful package receipt.

| Platform | Developer setup beyond the build tools above | Ordinary app installation |
|:--|:--|:--|
| Windows | Configure code signing when required by the distribution channel. | Run the EXE/MSI installer; no build toolchain is needed. |
| macOS | Supply Apple signing/notarization configuration for the chosen distribution channel. | Open/copy the APP from the DMG; Xcode is a build-machine requirement. |
| Linux | Supply packaging dependencies and choose the target package format. | Use the package manager or AppImage; system install/execute permissions apply. |
| Android | ADB/USB testing needs developer options, USB debugging and phone authorization. Debug builds use the platform debug key; release signing needs a configured keystore. | A signed APK can be installed through a supported installer; an AAB is store input. USB debugging is not a general requirement for playing the app. Device, region and store verification rules still apply. |
| iOS | Install Xcode iOS platform support; select an Apple account/team and provisioning. Local development testing needs an unlocked, trusted iPhone with Developer Mode enabled, including the restart confirmation and any developer-app trust prompt. | App Store/TestFlight users do not need Xcode or Developer Mode. A development-signed test app and a distribution IPA have different signing/provisioning requirements. |

A free Apple Personal Team supports testing on your own device; its provisioning
expires after seven days, requiring a rebuild/reinstall. It does not establish
store/TestFlight distribution readiness. Xcode can create development certificates
and profiles automatically after the account, team and device are configured.
A release APK named \`*-unsigned.apk\` still needs signing before installation.

See Apple's [Personal Team](https://developer.apple.com/help/account/basics/about-your-developer-account)
and [Developer Mode](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device)
guides, plus Android's [USB debugging](https://developer.android.com/studio/run/device),
[APK installation](https://developer.android.com/distribute/marketing-tools/alternative-distribution),
and [developer verification](https://developer.android.com/developer-verification/guides/faq).

| Output | Path |
|:--|:--|
| ForgeAX packaged installers | \`artifacts/\` |
| Direct desktop builds | \`src-tauri/target/release/bundle/\` (or CARGO_TARGET_DIR) |
| Direct Android builds | \`src-tauri/gen/android/app/build/outputs/\` |
| Direct iOS builds | \`src-tauri/gen/apple/build/\` |

> [!IMPORTANT]
> A successful build does not prove installation, gameplay or store admission.
> \`--prepare-only\` exports source and web resources without running native tools.

\`pnpm smoke\` launches the packaged macOS APP; Windows/Linux require the actual installed
executable in \`FORGEAX_TAURI_EXECUTABLE\`. The smoke waits for 60 completed Engine frames,
permission rejection and Host cleanup. On macOS inspect \`report/webview-ready.png\` as well as
\`report/report.json\`. Android/iOS need separate device installation and runtime acceptance.
Generated caches and installed tools are not distribution source.
`,
  };
  for (const [path, source] of Object.entries(sources)) {
    await mkdir(resolve(outDir, path, '..'), { recursive: true });
    await writeFile(resolve(outDir, path), source);
  }
}
