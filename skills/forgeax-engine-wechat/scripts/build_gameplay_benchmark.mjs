import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { brotliDecompressSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
export function replaceOnce(text, from, to, changes, reason) {
  assert.equal(text.split(from).length, 2, `Host seam must match once: ${reason}`);
  changes.push({ reason, from, to });
  return text.replace(from, to);
}
/** Official phone compilation admits the ordinary Chrome 70 syntax contract. */
export function assertPhoneBundleSyntax(source, parse) {
  walk(parse(source, { ecmaVersion: 'latest', sourceType: 'script' }), (node) => {
    assert.ok(
      node.type !== 'ChainExpression' &&
        !(node.type === 'LogicalExpression' && node.operator === '??') &&
        !(node.type === 'AssignmentExpression' && ['??=', '&&=', '||='].includes(node.operator)),
      'Phone bundle retains unsupported optional-chain/nullish/logical-assignment syntax',
    );
  });
}
function walk(node, callback, parent) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') callback(node, parent);
  for (const value of Object.values(node))
    if (Array.isArray(value))
      value.forEach((child) => {
        walk(child, callback, node);
      });
    else if (value && typeof value === 'object') walk(value, callback, node);
}

export function browserPlatformSeam(host, parse) {
  const candidates = [];
  walk(parse(host, { ecmaVersion: 'latest', sourceType: 'script' }), (node) => {
    if (
      node.type !== 'CallExpression' ||
      node.callee.type !== 'MemberExpression' ||
      node.callee.computed ||
      node.callee.object.type !== 'Identifier' ||
      node.arguments.length !== 2 ||
      node.arguments[0].type !== 'ObjectExpression' ||
      node.arguments[1].type !== 'Identifier' ||
      node.arguments[1].name !== 'Nr'
    )
      return;
    const keys = node.arguments[0].properties.map((property) => property.key?.name);
    if (['wx', 'requestAnimationFrame', 'cancelAnimationFrame'].every((key) => keys.includes(key)))
      candidates.push(node);
  });
  assert.equal(candidates.length, 1, 'Exactly one ordinary native Platform seam');
  const node = candidates[0];
  const namespace = node.callee.object.name;
  const source = host.slice(node.start, node.end);
  assert.equal(
    source,
    `${namespace}.i({wx,requestAnimationFrame:e=>requestAnimationFrame(e),cancelAnimationFrame:e=>cancelAnimationFrame(e)},Nr)`,
    'Ordinary native Platform contract',
  );
  return { namespace, source };
}

export function replaceGameWasmHost(game, parse, path, changes) {
  const candidates = [];
  walk(parse(game, { ecmaVersion: 'latest', sourceType: 'script' }), (node) => {
    if (
      node.type !== 'CallExpression' ||
      node.arguments.length !== 0 ||
      node.callee.type !== 'MemberExpression' ||
      node.callee.computed ||
      node.callee.property.name !== 'unwrap'
    )
      return;
    const call = node.callee.object;
    if (
      call.type !== 'CallExpression' ||
      call.callee.type !== 'MemberExpression' ||
      call.callee.computed ||
      call.callee.object.type !== 'Identifier' ||
      call.arguments.length !== 2
    )
      return;
    const [options, wasmPath] = call.arguments;
    if (
      options.type !== 'ObjectExpression' ||
      options.properties.length !== 2 ||
      !options.properties.every(
        (property) =>
          property.type === 'Property' &&
          !property.computed &&
          ['wx', 'WXWebAssembly'].includes(property.key.name) &&
          property.value.type === 'Identifier' &&
          property.value.name === property.key.name,
      ) ||
      new Set(options.properties.map((property) => property.key.name)).size !== 2 ||
      wasmPath.type !== 'TemplateLiteral' ||
      wasmPath.expressions.length !== 0 ||
      wasmPath.quasis[0].value.cooked !== path
    )
      return;
    candidates.push(node);
  });
  assert.equal(candidates.length, 1, `Exactly one ordinary native WASM seam: ${path}`);
  const node = candidates[0];
  return replaceOnce(
    game,
    game.slice(node.start, node.end),
    `__browserHost.createBrowserWasmHost(${JSON.stringify(path)})`,
    changes,
    `Unchanged ${path} WASM`,
  );
}

