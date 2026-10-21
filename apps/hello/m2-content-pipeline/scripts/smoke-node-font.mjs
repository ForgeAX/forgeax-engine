import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bakeFont } from '../../../../packages/font/dist/cli-font.mjs';

const root = new URL('../../../../', import.meta.url);
const output = new URL('.forgeax-gauntlet/hello-m2-content-pipeline/node-font-worker/', root);
await mkdir(output, { recursive: true });
const invalid = new URL('invalid.woff2', output);
await writeFile(invalid, Buffer.from('wOF2\u0000\u0000\u0000\u0000'));
await assert.rejects(bakeFont(fileURLToPath(invalid), fileURLToPath(output)), {
  code: 'unsupported-font-format',
  expected: 'ttf',
});

const result = await bakeFont(
  fileURLToPath(new URL('forgeax-engine-assets/dejavu-fonts/DejaVuSansMono.ttf', root)),
  fileURLToPath(output),
);
const png = await readFile(result.atlasPath);
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
const sidecar = JSON.parse(await readFile(result.sidecarPath, 'utf8'));
const glyphs = Object.keys(sidecar.glyphs ?? {});
assert.equal(sidecar.common?.atlasWidth, 1024);
assert.ok(glyphs.length > 90, `invalid glyph count: ${glyphs.length}`);
console.log(`[m2-content] plain Node font bake + structured recovery: PASS glyphs=${glyphs.length}`);
