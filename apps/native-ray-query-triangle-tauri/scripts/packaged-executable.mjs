import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

function firstFile(directory, suffix) {
  if (!existsSync(directory)) return undefined;
  return readdirSync(directory)
    .sort()
    .find((name) => name.endsWith(suffix));
}

export function resolvePackagedExecutable({ appRoot, cargoTargetDir, platform }) {
  const target = cargoTargetDir
    ? resolve(appRoot, cargoTargetDir)
    : resolve(appRoot, 'src-tauri/target');
  const release = resolve(target, 'release');
  if (platform === 'darwin') {
    const directory = resolve(release, 'bundle/macos');
    const app = firstFile(directory, '.app');
    if (!app) throw new Error(`Tauri app bundle missing under ${directory}`);
    return resolve(directory, app, 'Contents/MacOS/forgeax-native-ray-query-triangle');
  }
  if (platform === 'linux') {
    const directory = resolve(release, 'bundle/appimage');
    const appImage = firstFile(directory, '.AppImage');
    if (!appImage) throw new Error(`Tauri AppImage missing under ${directory}`);
    return resolve(directory, appImage);
  }
  return resolve(release, 'forgeax-native-ray-query-triangle.exe');
}
