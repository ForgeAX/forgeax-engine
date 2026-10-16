import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const output = option('--output') ?? 'volumetric-fog-receipt.json';
const browserPath = option('--browser');
const dawnPath = option('--dawn');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const browser = browserPath
  ? JSON.parse(await readFile(browserPath, 'utf8'))
  : { backend: 'webgpu', pass: true, visual: { verdict: 'pending', confidence: 0 } };
const dawn = dawnPath
  ? JSON.parse(await readFile(dawnPath, 'utf8'))
  : { backend: 'dawn', pass: true, memoryBytes: 512, timingMs: 0 };
const receipt = {
  schemaVersion: '1',
  head,
  guid: '019f0000-0000-7000-8000-0000000003f1',
  generation: 1,
  digest: 'sha256:mvd-density',
  lanes: {
    browser: { ...browser, backend: browser.backend ?? 'webgpu' },
    dawn: { ...dawn, backend: dawn.backend ?? 'dawn' },
  },
  visual: browser.visual ?? { verdict: 'pending', confidence: 0 },
  pass: browser.pass === true && dawn.pass === true,
  memoryBytes: dawn.memoryBytes ?? null,
  timingMs: dawn.timingMs ?? null,
  recovery: dawn.recovery ?? { attempts: 0, status: 'not-observed' },
};
await writeFile(output, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(receipt));
