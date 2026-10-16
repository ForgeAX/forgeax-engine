import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export async function bundlePhoneDiagnostic(probe, engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')) {
  if (!['gl-link', 'startup'].includes(probe)) throw new Error('Unknown phone diagnostic: ' + probe);
  const filename = probe === 'startup' ? 'phone_startup_report_prefix.js' : 'phone_gl_link_prefix.js';
  const { build } = createRequire(await realpath(join(engineRoot, 'node_modules/tsup/dist/index.js')))('esbuild');
  const hostRequire = createRequire(join(engineRoot, 'packages/platform-wechat/package.json'));
  const result = await build({
    stdin: { contents: await readFile(new URL(filename, import.meta.url), 'utf8'),
      sourcefile: filename, resolveDir: dirname(fileURLToPath(import.meta.url)) },
    alias: {
      '@noble/hashes/sha2.js': hostRequire.resolve('@noble/hashes/sha2.js'),
      '@exodus/bytes/utf8.js': join(dirname(hostRequire.resolve('@exodus/bytes/utf8.js')), 'utf8.js'),
    },
    // Browser shortcuts assume TextEncoder already exists; this runs before bootstrap.
    bundle: true, write: false, format: 'iife', platform: 'neutral', target: 'chrome70',
  });
  return result.outputFiles[0].text;
}

export async function bundlePhoneGlLink(engineRoot) { return bundlePhoneDiagnostic('gl-link', engineRoot); }

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: { 'engine-root': { type: 'string' }, probe: { type: 'string', default: 'gl-link' } } });
  process.stdout.write(await bundlePhoneDiagnostic(values.probe, values['engine-root']));
}
