import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'engine-root': { type: 'string' }, out: { type: 'string' }, appid: { type: 'string' }, help: { type: 'boolean' },
} });
const usage = 'node build_digest_probe.mjs --engine-root PATH --out NEW_DIRECTORY [--appid LOCAL_APPID]';
if (values.help) { console.log(usage); process.exit(0); }
if (!values['engine-root'] || !values.out) throw Error(usage);
const appid = values.appid ?? 'touristappid';
if (!/^(wx[0-9a-f]{16}|touristappid)$/.test(appid)) throw Error('invalid local AppID');
const engine = resolve(values['engine-root']), out = resolve(values.out);
const scripts = dirname(fileURLToPath(import.meta.url));
const owner = join(engine, 'packages/rhi-debug/src/protocol/digest-async.ts');
const sha256 = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const inputs = { source: { owner: 'packages/rhi-debug/src/protocol/digest-async.ts', digest: sha256(await readFile(owner)) },
  cases: [64, 1024 * 1024].map(size => {
    const bytes = Buffer.alloc(size);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 17) & 255;
    return { size, digest: sha256(bytes) };
  }) };
await mkdir(out);
await writeFile(join(out, 'inputs.generated.js'), 'export const inputs=' + JSON.stringify(inputs) + ';\n');
const { build } = createRequire(await realpath(join(engine, 'node_modules/tsup/dist/index.js')))('esbuild');
const result = await build({ entryPoints: [join(scripts, '../fixtures/digest-probe/game.js')],
  outfile: join(out, 'game.js'), format: 'iife', bundle: true, platform: 'browser', target: 'chrome70',
  alias: { '@probe/real-digest': owner, '@probe/digest-inputs': join(out, 'inputs.generated.js') },
  metafile: true,
});
await writeFile(join(out, 'game.json'), JSON.stringify({ deviceOrientation: 'landscape' }, null, 2) + '\n');
await writeFile(join(out, 'project.config.json'), JSON.stringify({ appid, compileType: 'game',
  projectname: 'ForgeAX native digest probe', setting: { es6: false, enhance: false, minified: false } }, null, 2) + '\n');
await writeFile(join(out, 'probe-inputs.json'), JSON.stringify({ ...inputs, graphics: false,
  bundle: { byteLength: (await readFile(join(out, 'game.js'))).length, digest: sha256(await readFile(join(out, 'game.js'))) },
  modules: Object.keys(result.metafile.inputs) }, null, 2) + '\n');
console.log(JSON.stringify({ out, source: inputs.source, modules: Object.keys(result.metafile.inputs).length }));
