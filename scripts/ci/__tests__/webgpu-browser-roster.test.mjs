import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { browserEntry, rosterPath, verifyBrowserVersion } from '../install-webgpu-browser.mjs';

const roster = JSON.parse(readFileSync(rosterPath, 'utf8'));
test('every declared role resolves to an immutable official CfT archive', () => {
  for (const id of ['stable', 'reference', 'legacy']) {
    const entry = browserEntry(roster, id);
    assert.equal(new URL(entry.url).hostname, 'storage.googleapis.com');
    assert.match(entry.url, new RegExp(`/${entry.version.replaceAll('.', '\\.')}/linux64/`));
  }
});
test('moving aliases and malformed integrity records are rejected', () => {
  assert.throws(() => browserEntry(roster, 'latest'), /Invalid/);
  assert.throws(() => browserEntry(roster, '__proto__'), /Invalid/);
  assert.throws(
    () =>
      browserEntry(
        { ...roster, browsers: { stable: { ...roster.browsers.stable, sha256: '' } } },
        'stable',
      ),
    /Invalid/,
  );
});
test('a launch from another cached browser cannot satisfy the pinned role', () => {
  const version = roster.browsers.stable.version;
  verifyBrowserVersion(`Google Chrome for Testing ${version}`, version);
  assert.throws(() => verifyBrowserVersion('Google Chrome 158.0.0.0 beta', version), /mismatch/);
});
