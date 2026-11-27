import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { filesUnder } from './sdk-lib.mjs';

const VIEW_CONSUMER_SKILLS = Object.freeze(['forgeax-view-cli', 'forgeax-view-start']);

/** Publish the same View-owned guidance in the tool and SDK game skill inventory. */
export async function stageViewConsumerSkills(viewRoot, skillsRoot, engineGuideRoot) {
  for (const id of VIEW_CONSUMER_SKILLS) {
    const destination = resolve(skillsRoot, id);
    await mkdir(destination, { recursive: true });
    const owner = resolve(viewRoot, 'skills', id);
    if (engineGuideRoot === undefined) {
      await cp(resolve(owner, 'SKILL.md'), resolve(destination, 'SKILL.md'), {
        errorOnExist: true,
        force: false,
      });
      continue;
    }
    for (const name of ['SKILL.md', 'SKILL.zh-CN.md']) {
      if (id === 'forgeax-view-start') {
        await cp(
          resolve(engineGuideRoot, name.replace('SKILL', 'VIEW-START')),
          resolve(destination, name),
        );
        continue;
      }
      const source = await readFile(resolve(owner, name), 'utf8');
      const anchor = source.indexOf('../forgeax-view-start/SKILL');
      const start = source.lastIndexOf('\n\n', anchor);
      const end = source.indexOf('> [!IMPORTANT]', anchor);
      if (anchor < 0 || start < 0 || end < 0)
        throw new Error('engine-view-cli-guide-sections-missing');
      const intro = await readFile(
        resolve(engineGuideRoot, name.replace('SKILL', 'VIEW-CLI-INTRO')),
        'utf8',
      );
      await writeFile(
        resolve(destination, name),
        source.slice(0, start + 2) +
          intro.trimEnd() +
          '\n\n' +
          source.slice(end).replace(/\bSDK (?=command|\p{Script=Han})/gu, 'Engine '),
      );
    }
  }
  return [...VIEW_CONSUMER_SKILLS];
}

export const VIEW_TOOL_FILES = Object.freeze([
  'dist',
  'start.mjs',
  'host.pack.json',
  'skills',
  'README.md',
  'LICENSE',
  'scripts/browser-proof-workload.mjs',
  'scripts/project-document.mjs',
  'scripts/runtime-content-import.mjs',
  'scripts/verify-runtime-content-engine.mjs',
  'scripts/verify-game3d-workspace.mjs',
  'scripts/preview-rhi-evidence.mjs',
]);

/** Resolve authoring-tool registry edges from the frozen contributor workspace. */
export async function pinViewRegistryDependencies(viewRoot, packageRoot) {
  const path = resolve(packageRoot, 'package.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name === '@forgeax/engine') continue;
    const dependency = JSON.parse(
      await readFile(resolve(viewRoot, 'node_modules', name, 'package.json'), 'utf8'),
    );
    if (dependency.name !== name || typeof dependency.version !== 'string')
      throw new Error(`engine-view-dependency-identity: ${name}`);
    manifest.dependencies[name] = dependency.version;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Embed the built View tool in the SDK without contributor workspace dependencies. */
export async function stageViewToolPackage(viewRoot, packageRoot, version, engineGuideRoot) {
  await mkdir(packageRoot, { recursive: true });
  const files = VIEW_TOOL_FILES;
  for (const file of files.filter((file) => file !== 'skills'))
    await cp(resolve(viewRoot, file), resolve(packageRoot, file), { recursive: true });
  await rm(resolve(packageRoot, 'skills'), { recursive: true, force: true });
  await stageViewConsumerSkills(viewRoot, resolve(packageRoot, 'skills'), engineGuideRoot);
  if (engineGuideRoot !== undefined) {
    await writeFile(
      resolve(packageRoot, 'README.md'),
      '# ForgeaX View\n\n' +
        'Use `forgeax project view --json` from the game root. Open the returned URL to inspect the project.\n' +
        'See the [startup guide](skills/forgeax-view-start/SKILL.md) and [live operations](skills/forgeax-view-cli/SKILL.md).\n',
    );
  }
  const manifest = JSON.parse(await readFile(resolve(viewRoot, 'package.json'), 'utf8'));
  manifest.private = true;
  manifest.version = version;
  for (const field of ['devDependencies', 'forgeax', 'bin', 'scripts']) delete manifest[field];
  delete manifest.exports['./build'];
  manifest.files = files;
  const graph = JSON.parse(await readFile(resolve(viewRoot, 'dist/native-build.json'), 'utf8'));
  for (const name of Object.keys(manifest.dependencies))
    if (name.startsWith('@forgeax/view-')) delete manifest.dependencies[name];
  for (const output of Object.values(graph.outputs))
    for (const item of output.imports) {
      if (!item.external) continue;
      if (item.path.startsWith('@forgeax/view-'))
        throw new Error(`sdk-view-unbundled-workspace-package: ${item.path}`);
      if (item.path.startsWith('@forgeax/engine'))
        manifest.dependencies['@forgeax/engine'] = version;
    }
  for (const name of Object.keys(manifest.dependencies))
    if (name.startsWith('@forgeax/engine-')) delete manifest.dependencies[name];
  manifest.dependencies['@forgeax/engine'] = version;
  // Contributor tools use physical workspace owners. Their published modules
  // consume the same public Engine subpaths as ordinary external projects.
  for (const path of await filesUnder(packageRoot)) {
    if (!/\.(?:mjs|cjs|js|ts|json)$/.test(path)) continue;
    const source = await readFile(path, 'utf8');
    const projected = source.replaceAll(
      /@forgeax\/engine-([a-z][a-z0-9-]*)/g,
      '@forgeax/engine/$1',
    );
    if (projected !== source) await writeFile(path, projected);
  }
  await rm(resolve(packageRoot, 'dist/native-build.json'));
  await rm(resolve(packageRoot, 'dist/viewer/panel-graph.json'), { force: true });
  await writeFile(resolve(packageRoot, 'package.json'), JSON.stringify(manifest, null, 2));
}
