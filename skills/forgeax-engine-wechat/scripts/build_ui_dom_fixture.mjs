import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    'engine-root': { type: 'string' },
    out: { type: 'string' },
    appid: { type: 'string' },
    font: { type: 'string' },
    'font-license': { type: 'string' },
    scene: { type: 'string', default: 'dom' },
  },
});
if (
  !values['engine-root'] ||
  !values.out ||
  !values.font ||
  !values['font-license'] ||
  !/^wx[0-9a-f]{16}$/.test(values.appid ?? '')
) {
  throw new Error(
    'Required: --engine-root PATH --out NEW_DIRECTORY --appid wx... --font LICENSED_FONT --font-license LICENSE_FILE',
  );
}
if (!['dom', 'guide', 'settings'].includes(values.scene))
  throw new Error('--scene must be dom, guide or settings');
const engine = resolve(values['engine-root']);
const output = resolve(values.out);
await mkdir(output); // Do not overwrite a project or local credentials.
await mkdir(join(output, 'ui'));
const { build } = createRequire(await realpath(join(engine, 'node_modules/tsup/dist/index.js')))(
  'esbuild',
);
await build({
  entryPoints: [
    resolve(dirname(fileURLToPath(import.meta.url)), `../fixtures/ui-${values.scene}/game.js`),
  ],
  outfile: join(output, 'ui/game.js'),
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  platform: 'neutral',
  nodePaths: [join(engine, 'node_modules')],
  minify: true,
  loader: { '.html': 'text', '.css': 'text' },
  plugins: [
    {
      name: 'authored-raw-source',
      setup(build) {
        build.onResolve({ filter: /\?raw$/ }, ({ path, importer }) => ({
          path: resolve(dirname(importer), path.slice(0, -4)),
          namespace: 'raw-source',
        }));
        build.onLoad({ filter: /.*/, namespace: 'raw-source' }, async ({ path }) => ({
          contents: await readFile(path, 'utf8'),
          loader: 'text',
        }));
      },
    },
  ],
});
const programPath = join(output, 'ui/game.js');
const program = await readFile(programPath);
const buildIdentity = {
  scene: values.scene,
  programSha256: createHash('sha256').update(program).digest('hex'),
};
await writeFile(
  programPath,
  `globalThis.forgeaxUiFixtureBuild=${JSON.stringify(buildIdentity)};console.log('FORGEAX_UI_FIXTURE_BUILD',JSON.stringify(globalThis.forgeaxUiFixtureBuild));\n${program.toString()}`,
);
await copyFile(join(engine, 'packages/ui-blitz/pkg/ui_blitz_bg.wasm'), join(output, 'ui/ui.wasm'));
await copyFile(values.font, join(output, 'ui/font.ttf'));
await copyFile(values['font-license'], join(output, 'ui/FONT-LICENSE.txt'));
await writeFile(
  join(output, 'game.js'),
  "wx.loadSubpackage({ name: 'ui', fail: error => console.error('FORGEAX_UI_DOM_LOAD_FAILURE', JSON.stringify(error)) });\n",
);
await writeFile(
  join(output, 'game.json'),
  JSON.stringify({
    deviceOrientation: values.scene === 'guide' ? 'landscape' : 'portrait',
    subpackages: [{ name: 'ui', root: 'ui/' }],
  }),
);
await writeFile(
  join(output, 'project.config.json'),
  JSON.stringify({
    appid: values.appid,
    compileType: 'game',
    projectname: {
      dom: 'ForgeAX Persistent UI Contract',
      guide: 'ForgeAX Full Guide UI Contract',
      settings: 'ForgeAX Actual Settings Controls',
    }[values.scene],
    libVersion: 'latest',
    setting: { es6: false, minified: false },
  }),
  { mode: 0o600 },
);
const files = [
  'game.js',
  'game.json',
  'ui/game.js',
  'ui/ui.wasm',
  'ui/font.ttf',
  'ui/FONT-LICENSE.txt',
];
const artifacts = await Promise.all(
  files.map(async (name) => {
    const bytes = await readFile(join(output, name));
    return {
      path: name,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }),
);
await writeFile(
  join(output, 'diagnostic.json'),
  JSON.stringify(
    {
      kind: 'ui-dom-owner-diagnostic',
      scene: values.scene,
      composition: 'native-2d-canvas',
      engineGameAcceptance: false,
      artifacts,
      buildIdentity,
      ...(values.scene === 'settings'
        ? {
            consumerSources: await Promise.all(
              [
                'apps/game-capability-lab/assets/plugins/settings.ts',
                'apps/game-capability-lab/assets/ui/settings.pack.json',
              ].map(async (path) => {
                const bytes = await readFile(join(engine, path));
                return {
                  path,
                  bytes: bytes.length,
                  sha256: createHash('sha256').update(bytes).digest('hex'),
                };
              }),
            ),
          }
        : {}),
      kernel: JSON.parse(
        await readFile(join(engine, 'packages/ui-blitz/pkg/provenance.json'), 'utf8'),
      ),
    },
    null,
    2,
  ),
);
process.stdout.write(JSON.stringify({ output, artifacts }) + '\n');
