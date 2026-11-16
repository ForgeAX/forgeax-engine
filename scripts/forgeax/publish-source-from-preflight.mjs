import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { repositoryProducerDigest } from './export-repository.mjs';
import { releasePolicy } from './release-policy.mjs';
import {
  assertMirrorPreflight,
  mirrorApi,
  publishExport,
  verifyExportFiles,
} from './repository-mirror.mjs';

const execFile = promisify(execFileCallback);
const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const output = value('--output');
const candidateRoot = value('--candidate');
const preflightPath = value('--preflight-proof');
const version = value('--version');
const source = value('--source-sha');
if (!output || !candidateRoot || !preflightPath || !version || !source) {
  throw new Error(
    'usage: publish-source-from-preflight.mjs --output <verified-export> --candidate <sealed-candidate> --preflight-proof <proof.json> --version <version> --source-sha <sha>',
  );
}
if (releasePolicy(version).mirror === null || !/^[0-9a-f]{40}$/.test(source)) {
  throw new Error('mirror-channel-source-required');
}
const candidateManifest = await readFile(resolve(candidateRoot, 'sdk-candidate.json'));
const candidate = JSON.parse(candidateManifest);
const candidateSha256 = createHash('sha256').update(candidateManifest).digest('hex');
if (
  candidate.origin !== 'local' ||
  candidate.sdkVersion !== version ||
  candidate.engineCommit !== source
) {
  throw new Error('mirror-candidate-source-mismatch');
}
const preflight = JSON.parse(await readFile(preflightPath, 'utf8'));
assertMirrorPreflight(preflight, {
  candidateSha256,
  source,
  version,
  producerSha256: await repositoryProducerDigest(),
});
const exported = await verifyExportFiles(resolve(output), preflight.manifestSha256);
assert.equal(exported.manifest.release?.version, version, 'mirror-export-version-mismatch');
assert.equal(
  exported.manifest.release?.candidateSha256,
  candidateSha256,
  'mirror-export-candidate-mismatch',
);
assert.equal(
  exported.manifest.sources.find((entry) => entry.root === '.')?.commit,
  source,
  'mirror-export-source-mismatch',
);
const { stdout } = await execFile('git', ['write-tree'], { cwd: resolve(output) });
assert.equal(stdout.trim(), preflight.tree, 'mirror-preflight-tree-mismatch');
const publication = await publishExport(
  resolve(output),
  { manifestSha256: preflight.manifestSha256, tree: preflight.tree },
  { api: mirrorApi() },
);
process.stdout.write(
  `${JSON.stringify({
    ok: true,
    version,
    source,
    candidateSha256,
    manifestSha256: preflight.manifestSha256,
    tree: preflight.tree,
    publication,
  })}\n`,
);
