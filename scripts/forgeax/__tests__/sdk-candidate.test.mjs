import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { sealCandidate, validateCandidate } from '../sdk-candidate.mjs';

const execFileAsync = promisify(execFile);
const temporaryRoots = [];

async function createArchive(root, name, version) {
  const packageRoot = join(root, `${name}-package`, 'package');
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, 'package.json'),
    `${JSON.stringify({ name, version, files: ['package.json'] })}\n`,
  );
  const archive = join(root, `${name.replaceAll('/', '-').replace(/^@/, '')}-${version}.tgz`);
  await execFileAsync('tar', ['-czf', archive, '-C', join(root, `${name}-package`), 'package']);
  return archive;
}

async function createFixture(version = '1.2.3') {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-candidate-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'npm', 'packages'), { recursive: true });
  await writeFile(
    join(root, 'sdk-build-result.json'),
    `${JSON.stringify({
      ok: true,
      sdkVersion: version,
      engineCommit: 'a'.repeat(40),
      viewCommit: 'b'.repeat(40),
    })}\n`,
  );
  const engineArchive = await createArchive(
    join(root, 'npm', 'packages'),
    '@forgeax/engine',
    version,
  );
  await createArchive(join(root, 'npm'), '@forgeax/engine-sdk', version);
  const sdkArchive = join(root, `forgeax-sdk-v${version}.zip`);
  await writeFile(sdkArchive, 'sealed SDK archive bytes');
  await createArchive(join(root, 'npm', 'packages'), '@forgeax/view', version);
  const gates = [];
  for (const name of ['npm-consumer', 'archive-browser', 'reproducibility', 'collision']) {
    const path = join(root, `${name}.json`);
    await writeFile(path, `${JSON.stringify({ ok: true, status: 'passed', durationMs: 7 })}\n`);
    gates.push(`${name}=${path}`);
  }
  return { root, engineArchive, sdkArchive, gates };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('sealed SDK candidates', () => {
  it('the actual stable npm entry refuses publication without public-source admission', async () => {
    const { root, gates } = await createFixture();
    await sealCandidate({ candidateRoot: root, sourceWorkflowRunId: 12345, gateSpecs: gates });
    const env = {
      ...process.env,
      npm_config_registry: 'http://127.0.0.1:1/',
      pnpm_config_registry: 'http://127.0.0.1:1/',
    };
    for (const name of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'NODE_AUTH_TOKEN',
      'NPM_TOKEN',
      'FORGEAX_GAMES_GITHUB_TOKEN',
    ])
      delete env[name];
    await expect(
      execFileAsync(
        process.execPath,
        [
          join(import.meta.dirname, '../publish-sdk-npm.mjs'),
          '--version',
          '1.2.3',
          '--candidate',
          root,
        ],
        { env, timeout: 10000 },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining('mirror-preflight-proof-required'),
    });
  });

  it('seals and revalidates an rc candidate without branch access', async () => {
    const { root, gates } = await createFixture('1.2.4-rc.1');
    await sealCandidate({ candidateRoot: root, sourceWorkflowRunId: 12345, gateSpecs: gates });
    await expect(
      validateCandidate({ candidateRoot: root, expectedVersion: '1.2.4-rc.1' }),
    ).resolves.toMatchObject({ sdkVersion: '1.2.4-rc.1' });
  });

  it('seals and revalidates one immutable artifact set', async () => {
    const { root, gates } = await createFixture();
    const candidate = await sealCandidate({
      candidateRoot: root,
      sourceWorkflowRunId: '12345',
      gateSpecs: gates,
      now: new Date('2026-08-31T00:00:00.000Z'),
    });

    expect(candidate).toMatchObject({
      sdkVersion: '1.2.3',
      engineCommit: 'a'.repeat(40),
      viewCommit: 'b'.repeat(40),
      sourceWorkflowRunId: 12345,
    });
    expect(candidate.npmPackages.map(({ name }) => name)).toEqual([
      '@forgeax/engine',
      '@forgeax/view',
      '@forgeax/engine-sdk',
    ]);
    expect(candidate.artifacts.map(({ path }) => path)).toContain('sdk-verify-result.json');
    await expect(
      validateCandidate({ candidateRoot: root, expectedVersion: '1.2.3' }),
    ).resolves.toMatchObject({ candidateId: `1.2.3-${'a'.repeat(12)}` });
  });

  it('rejects focused package publication units before sealing', async () => {
    const { root, gates } = await createFixture();
    await createArchive(join(root, 'npm', 'packages'), '@forgeax/engine-runtime', '1.2.3');
    await expect(
      sealCandidate({ candidateRoot: root, sourceWorkflowRunId: 12345, gateSpecs: gates }),
    ).rejects.toThrow('sdk-candidate-npm-roster-foreign');
  });

  it('rejects a changed byte after sealing', async () => {
    const { root, engineArchive, gates } = await createFixture();
    await sealCandidate({ candidateRoot: root, sourceWorkflowRunId: 12345, gateSpecs: gates });
    await writeFile(engineArchive, 'tampered');

    await expect(validateCandidate({ candidateRoot: root })).rejects.toThrow(
      'sdk-candidate-artifact-mismatch',
    );
  });

  it('lets npm-only consumers omit exactly the sealed SDK archive', async () => {
    const { root, sdkArchive, gates } = await createFixture();
    await sealCandidate({ candidateRoot: root, sourceWorkflowRunId: 12345, gateSpecs: gates });
    await rm(sdkArchive);

    await expect(validateCandidate({ candidateRoot: root })).rejects.toThrow(
      'sdk-candidate-unmanifested-artifact',
    );
    await expect(
      validateCandidate({ candidateRoot: root, withoutArchive: true }),
    ).resolves.toMatchObject({ sdkVersion: '1.2.3' });
  });

  it('still requires every other sealed byte without the archive', async () => {
    const { root, engineArchive, sdkArchive, gates } = await createFixture();
    await sealCandidate({ candidateRoot: root, sourceWorkflowRunId: 12345, gateSpecs: gates });
    await rm(sdkArchive);
    await rm(engineArchive);

    await expect(validateCandidate({ candidateRoot: root, withoutArchive: true })).rejects.toThrow(
      'sdk-candidate-unmanifested-artifact',
    );
  });

  it('verifies a present archive even when npm-only validation allows its absence', async () => {
    const { root, sdkArchive, gates } = await createFixture();
    await sealCandidate({ candidateRoot: root, sourceWorkflowRunId: 12345, gateSpecs: gates });
    await writeFile(sdkArchive, 'tampered');

    await expect(validateCandidate({ candidateRoot: root, withoutArchive: true })).rejects.toThrow(
      'sdk-candidate-artifact-mismatch',
    );
  });

  it('rejects a seal that does not record the SDK archive', async () => {
    const { root, sdkArchive, gates } = await createFixture();
    await rm(sdkArchive);

    await expect(
      sealCandidate({ candidateRoot: root, sourceWorkflowRunId: 12345, gateSpecs: gates }),
    ).rejects.toThrow('sdk-candidate-archive-unmanifested');
  });

  it('rejects a changed View source pin after sealing', async () => {
    const { root, gates } = await createFixture();
    await sealCandidate({ candidateRoot: root, sourceWorkflowRunId: 12345, gateSpecs: gates });
    await writeFile(
      join(root, 'sdk-build-result.json'),
      JSON.stringify({
        ok: true,
        sdkVersion: '1.2.3',
        engineCommit: 'a'.repeat(40),
        viewCommit: 'c'.repeat(40),
      }),
    );
    await expect(validateCandidate({ candidateRoot: root })).rejects.toThrow();
  });

  it('requires all four passing gate reports', async () => {
    const { root, gates } = await createFixture();
    await expect(
      sealCandidate({
        candidateRoot: root,
        sourceWorkflowRunId: 12345,
        gateSpecs: gates.slice(0, 3),
      }),
    ).rejects.toThrow('sdk-candidate-gates-incomplete');
  });
});
