import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { waitForNpmPublications } from '../sdk-lib.mjs';

test('registry propagation beyond twenty minutes retains exact-byte admission', async () => {
  let clock = 0;
  let corrupt = false;
  const item = {
    name: '@forgeax/engine-sdk',
    version: '1.2.3',
    integrity: `sha512-${createHash('sha512').update('sealed-bytes').digest('base64')}`,
  };
  const fetchImpl = async (input) => {
    const url = String(input);
    if (clock < 26 * 60_000) return new Response(null, { status: 404 });
    if (url.endsWith('/%40forgeax%2Fengine-sdk/1.2.3'))
      return Response.json({
        dist: { integrity: item.integrity, tarball: 'https://registry.npmjs.org/fixture.tgz' },
      });
    if (url.endsWith('/%40forgeax%2Fengine-sdk'))
      return Response.json({
        versions: { [item.version]: { dist: { integrity: item.integrity } } },
      });
    if (url.endsWith('/fixture.tgz'))
      return new Response(corrupt ? 'different-bytes' : 'sealed-bytes');
    throw new Error('unexpected publication probe');
  };
  const options = {
    fetchImpl,
    now: () => clock,
    intervalMs: 60_000,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  await assert.rejects(
    waitForNpmPublications([item], { ...options, timeoutMs: 20 * 60_000 }),
    /npm-publication-not-visible/,
  );
  clock = 0;
  assert.deepEqual(await waitForNpmPublications([item], options), { verified: 1, tag: undefined });
  assert.equal(clock, 26 * 60_000);
  clock = 0;
  corrupt = true;
  await assert.rejects(
    waitForNpmPublications([item], options),
    /npm-publication-not-visible|integrity/,
  );
  assert.ok(clock <= 30 * 60_000);
});
