import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProjectFacts } from '../types.js';
import { tauriBuildScript, tauriMainSource, tauriSmokeScript } from './tauri-source.js';

/** Tauri embeds the ordinary browser closure; it owns no second runtime or renderer. */
export async function writeTauriProject(facts: ProjectFacts, outDir: string): Promise<void> {
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
    version: '0.0.0',
    identifier: `com.forgeax.game.${identifier || 'game'}`,
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
    },
  };
  const manifest = {
    name: `forgeax-tauri-${identifier || 'game'}`,
    version: '0.0.0',
    private: true,
    type: 'module',
    scripts: { build: 'node scripts/build.mjs', smoke: 'node scripts/smoke.mjs' },
    devDependencies: { '@tauri-apps/cli': '2.11.4' },
  };
  const sources: Record<string, string> = {
    'package.json': `${JSON.stringify(manifest, null, 2)}\n`,
    'src-tauri/tauri.conf.json': `${JSON.stringify(config, null, 2)}\n`,
    'src-tauri/Cargo.toml': `[package]
name = "forgeax-game"
version = "0.0.0"
edition = "2021"
rust-version = "1.87"
publish = false

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
    'src-tauri/src/main.rs': tauriMainSource,
    'scripts/build.mjs': tauriBuildScript,
    'scripts/smoke.mjs': tauriSmokeScript,
    'icon.svg':
      '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#10151d"/><path d="M108 360 256 88l148 272h-78l-70-132-70 132z" fill="#81d4fa"/></svg>\n',
    '.gitignore': 'node_modules/\nsrc-tauri/target/\nsrc-tauri/icons/\nreport/\n',
    'README.md': `# ${facts.name}\n\nThis application embeds the ordinary ForgeAX browser distribution in a Tauri WebView.\nIts renderer uses WebView WebGPU or the existing WebGL2 fallback. This is not the native Rust RHI route.\n\nOn the target desktop, install Rust and the platform Tauri prerequisites, then run:\n\n\`\`\`sh\npnpm install\npnpm build\npnpm smoke\n\`\`\`\n\nThe packaged application is under \`src-tauri/target/release/bundle/\`.\nSmoke launches that packaged application, waits for 60 completed Engine frames, and awaits Host cleanup before exit.\nOn macOS WKWebView captures its actual page in \`report/webview-ready.png\`; inspect that image to verify visible composition. Startup and failure captures use the same native snapshot path.\nThe structured report is \`report/report.json\`. Generated build caches and installed tools are not distribution source.\n`,
  };
  for (const [path, source] of Object.entries(sources)) {
    await mkdir(resolve(outDir, path, '..'), { recursive: true });
    await writeFile(resolve(outDir, path), source);
  }
}
