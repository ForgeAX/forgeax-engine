#!/usr/bin/env node
// Contributor-only Linux Tauri + Node validation addon, outside the SDK build.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
const root = dirname(fileURLToPath(import.meta.url));
if (process.platform !== 'linux') throw new Error('This fixture currently qualifies Linux X11 only');
// Tauri's context macro needs an RGBA icon even without bundle output.
// Keep the fixture source-only and produce the icon before invoking Cargo.
const icon = new PNG({ width: 32, height: 32 });
for (let offset = 0; offset < icon.data.length; offset += 4) {
  icon.data.set([30, 58, 95, 255], offset);
}
mkdirSync(resolve(root, 'icons'), { recursive: true });
writeFileSync(resolve(root, 'icons/icon.png'), PNG.sync.write(icon));
const target = resolve(process.env.CARGO_TARGET_DIR ?? resolve(root, 'target'));
const result = spawnSync('cargo', ['build', '--release', '--locked'], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: target },
});
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync(resolve(root, 'native'), { recursive: true });
const addon = resolve(root, `native/tauri-native-host.${process.platform}-${process.arch}.node`);
copyFileSync(resolve(target, 'release/libforgeax_devkit_tauri_native_host.so'), addon);
console.log(addon);
