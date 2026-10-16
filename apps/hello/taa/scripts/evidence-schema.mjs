import Ajv2020 from 'ajv/dist/2020.js';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schema = JSON.parse(await readFile(resolve(root, 'evidence/schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

function check(value, label) {
  if (!validate(value)) throw new Error(`${label}: ${JSON.stringify(validate.errors)}`);
}

const fixture = {
  schemaVersion: 'hello-taa-auto-exposure-evidence/1', featureId: 'feat-20260827-auto-exposure-hdr-color-grading',
  source: { path: 'src/main.ts', sha256: 'a'.repeat(64) },
  build: { command: 'vite build', sha256: 'b'.repeat(64) },
  backend: 'browser-webgpu', runner: { kind: 'local', id: 'runner' }, resolution: { width: 1, height: 1 }, frames: 60,
  frameIdentity: { first: 1, last: 60, sequenceSha256: 'c'.repeat(64) },
  stages: [
    { id: 'linear-hdr', domain: 'linear-HDR', readback: { rawHash: 'd'.repeat(64), frame: 59 } },
    { id: 'linear-ldr', domain: 'linear-LDR', readback: { rawHash: 'e'.repeat(64), frame: 59 } },
    { id: 'final-display', domain: 'final-sRGB', readback: { rawHash: 'f'.repeat(64), frame: 59 } },
  ],
  exposure: { mode: 'auto', ev: { first: 0, last: 0, generation: 1 } },
  lut: { generation: 1, strength: 0, sourceKey: 'none' },
  resourceGrowth: { stableFrames: 60, byteLengthDelta: 0, bindGroupDelta: 0 },
  visualEvidence: ['exposure-adaptation-card', 'white-balance-card', 'lut-output-card'].map((id) => ({ id, png: `${id}.png`, observed: 'read', verdict: 'pass', confidence: 'high' })),
  falsify: [{ id: 'stale-history', result: 'pass' }], status: 'pass',
};
check(fixture, 'self-test valid fixture');
const unavailable = structuredClone(fixture);
unavailable.status = 'unavailable';
for (const card of unavailable.visualEvidence) card.verdict = 'unavailable';
unavailable.visualEvidence[0].verdict = 'pass';
if (validate(unavailable)) throw new Error('self-test accepted unavailable evidence as pass');

const input = process.argv[2];
if (input) {
  const evidence = JSON.parse(await readFile(resolve(process.cwd(), input), 'utf8'));
  check(evidence, input);
  console.log(`hello-taa evidence schema PASS: ${input}`);
} else {
  console.log('hello-taa evidence schema self-test PASS');
}
