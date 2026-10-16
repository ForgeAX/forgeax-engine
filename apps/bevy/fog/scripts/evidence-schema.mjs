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
  schemaVersion: 'bevy-fog-evidence/1', featureId: 'feature',
  source: { path: 'src/main.ts', sha256: 'a'.repeat(64) },
  build: { command: 'vite build', sha256: 'b'.repeat(64) },
  backend: 'dawn-node', runner: { kind: 'local', id: 'runner' }, frames: 60,
  frameIdentity: { first: 1, last: 60, sequenceSha256: 'c'.repeat(64) },
  visualEvidence: [{ id: 'fog', png: 'fog.png', observed: 'read', verdict: 'pass', confidence: 'high' }],
  falsify: [{ id: 'wrong-owner', result: 'pass' }], status: 'pass',
};
check(fixture, 'self-test valid fixture');
const unavailable = structuredClone(fixture);
unavailable.status = 'unavailable';
unavailable.visualEvidence[0].verdict = 'pass';
if (validate(unavailable)) throw new Error('self-test accepted unavailable evidence as pass');

const input = process.argv[2];
if (input) {
  const evidence = JSON.parse(await readFile(resolve(process.cwd(), input), 'utf8'));
  check(evidence, input);
  console.log(`bevy-fog evidence schema PASS: ${input}`);
} else {
  console.log('bevy-fog evidence schema self-test PASS');
}
