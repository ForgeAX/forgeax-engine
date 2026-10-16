import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('preserves nested startup failures without running author inspection hooks', () => {
  const moduleUrl = new URL('../backend-startup.ts', import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `import { traceBackendStartup } from ${JSON.stringify(moduleUrl)};
       import { inspect } from 'node:util';
       process.argv[2] = '--__forgeax-backend';
       let hooks = 0;
       const inner = { code: 'asset-publication-failed', detail: 'original owner' };
       Object.defineProperty(inner, 'unsafe', { enumerable: true, get() { hooks++; throw Error('getter'); } });
       inner[inspect.custom] = () => { hooks++; throw Error('custom inspection'); };
       const cause = new Error('startup failed', { cause: inner });
       try {
         await traceBackendStartup('test-stage', async () => { throw cause; });
         process.exitCode = 1;
       } catch (actual) {
         console.log(JSON.stringify({ sameCause: actual === cause, hooks }));
       }`,
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout.trim())).toEqual({ sameCause: true, hooks: 0 });
  const records = result.stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as { event: string; error?: string });
  expect(records.map((record) => record.event)).toEqual(['begin', 'failed', 'end']);
  expect(records[1]?.error).toContain('asset-publication-failed');
  expect(records[1]?.error).toContain('original owner');
});
