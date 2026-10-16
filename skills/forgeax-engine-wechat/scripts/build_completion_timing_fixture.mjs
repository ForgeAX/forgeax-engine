import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function buildCompletionTimingFixture({ engineSource, toolRoot, out }) {
  const sourcePath = join(engineSource, 'packages/rhi-wgpu/src/internal/native-completion.ts');
  const original = await readFile(sourcePath);
  const require = createRequire(await realpath(join(toolRoot, 'node_modules/tsup/dist/index.js')));
  const { transform, build } = require('esbuild');
  const driver = (
    await transform(original.toString(), { loader: 'ts', format: 'cjs', target: 'chrome70' })
  ).code;
  const entry = `import {runControlledCompletionScenarios} from './completion_timing_fixture.mjs';
function createDriver(target, now) {
  const setTimeout = (...args) => target.setTimeout(...args);
  const Date = {now};
  const module = {exports:{}}; const exports = module.exports;
  ${driver}
  return module.exports.driveNativeCompletion;
}
export async function run({gamePaused = false} = {}) {
  if (gamePaused !== true) throw new Error('Pause and drain the actual game before this controlled fixture');
  return runScenarios();
}
async function runScenarios() {
  const result = await runControlledCompletionScenarios(createDriver);
  return {...result, driverSourceSha256:${JSON.stringify(sha(original))}};
}`;
  const autoEntry = `${entry}
const executionRealm = 'standalone-minigame-no-app-or-gpu';
const initial = {schemaVersion:'forgeax-controlled-native-completion/1', diagnosticOnly:true,
  executionRealm, driverSourceSha256:${JSON.stringify(sha(original))}};
globalThis.__forgeaxControlledCompletionResult = {...initial, status:'running'};
runScenarios().then(
  result => { globalThis.__forgeaxControlledCompletionResult = {...result, executionRealm}; },
  error => { globalThis.__forgeaxControlledCompletionResult = {...initial, status:'failed', error:String(error && error.stack || error)}; }
);`;
  async function bundleSource(contents, globalName) {
    const built = await build({
      stdin: {
        contents,
        resolveDir: here,
        sourcefile: 'controlled-completion-entry.mjs',
        loader: 'js',
      },
      bundle: true,
      platform: 'neutral',
      format: 'iife',
      globalName,
      target: 'chrome70',
      write: false,
    });
    const bytes = built.outputFiles[0].contents;
    assert.ok(
      !/\b(?:require|import)\s*\(['"]node:/.test(Buffer.from(bytes).toString()),
      'Game realm must not import Node APIs',
    );
    return bytes;
  }
  const bundle = await bundleSource(entry, '__forgeaxControlledCompletion');
  const game = await bundleSource(autoEntry);
  await mkdir(out, { recursive: false });
  await writeFile(join(out, 'completion-fixture.js'), bundle, { flag: 'wx', mode: 0o600 });
  await writeFile(join(out, 'game.js'), game, { flag: 'wx', mode: 0o600 });
  const manifest = {
    schemaVersion: 'forgeax-controlled-native-completion-build/1',
    diagnosticOnly: true,
    driverSourceSha256: sha(original),
    bundleSha256: sha(bundle),
    bundleBytes: bundle.length,
    standaloneGame: {
      entry: 'game.js',
      sha256: sha(game),
      bytes: game.length,
      resultGlobal: '__forgeaxControlledCompletionResult',
      officialResultRead: 'GameGlobal.__gameContextWindow.__forgeaxControlledCompletionResult',
      scope:
        'Independent compileType game project: no actual App, GPU or gameplay. No AppID or project configuration is generated.',
    },
    libraryInvocation: '__forgeaxControlledCompletion.run({gamePaused:true})',
    precondition:
      'Load game.js through a separate MiniGame project entry; official automation only reads the game-realm result. Never replace an ordinary project or infer game-realm execution from driver evaluation.',
    acceptance: 'All three shared scenarios passed; this is not ordinary game timing.',
  };
  await writeFile(join(out, 'fixture-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      'engine-source': { type: 'string' },
      'tool-root': { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
  });
  if (values.help)
    console.log(
      'Usage: node build_completion_timing_fixture.mjs --engine-source CHECKOUT --tool-root DEPENDENCIES --out NEW_DIRECTORY',
    );
  else {
    for (const key of ['engine-source', 'tool-root', 'out'])
      assert.ok(values[key], `--${key} required`);
    console.log(
      JSON.stringify(
        await buildCompletionTimingFixture({
          engineSource: values['engine-source'],
          toolRoot: values['tool-root'],
          out: values.out,
        }),
      ),
    );
  }
}