export function instrumentGameplayHost(host, parse, changes) {
  const edit = (text, from, to, reason) => replaceOnce(text, from, to, changes, reason);
  const ast = parse(host, { ecmaVersion: 'latest', sourceType: 'script' });
  const candidates = [];
  walk(ast, (node, parent) => {
    if (node.type !== 'ObjectExpression') return;
    const keys = node.properties.map((property) => property.key?.name);
    if (
      ['platform', 'world', 'renderer', 'onFrameCompleted', 'onFrameSubmitted'].every((key) =>
        keys.includes(key),
      )
    )
      candidates.push({ options: node, call: parent });
  });
  assert.equal(candidates.length, 1, 'Exactly one ordinary App assembly');
  const { options, call } = candidates[0];
  assert.equal(call?.type, 'CallExpression', 'App options must be a direct constructor argument');
  assert.ok(call.arguments.includes(options), 'Actual App call owns the observed options');
  const platform = options.properties.find((property) => property.key?.name === 'platform')?.value;
  assert.equal(platform?.type, 'Identifier', 'Actual native Platform must be a retained binding');
  const resolved = [];
  walk(ast, (node) => {
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      !node.callee.computed &&
      node.callee.property.name === 'unwrap' &&
      node.callee.object.type === 'AwaitExpression' &&
      node.callee.object.argument === call
    )
      resolved.push(node);
  });
  assert.equal(resolved.length, 1, 'Exactly one awaited App Result unwrap');
  const app = resolved[0];
  const original = host.slice(options.start, options.end),
    appCall = host.slice(app.start, app.end),
    observed = `__gameplayBenchmark.observeOptions(${original},${platform.name})`,
    observedCall =
      appCall.slice(0, options.start - app.start) +
      observed +
      appCall.slice(options.end - app.start);
  host = edit(
    host,
    appCall,
    `__gameplayBenchmark.bindApp(${observedCall})`,
    'Compose existing callbacks and bind the resolved App after its original await and unwrap',
  );
  return host;
}

export function instrumentPhoneDiagnostic(host, parse, changes, mode) {
  if (mode === 'timed' || mode === 'qualification' || mode === 'transport-probe') return host;
  const candidates = [];
  walk(parse(host, { ecmaVersion: 'latest', sourceType: 'script' }), (node) => {
    if (mode === 'cpu' && node.type === 'ObjectExpression') {
      const keys = node.properties.map((property) => property.key?.name);
      if (
        ['rhi', 'features', 'ui', 'dynamicGeometryMeshBudgetBytes'].every((key) =>
          keys.includes(key),
        )
      )
        candidates.push(node);
    }
    if (
      (mode === 'gpu' || mode === 'completion') &&
      node.type === 'CallExpression' &&
      node.arguments.length === 0 &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.name === 'unwrap'
    ) {
      const call = node.callee.object,
        path = call.arguments?.[1];
      if (
        call.type === 'CallExpression' &&
        call.arguments.length === 3 &&
        path?.type === 'TemplateLiteral' &&
        path.expressions.length === 0 &&
        path.quasis[0].value.cooked === 'payload/wasm/wgpu.wasm.br' &&
        call.arguments[2].type === 'ArrayExpression'
      )
        candidates.push(node);
    }
  });
  assert.equal(candidates.length, 1, `Exactly one ordinary ${mode} diagnostic owner`);
  const node = candidates[0],
    original = host.slice(node.start, node.end);
  return replaceOnce(
    host,
    original,
    mode === 'completion'
      ? `globalThis.__forgeaxCompletionTiming.wrapHost(${original})`
      : `__gameplayBenchmark.${mode === 'cpu' ? 'rendererOptions' : 'gpuHost'}(${original})`,
    changes,
    mode === 'completion'
      ? 'Observe existing native completion calls without adding GL work'
      : mode === 'cpu'
        ? 'Share one opt-in CPU profiler with existing Renderer and App'
        : 'Observe existing native submit/present with opt-in GPU elapsed queries',
  );
}

