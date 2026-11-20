import { cp, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

function declaredPath(root, path) {
  if (typeof path !== 'string' || path.length === 0 || isAbsolute(path))
    throw new Error('shared input inventory path must be relative to its explicit source root');
  const target = resolve(root, path);
  const inside = relative(root, target);
  if (inside === '' || inside === '..' || inside.startsWith('../') || inside.startsWith('..\\') || isAbsolute(inside))
    throw new Error(`shared input inventory path is outside its explicit root: ${path}`);
  return target;
}

async function selectedPublication(sourceRoot, manifestPath) {
  const selected = resolve(sourceRoot, manifestPath);
  const bytes = await readFile(selected);
  const manifest = JSON.parse(bytes);
  const payload = manifest.payload?.engineShaderManifest;
  if (!['shared-app-inputs', 'repo-build-inputs'].includes(manifest.producer) ||
      ![1, 2].includes(manifest.schemaVersion) ||
      !Array.isArray(manifest.inventory) || !manifest.inventory.includes(payload))
    throw new Error('selected shared shader publication requires its producer inventory');
  const paths = [...new Set([
    ...manifest.inventory,
    ...(manifest.payloadInventory ?? []),
    ...Object.values(manifest.payload).filter(value => typeof value === 'string'),
  ])];
  return {selected, bytes, paths};
}

/** Mirror declared parent-relative publications inside one disposable owner directory. */
export async function createLiveSyncProjectDirectory(prefix, sourceRoot, manifestPath) {
  let depth = 0;
  if (manifestPath) {
    const {selected, paths} = await selectedPublication(sourceRoot, manifestPath);
    for (const path of [relative(sourceRoot, selected), ...paths]) {
      if (typeof path !== 'string' || isAbsolute(path)) throw new Error('shared input path must be relative');
      const segments = relative(sourceRoot, resolve(sourceRoot, path)).split(/[\\/]/);
      let parents = 0;
      while (segments[parents] === '..') parents++;
      depth = Math.max(depth, parents);
    }
  }
  const temporaryRoot = await realpath(await mkdtemp(resolve(tmpdir(), prefix)));
  const root = resolve(temporaryRoot, ...Array(depth).fill('project'));
  await mkdir(root, {recursive:true});
  return {root, temporaryRoot};
}

/** Copy the selected producer bytes into the disposable consumer's same declared tree. */
export async function prepareLiveSyncSharedInputs({sourceRoot, projectRoot, manifestPath, temporaryRoot = projectRoot}) {
  const {selected, bytes, paths} = await selectedPublication(sourceRoot, manifestPath);
  const manifestRelative = relative(sourceRoot, selected);
  const destination = declaredPath(temporaryRoot, relative(temporaryRoot, resolve(projectRoot, manifestRelative)));
  const copies = paths.map(path => ({
    from: typeof path === 'string' && !isAbsolute(path) ? resolve(sourceRoot, path) : declaredPath(sourceRoot, path),
    to: declaredPath(temporaryRoot, relative(temporaryRoot, resolve(projectRoot, path))),
  }));
  for (const {from, to} of copies) {
    await mkdir(dirname(to), {recursive: true});
    await cp(from, to, {recursive: true});
  }
  await mkdir(dirname(destination), {recursive: true});
  await writeFile(destination, bytes);
  return destination;
}
