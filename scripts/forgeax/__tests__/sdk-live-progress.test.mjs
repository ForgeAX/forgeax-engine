import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test, { mock } from 'node:test';
import { sdkStage } from '../sdk-stage.mjs';
import { createSdkVerifierProcess } from '../verify-sdk-process.mjs';

const verifier = await readFile(new URL('../verify-sdk.mjs', import.meta.url), 'utf8');
const start = verifier.indexOf('const execFileAsync =');
const end = verifier.indexOf('const args =', start);
assert.ok(start >= 0 && end > start);
const invoke = new Function(
  'processRunner',
  'sdkStage',
  `${verifier.slice(start, end)}\nreturn execFileAsync;`,
);

test('source View progress reaches stderr before its child can finish', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'sdk-live-progress-'));
  const acknowledgement = resolve(root, 'observed');
  const messages = [];
  const writes = [];
  const stderr = mock.method(process.stderr, 'write', (chunk) => {
    messages.push(String(chunk));
    if (writes.length === 0 && messages.join('').includes('live-error-channel'))
      writes.push(writeFile(acknowledgement, 'observed'));
    return true;
  });
  const run = invoke(createSdkVerifierProcess('pnpm@12.10.1'), sdkStage);
  try {
    const result = await run(
      process.execPath,
      [
        '-e',
        `const fs=require('node:fs');
process.stdout.write('live-stage');process.stderr.write('live-error-channel');
const poll=setInterval(()=>{if(fs.existsSync(process.argv[1])){clearInterval(poll);clearTimeout(deadline);}},10);
const deadline=setTimeout(()=>{clearInterval(poll);process.exitCode=17;},2000);`,
        acknowledgement,
      ],
      { streamOutput: true },
    );
    assert.equal(result.stdout, 'live-stage');
    assert.equal(result.stderr, 'live-error-channel');
    assert.ok(messages.join('').includes('live-stage'));
    assert.ok(messages.join('').includes('live-error-channel'));
  } finally {
    stderr.mock.restore();
    await Promise.all(writes);
    await rm(root, { recursive: true, force: true });
  }
});

test('source Preview queue events and View progress opt into live output', () => {
  assert.equal(verifier.match(/streamOutput: true/g)?.length, 2);
  assert.match(verifier, /const sourceSmokeOptions = \{\s+streamOutput: true/);
  assert.match(
    verifier,
    /verifyPublicSourceViewTool[\s\S]*verify-diagnostic-pages-integration\.mjs[\s\S]*streamOutput: true/,
  );
});