export async function buildGameplayBenchmark({
  publication,
  engineSource,
  toolRoot,
  out,
  sourceCommit,
  expectedManifestSha256,
  width = 844,
  height = 390,
  dpr = 3,
}) {
  publication = resolve(publication);
  engineSource = resolve(engineSource);
  toolRoot = resolve(toolRoot);
  out = resolve(out);
  assert.match(sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(expectedManifestSha256, /^[0-9a-f]{64}$/);
  assert.ok([width, height, dpr].every((value) => Number.isInteger(value) && value > 0));
  const manifestBytes = await readFile(join(publication, 'forgeax-dist.json'));
  assert.equal(
    sha(manifestBytes),
    expectedManifestSha256,
    'Ordinary publication manifest identity',
  );
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.target, 'wechat');
  const verify = async (root) => {
    for (const row of manifest.artifacts) {
      const path = resolve(root, row.path);
      assert.ok(path.startsWith(root + sep), 'Publication path containment');
      const bytes = await readFile(path);
      assert.equal(bytes.length, row.bytes, row.path);
      assert.equal(sha(bytes), row.sha256, row.path);
    }
  };
  await verify(publication);
  await mkdir(out);
  await writeFile(join(out, 'package.json'), '{"type":"commonjs"}\n');
  for (const row of manifest.artifacts) {
    const path = join(out, row.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await readFile(join(publication, row.path)));
  }
  await writeFile(join(out, 'forgeax-dist.json'), manifestBytes);
  const selectOne = (expression) => {
    const matches = manifest.artifacts.filter((row) => expression.test(row.path));
    assert.equal(matches.length, 1, `Unique ${expression} entry`);
    return matches[0].path;
  };
  const hostFile = selectOne(/^payload\/assets\/wechat-main-[^/]+\.js$/),
    gameFile = selectOne(/^payload\/assets\/wechat-game-[^/]+\.js$/);
  const toolRequire = createRequire(
    await realpath(join(toolRoot, 'node_modules/tsup/dist/index.js')),
  );
  const { build } = toolRequire('esbuild'),
    { parse } = toolRequire('acorn');
  const changes = [],
    transformed = new Map();
  const edit = (text, from, to, reason) => replaceOnce(text, from, to, changes, reason);
  let host = await readFile(join(publication, hostFile), 'utf8');
  assert.ok(!host.includes('__gameplayBenchmark') && !host.includes('__browserHost'));
  const platformSeam = browserPlatformSeam(host, parse);
  const nativeNamespace = platformSeam.namespace;
  host = edit(
    host,
    'Nr=wx.createCanvas()',
    'Nr=document.querySelector("canvas")',
    'Connected browser canvas',
  );
  host = edit(
    host,
    platformSeam.source,
    '__browserHost.createBrowserPlatform(Nr)',
    'Ordinary Browser Platform',
  );
  host = edit(host, 'b={wx,WXWebAssembly},', '', 'Remove WeChat WASM host');
  host = edit(
    host,
    `${nativeNamespace}.r(wx,{root:\`payload\`,baseUrl:\`https://forgeax.package/\`,encoding:\`br\`})`,
    '__browserHost.packageFetch',
    'Same publication resources through HTTP',
  );
  host = edit(
    host,
    `${nativeNamespace}.a(b,\`payload/wasm/ui.wasm.br\`).unwrap()`,
    '__browserHost.createBrowserWasmHost(`payload/wasm/ui.wasm.br`)',
    'Unchanged Blitz WASM',
  );
  host = edit(
    host,
    `${nativeNamespace}.n(wx,v,{ui:f.input,keyboard:wx,onError:e=>console.warn(\`ForgeaX native input failed\`,e)}).unwrap()`,
    '__browserHost.createBrowserInput(y,f.input,e=>console.warn(`ForgeaX native input failed`,e))',
    'Real DOM contacts into Blitz',
  );
  host = edit(
    host,
    `${nativeNamespace}.t(wx,v,{onError:C})`,
    '__browserHost.createWebAudioBackend()',
    'Ordinary browser audio',
  );
  host = edit(
    host,
    `${nativeNamespace}.o(b,\`payload/wasm/wgpu.wasm.br\`,[y]).unwrap()`,
    '__browserHost.createBrowserWgpuHost(`payload/wasm/wgpu.wasm.br`,[y])',
    'Unchanged native wgpu binding and WASM',
  );
  host = instrumentGameplayHost(host, parse, changes);
  host = edit(
    host,
    'exports.start=Rr;',
    'exports.start=Rr;exports.disposeHost=async()=>{await Ir?.();};',
    'Expose existing Host cleanup',
  );
  assert.ok(!/\bwx\b|WXWebAssembly/.test(host), 'Unexpected native Host access remains');
  const hostModule = join(here, 'fixtures/gameplay-benchmark/browser-host.ts');
  const observerModule = join(here, 'fixtures/gameplay-benchmark/observer.mjs');
  const prefix = `const __browserHost=require(${JSON.stringify(hostModule)});const __gameplayBenchmark=globalThis.__gameplayBenchmark=require(${JSON.stringify(observerModule)}).createGameplayObserver();\n`;
  transformed.set(join(out, hostFile), prefix + host);
  let game = await readFile(join(publication, gameFile), 'utf8');
  for (const path of ['basis_transcoder', 'rapier3d'])
    game = replaceGameWasmHost(game, parse, `payload/wasm/${path}.wasm.br`, changes);
  assert.ok(!/\bwx\b|WXWebAssembly/.test(game));
  transformed.set(
    join(out, gameFile),
    `const __browserHost=require(${JSON.stringify(hostModule)});\n${game}`,
  );
  const entry = join(out, 'browser-entry.mjs');
  await writeFile(
    entry,
    `import host from ${JSON.stringify(`./${hostFile}`)};export const start=host.start;export const disposeHost=host.disposeHost;`,
  );
  const inputDigests = new Map(),
    sourceInputs = new Map();
  const focusedSources = {
    '#host-platform': 'platform-browser/src/index.ts',
    '#host-input': 'input/src/browser-backend.ts',
    '#host-audio': 'audio-webaudio/src/host-audio-consumer.ts',
  };
  const result = await build({
    absWorkingDir: out,
    entryPoints: [entry],
    outfile: join(out, 'browser.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    conditions: ['forgeax-native', 'import', 'module'],
    sourcemap: 'external',
    metafile: true,
    nodePaths: [join(toolRoot, 'node_modules'), join(toolRoot, 'node_modules/.pnpm/node_modules')],
    define: { 'import.meta.env.DEV': 'false' },
    plugins: [
      {
        name: 'published-game-browser-host',
        setup(b) {
          b.onResolve({ filter: /^#host-/ }, ({ path }) => ({
            path: join(engineSource, 'packages', focusedSources[path]),
          }));
          b.onResolve({ filter: /^@forgeax\/engine-/ }, async ({ path }) => {
            const match = /^@forgeax\/engine-([^/]+)(.*)$/.exec(path);
            const pathBase = join(engineSource, 'packages', match[1]);
            const packageJson = await readJson(join(pathBase, 'package.json'));
            sourceInputs.set(
              join(pathBase, 'package.json'),
              sha(await readFile(join(pathBase, 'package.json'))),
            );
            const select = (value) =>
              typeof value === 'string'
                ? value
                : value && select(value['forgeax-native'] ?? value.import ?? value.default);
            const selected = select(packageJson.exports?.[match[2] ? `.${match[2]}` : '.']);
            assert.ok(selected?.startsWith('./dist/'), `Unsupported source Host import ${path}`);
            return {
              path: join(pathBase, selected.replace('./dist/', './src/').replace(/\.mjs$/, '.ts')),
            };
          });
          b.onLoad({ filter: /\.(mjs|cjs|js|ts)$/ }, async ({ path }) => {
            const bytes = await readFile(path);
            inputDigests.set(path, sha(bytes));
            return transformed.has(path)
              ? { contents: transformed.get(path), loader: 'js', resolveDir: dirname(path) }
              : null;
          });
        },
      },
    ],
  });
  for (const [file, digest] of [...inputDigests, ...sourceInputs])
    assert.equal(sha(await readFile(file)), digest, `Input changed while bundling: ${file}`);
  await verify(publication);
  await verify(out);
  const native = manifest.artifacts
    .filter((row) => /payload\/wasm\/.*\.wasm.br$/.test(row.path))
    .map((row) => ({ path: row.path, compressedSha256: row.sha256 }));
  for (const row of native) {
    const bytes = brotliDecompressSync(await readFile(join(publication, row.path)));
    row.sha256 = sha(bytes);
    row.bytes = bytes.length;
  }
  const source = {
    engineCommit: sourceCommit,
    publicationManifestSha256: expectedManifestSha256,
    observerSha256: inputDigests.get(observerModule),
    native,
    adaptedHostModules: [hostFile, gameFile],
    sourceHostRoot: engineSource,
  };
  await writeFile(
    join(out, 'assembly-differences.json'),
    JSON.stringify(
      {
        source,
        changes,
        additionalHostInputs: Object.fromEntries(
          [...inputDigests, ...sourceInputs].filter(([file]) => !file.startsWith(out + sep)),
        ),
        originalPublicationFilesUnchanged: true,
        runtimeStrategyChanged: false,
        addedObservation:
          'Bounded primitive completion/submission arrays, no GL wrappers or profiler.',
      },
      null,
      2,
    ),
  );
  await writeFile(join(out, 'metafile.json'), JSON.stringify(result.metafile, null, 2));
  await writeFile(
    join(out, 'index.html'),
    `<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><style>html,body{margin:0;background:#000;overflow:hidden}canvas{width:${width}px;height:${height}px;display:block;touch-action:none}</style><canvas tabindex="0"></canvas><script type="module">import{start,disposeHost}from"./browser.js";globalThis.disposeHost=disposeHost;start(()=>location.reload()).catch(error=>{globalThis.hostBootError={message:error.message,stack:error.stack};console.error(error)});</script>`,
  );
  const files = [];
  async function inventory(dir) {
    for (const row of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, row.name);
      if (row.isDirectory()) await inventory(path);
      else {
        const bytes = await readFile(path);
        files.push({ path: relative(out, path), bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  await inventory(out);
  await writeFile(
    join(out, 'browser-manifest.json'),
    JSON.stringify(
      {
        schemaVersion: 'forgeax-gameplay-browser/1',
        source,
        extent: { width, height, dpr, drawingWidth: width * dpr, drawingHeight: height * dpr },
        files,
      },
      null,
      2,
    ),
  );
  return { success: true, out, source, files: files.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      ...Object.fromEntries(
        [
          'publication',
          'engine-source',
          'tool-root',
          'out',
          'source-commit',
          'manifest-sha256',
          'target',
          'width',
          'height',
          'dpr',
          'phone-url',
          'run-id',
          'source-provenance',
          'phone-mode',
          'cpu-frames',
        ].map((key) => [key, { type: 'string' }]),
      ),
      'transport-diagnostic': { type: 'boolean' },
      'completion-timing': { type: 'boolean' },
    },
  });
  for (const key of [
    'publication',
    'tool-root',
    'out',
    'source-commit',
    'manifest-sha256',
    ...(['native', 'phone'].includes(values.target) ? [] : ['engine-source']),
  ])
    assert.ok(values[key], `--${key} required`);
  assert.ok(
    !values['completion-timing'] || values.target === 'phone',
    '--completion-timing requires --target phone',
  );
  const builder = ['native', 'phone'].includes(values.target)
    ? buildNativeGameplayBenchmark
    : buildGameplayBenchmark;
  assert.ok(
    values.target === undefined || ['native', 'browser', 'phone'].includes(values.target),
    'target must be native, browser or phone',
  );
  console.log(
    JSON.stringify(
      await builder({
        publication: values.publication,
        engineSource: values['engine-source'],
        toolRoot: values['tool-root'],
        out: values.out,
        sourceCommit: values['source-commit'],
        expectedManifestSha256: values['manifest-sha256'],
        width: Number(values.width ?? 844),
        height: Number(values.height ?? 390),
        dpr: Number(values.dpr ?? 3),
        ...(values.target === 'phone'
          ? {
              phone: {
                controlUrl: values['phone-url'],
                runId: values['run-id'],
                mode: values['phone-mode'] ?? 'timed',
                ...(values['completion-timing'] ? { completionTiming: true } : {}),
                ...(values['transport-diagnostic'] ? { transportDiagnostic: true } : {}),
                ...(values['phone-mode'] === 'cpu'
                  ? { cpuFrames: Number(values['cpu-frames'] ?? 120) }
                  : {}),
              },
            }
          : {}),
        sourceProvenance: values['source-provenance'],
      }),
    ),
  );
}

/** Locate the actual native Promise driver argument, independent of minified names. */
export function instrumentCompletionDriver(source, parse) {
  const candidates = [];
  walk(parse(source, { ecmaVersion: 'latest', sourceType: 'script' }), (node) => {
    if (
      node.type !== 'CallExpression' ||
      node.callee.type !== 'MemberExpression' ||
      node.callee.property.name !== 'call'
    )
      return;
    const method = node.callee.object;
    if (method.type !== 'MemberExpression' || method.property.name !== 'onSubmittedWorkDone')
      return;
    assert.equal(node.arguments.length, 2, 'Expected the native completion driver ABI');
    assert.equal(
      node.arguments[1].type,
      'Identifier',
      'Expected the native completion driver binding',
    );
    candidates.push(node.arguments[1]);
  });
  assert.ok(candidates.length <= 1, 'Ambiguous native completion driver call sites');
  if (!candidates.length) return null;
  const argument = candidates[0];
  return (
    source.slice(0, argument.start) +
    'globalThis.__forgeaxCompletionTiming.driver(' +
    source.slice(argument.start, argument.end) +
    ')' +
    source.slice(argument.end)
  );
}

/** Diagnostic native copy. Only explicitly selected observation is added. */
export async function buildNativeGameplayBenchmark({
  publication,
  toolRoot,
  out,
  sourceCommit,
  expectedManifestSha256,
  phone,
  sourceProvenance,
}) {
  publication = resolve(publication);
  toolRoot = resolve(toolRoot);
  out = resolve(out);
  assert.match(sourceCommit, /^[0-9a-f]{40}$/);
  assert.match(expectedManifestSha256, /^[0-9a-f]{64}$/);
  if (phone) {
    phone = { ...phone, mode: phone.mode ?? 'timed' };
    if (phone.mode !== 'transport-probe') phone.debugPolicy = 'unchanged';
    assert.ok(
      ['timed', 'cpu', 'gpu', 'qualification', 'transport-probe'].includes(phone.mode),
      'Known explicit phone mode required',
    );
    if (phone.completionTiming)
      assert.ok(
        ['timed', 'cpu'].includes(phone.mode),
        'Completion timing requires timed or cpu phone mode',
      );
    if (phone.mode === 'cpu') assert.ok([120, 240].includes(phone.cpuFrames ?? 120));
    const url = /^http:\/\/127\.0\.0\.1:([0-9]{1,5})(\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)$/.exec(
      phone.controlUrl,
    );
    assert.ok(url && +url[1] >= 1 && +url[1] <= 65535, 'Explicit loopback phone URL required');
    assert.match(phone.runId, /^[A-Za-z0-9_-]{16,96}$/);
  }
  const manifestBytes = await readFile(join(publication, 'forgeax-dist.json'));
  assert.equal(sha(manifestBytes), expectedManifestSha256);
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.target, 'wechat');
  const hostRows = manifest.artifacts.filter((row) =>
    /^payload\/assets\/wechat-main-[^/]+\.js$/.test(row.path),
  );
  assert.equal(hostRows.length, 1, 'Unique ordinary Host entry required');
  const hostFile = hostRows[0].path;
  await mkdir(out);
  for (const row of manifest.artifacts) {
    const path = resolve(publication, row.path);
    assert.ok(path.startsWith(publication + sep));
    const bytes = await readFile(path);
    assert.equal(bytes.length, row.bytes, row.path);
    assert.equal(sha(bytes), row.sha256, row.path);
    await mkdir(dirname(join(out, row.path)), { recursive: true });
    await writeFile(join(out, row.path), bytes);
  }
  const require = createRequire(await realpath(join(toolRoot, 'node_modules/tsup/dist/index.js')));
  const { parse } = require('acorn'),
    { build } = require('esbuild');
  const observerPath = join(here, 'fixtures/gameplay-benchmark/observer.mjs');
  const observerBefore = sha(await readFile(observerPath));
  const controllerPath = join(
    here,
    phone?.mode === 'transport-probe'
      ? 'phone_gameplay_transport_probe.mjs'
      : 'phone_gameplay_observer.mjs',
  );
  const controllerBefore = phone ? sha(await readFile(controllerPath)) : undefined;
  const diagnosticPath =
    phone && ['cpu', 'gpu', 'qualification'].includes(phone.mode)
      ? join(here, `phone_gameplay_${phone.mode}.mjs`)
      : undefined;
  const diagnosticBefore = diagnosticPath ? sha(await readFile(diagnosticPath)) : undefined;
  const phoneSource = phone
    ? {
        engineCommit: sourceCommit,
        manifestSha256: expectedManifestSha256,
        entrySha256: hostRows[0].sha256,
        observerSha256: observerBefore,
        controllerSha256: controllerBefore,
        ...(diagnosticBefore ? { diagnosticModuleSha256: diagnosticBefore } : {}),
      }
    : undefined;
  const hostRequire = phone
    ? createRequire(join(toolRoot, 'packages/platform-wechat/package.json'))
    : undefined;
  const observerBundle = await build({
    ...(diagnosticPath
      ? {
          stdin: {
            contents: `export {createPhoneGameplayObserver} from './phone_gameplay_observer.mjs';\nexport {${phone.mode === 'cpu' ? 'createPhoneGameplayCpu' : phone.mode === 'gpu' ? 'installPhoneGameplayGpu' : 'collectPhoneGameplayQualification'}} from './phone_gameplay_${phone.mode}.mjs';`,
            resolveDir: here,
            sourcefile: 'phone-observation-entry.mjs',
          },
        }
      : { entryPoints: [phone ? controllerPath : observerPath] }),
    bundle: true,
    format: 'iife',
    globalName: '__gameplayObserverModule',
    target: phone ? 'chrome70' : 'es2022',
    minify: true,
    write: false,
    ...(phone
      ? {
          platform: 'neutral',
          nodePaths: [join(toolRoot, 'node_modules')],
          alias: {
            '@noble/hashes/sha2.js': hostRequire.resolve('@noble/hashes/sha2.js'),
            '@exodus/bytes/utf8.js': join(
              dirname(hostRequire.resolve('@exodus/bytes/utf8.js')),
              'utf8.js',
            ),
            ...(phone.mode === 'cpu'
              ? {
                  '@forgeax/engine-profiler': resolve(
                    here,
                    '../../../packages/profiler/src/index.ts',
                  ),
                }
              : {}),
          },
        }
      : {}),
  });
  if (phone) assertPhoneBundleSyntax(observerBundle.outputFiles[0].text, parse);
  if (diagnosticPath) assert.equal(sha(await readFile(diagnosticPath)), diagnosticBefore);
  if (phone) phoneSource.bundleSha256 = sha(observerBundle.outputFiles[0].text);
  assert.equal(
    sha(await readFile(observerPath)),
    observerBefore,
    'Observer source changed during build',
  );
  if (phone)
    assert.equal(
      sha(await readFile(controllerPath)),
      controllerBefore,
      'Phone controller source changed during build',
    );
  const changes = [],
    originalHost = await readFile(join(publication, hostFile), 'utf8');
  assert.ok(!originalHost.includes('__gameplayBenchmark'));
  const transformedHost = Buffer.from(
    observerBundle.outputFiles[0].text +
      '\nconst __gameplayBenchmark=globalThis.__gameplayBenchmark=' +
      (phone
        ? '__gameplayObserverModule.createPhoneGameplayObserver(' +
          JSON.stringify({ ...phone, source: phoneSource }) +
          ',wx' +
          (phone.mode === 'cpu'
            ? ',undefined,{cpu:__gameplayObserverModule.createPhoneGameplayCpu({now:()=>__gameplayBenchmark.now()})}'
            : phone.mode === 'gpu'
              ? ',undefined,{gpu:__gameplayObserverModule.installPhoneGameplayGpu({now:()=>__gameplayBenchmark.now()})}'
              : phone.mode === 'qualification'
                ? ',undefined,{qualify:__gameplayObserverModule.collectPhoneGameplayQualification}'
                : '') +
          ')'
        : '__gameplayObserverModule.createGameplayObserver()') +
      ';\n' +
      instrumentGameplayHost(
        phone?.completionTiming
          ? instrumentPhoneDiagnostic(
              instrumentPhoneDiagnostic(originalHost, parse, changes, phone.mode),
              parse,
              changes,
              'completion',
            )
          : phone
            ? instrumentPhoneDiagnostic(originalHost, parse, changes, phone.mode)
            : originalHost,
        parse,
        changes,
      ),
  );
  await writeFile(join(out, hostFile), transformedHost);
  const mutated = new Map([[hostFile, transformedHost]]);
  if (phone?.completionTiming) {
    const drivers = [];
    for (const row of manifest.artifacts.filter((entry) => entry.path.endsWith('.js'))) {
      const bytes = mutated.get(row.path) ?? (await readFile(join(out, row.path)));
      const transformed = instrumentCompletionDriver(bytes.toString('utf8'), parse);
      if (transformed === null) continue;
      drivers.push(row.path);
      const result = Buffer.from(transformed);
      mutated.set(row.path, result);
      await writeFile(join(out, row.path), result);
      changes.push({
        reason:
          'Observe the existing native Promise driver; preserve its returned Promise and original polls',
        path: row.path,
        beforeSha256: sha(bytes),
        afterSha256: sha(result),
      });
    }
    assert.equal(drivers.length, 1, 'Exactly one native completion driver artifact required');
  }
  const diagnosticManifest = {
    ...manifest,
    artifacts: manifest.artifacts.map((row) =>
      mutated.has(row.path)
        ? { ...row, bytes: mutated.get(row.path).length, sha256: sha(mutated.get(row.path)) }
        : row,
    ),
  };
  const diagnosticBytes = Buffer.from(`${JSON.stringify(diagnosticManifest, null, 2)}\n`);
  await writeFile(join(out, 'forgeax-dist.json'), diagnosticBytes);
  await writeFile(join(out, 'ordinary-forgeax-dist.json'), manifestBytes);
  for (const row of manifest.artifacts) {
    assert.equal(
      sha(await readFile(join(publication, row.path))),
      row.sha256,
      `Source changed: ${row.path}`,
    );
    const expected = mutated.has(row.path) ? sha(mutated.get(row.path)) : row.sha256;
    assert.equal(
      sha(await readFile(join(out, row.path))),
      expected,
      `Unexpected diagnostic mutation: ${row.path}`,
    );
  }
  const source = {
    engineCommit: sourceCommit,
    publicationManifestSha256: expectedManifestSha256,
    diagnosticManifestSha256: sha(diagnosticBytes),
    observerSha256: observerBefore,
    scope:
      'Ordinary WeChat Host and full published game with App completion observation; source commit explicitly identifies the baseline, not current main.',
    adaptedHostModules: [...mutated.keys()],
    native: [],
    ...(phone ? { phone: { ...phone, reportSource: phoneSource } } : {}),
  };
  if (sourceProvenance) {
    const provenanceBytes = await readFile(resolve(sourceProvenance));
    const prior = JSON.parse(provenanceBytes).source;
    assert.equal(prior?.engineCommit, sourceCommit, 'Provenance source commit');
    assert.equal(
      prior?.publicationManifestSha256,
      expectedManifestSha256,
      'Provenance ordinary publication',
    );
    assert.ok(prior.sourceClosure, 'Explicit prior source closure required');
    source.sourceClosure = prior.sourceClosure;
    source.provenanceSha256 = sha(provenanceBytes);
  }
  for (const row of manifest.artifacts.filter((row) =>
    /payload\/wasm\/.*\.wasm.br$/.test(row.path),
  )) {
    const bytes = brotliDecompressSync(await readFile(join(out, row.path)));
    source.native.push({
      path: row.path,
      sha256: sha(bytes),
      bytes: bytes.length,
      compressedSha256: row.sha256,
    });
  }
  await writeFile(
    join(out, 'assembly-differences.json'),
    JSON.stringify(
      {
        source,
        changes,
        hostOriginalSha256: sha(originalHost),
        hostObservedSha256: sha(transformedHost),
        originalCallbacksPreserved: true,
        hostPlatformChanged: false,
        runtimeStrategyChanged: false,
        originalPublicationSourceUnchanged: true,
      },
      null,
      2,
    ),
  );
  const files = [];
  async function inventory(dir) {
    for (const row of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, row.name);
      if (row.isDirectory()) await inventory(path);
      else {
        const bytes = await readFile(path);
        files.push({ path: relative(out, path), bytes: bytes.length, sha256: sha(bytes) });
      }
    }
  }
  await inventory(out);
  await writeFile(
    join(out, 'benchmark-manifest.json'),
    JSON.stringify({ schemaVersion: 'forgeax-gameplay-native/1', source, files }, null, 2),
  );
  return { success: true, out, source, files: files.length };
}
