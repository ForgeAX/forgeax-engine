import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const repoRoot = resolve(import.meta.dirname, '../../..');
const script = resolve(repoRoot, 'scripts/ci/setup-emscripten-no-xz.py');
const archivePreparationScript = resolve(
  repoRoot,
  'scripts/ci/prepare-emscripten-no-xz-archive.py',
);
const lockPath = resolve(repoRoot, 'scripts/ci/emscripten-no-xz.lock.json');
const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
const expectedReleaseHash = '004876f1984e18a9eb0736c5ca417ac86d386fb8';
const expectedReleaseIdentity = `releases-${expectedReleaseHash}-64bit`;
const expectedArchiveUrl = `https://storage.googleapis.com/webassembly/emscripten-releases-builds/linux/${expectedReleaseHash}/wasm-binaries.tar.xz`;
const expectedArchiveSha256 =
  'sha256:d574428df9ecf00790e28636bdc47027432737c31621b18cdb418123afda4ac1';
const expectedToolchainLayout = {
  installRoot: 'install/emscripten',
  toolBinRelativePath: 'install/bin',
  binaryenRootRelativePath: 'install',
  emscriptenCacheRelativePath: 'install/emscripten/cache',
  compilerRelativePath: 'emcc',
  releaseMarkerRelativePath: '.forgeax/release.json',
};

function runHelper(args, options = {}) {
  const result = spawnSync(pythonCommand, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...options.env },
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  let json = null;
  try {
    json = output ? JSON.parse(output) : null;
  } catch {
    json = null;
  }
  return {
    status: result.status,
    json,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function withLock(mutator, callback) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-lock-'));
  const path = join(root, 'lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  mutator(lock);
  writeFileSync(path, `${JSON.stringify(lock)}\n`);
  try {
    return callback(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('lock binds the authoritative Linux archive URL and digest', () => {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  assert.equal(lock.archiveUrl, expectedArchiveUrl);
  assert.equal(lock.archiveSha256, expectedArchiveSha256);
  assert.equal(lock.archiveContentLength, 290630564);
  assert.equal(
    lock.emsdkManifestUrl,
    'https://raw.githubusercontent.com/emscripten-core/emsdk/6.0.2/emsdk_manifest.json',
  );
  assert.equal(
    lock.emscriptenReleasesTagsUrl,
    'https://raw.githubusercontent.com/emscripten-core/emsdk/6.0.2/emscripten-releases-tags.json',
  );
  assert.deepEqual(lock.toolchainLayout, expectedToolchainLayout);
});

test('rejects archive source or digest drift in the repository lock', () => {
  const cases = [
    [
      'archive-url-mismatch',
      (lock) => {
        lock.archiveUrl = `${expectedArchiveUrl}.mirror`;
      },
    ],
    [
      'archive-digest-invalid',
      (lock) => {
        lock.archiveSha256 = 'sha256:stale';
      },
    ],
    [
      'missing-toolchain-layout',
      (lock) => {
        delete lock.toolchainLayout;
      },
    ],
    [
      'invalid-toolchain-layout',
      (lock) => {
        lock.toolchainLayout.installRoot = '../emscripten';
      },
    ],
  ];
  for (const [reason, mutator] of cases) {
    const result = withLock(mutator, (path) =>
      runHelper(['--version', '6.0.2', '--resolve-identity', '--lock', path]),
    );
    assertStructuredRejection(result, reason);
  }
});

function withJson(value, callback) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-contract-'));
  const path = join(root, 'contract.json');
  writeFileSync(path, `${JSON.stringify(value)}\n`);
  try {
    return callback(path);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function systemNodePath() {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const commandPath = execFileSync(lookup, ['node'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
  return realpathSync(commandPath);
}

function writeArchive(archivePath, entries) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-archive-spec-'));
  const specPath = join(root, 'entries.json');
  const scriptText = `
import io
import json
import sys
import tarfile

spec = json.load(open(sys.argv[1], encoding='utf-8'))
with tarfile.open(sys.argv[2], 'w:xz') as archive:
    for entry in spec:
        info = tarfile.TarInfo(entry['name'])
        kind = entry.get('kind', 'file')
        if kind == 'file':
            data = entry.get('data', '').encode('utf-8')
            info.size = len(data)
            info.mode = entry.get('mode', 0o644)
            archive.addfile(info, io.BytesIO(data))
        elif kind == 'dir':
            info.type = tarfile.DIRTYPE
            archive.addfile(info)
        elif kind == 'symlink':
            info.type = tarfile.SYMTYPE
            info.linkname = entry['linkname']
            archive.addfile(info)
        elif kind == 'hardlink':
            info.type = tarfile.LNKTYPE
            info.linkname = entry['linkname']
            archive.addfile(info)
        elif kind == 'fifo':
            info.type = tarfile.FIFOTYPE
            archive.addfile(info)
        elif kind == 'char-device':
            info.type = tarfile.CHRTYPE
            info.devmajor = 1
            info.devminor = 3
            archive.addfile(info)
        else:
            raise ValueError(kind)
`;
  writeFileSync(specPath, JSON.stringify(entries));
  try {
    execFileSync(pythonCommand, ['-c', scriptText, specPath, archivePath], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runBootstrap(args, options = {}) {
  return runHelper(args, options);
}

function runArchivePreparation(args) {
  const result = spawnSync(pythonCommand, [archivePreparationScript, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const output = `${result.stdout ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  return {
    status: result.status,
    json: output ? JSON.parse(output) : null,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assertStructuredRejection(result, reason) {
  assert.notEqual(result.status, 0, reason);
  assert.equal(result.json.status, 'rejected', reason);
  assert.equal(result.json.reason, reason, reason);
  for (const field of ['stage', 'expected', 'observed', 'hint']) {
    assert.ok(result.json[field] !== undefined && result.json[field] !== '', `${reason}: ${field}`);
  }
}

test('archive preparation validates the lock and writes the pinned digest environment value', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-archive-prep-'));
  const envPath = join(root, 'github.env');
  try {
    const result = runArchivePreparation([
      '--lock',
      lockPath,
      '--archive',
      join(root, 'release.tar.xz'),
      '--github-env',
      envPath,
      '--validate-only',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.status, 'ready');
    assert.equal(result.json.archiveSha256, expectedArchiveSha256);
    assert.equal(result.json.archiveContentLength, 290630564);
    assert.equal(
      readFileSync(envPath, 'utf8'),
      `EMSCRIPTEN_NO_XZ_ARCHIVE_SHA256=${expectedArchiveSha256}\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('archive preparation rejects lock URL, digest, and content-length drift', () => {
  const cases = [
    ['archive-url-mismatch', (lock) => (lock.archiveUrl = `${expectedArchiveUrl}.mirror`)],
    ['archive-digest-invalid', (lock) => (lock.archiveSha256 = 'sha256:stale')],
    ['archive-length-invalid', (lock) => (lock.archiveContentLength = 0)],
  ];
  for (const [reason, mutator] of cases) {
    const result = withLock(mutator, (path) =>
      runArchivePreparation([
        '--lock',
        path,
        '--archive',
        join(tmpdir(), 'unused-release.tar.xz'),
        '--validate-only',
      ]),
    );
    assertStructuredRejection(result, reason);
  }
});

test('archive preparation verifies a local archive before it can be consumed', () => {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-archive-verify-'));
  const archivePath = join(root, 'release.tar.xz');
  const content = Buffer.from('locked archive fixture');
  writeFileSync(archivePath, content);
  try {
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const result = withLock(
      (lock) => {
        lock.archiveSha256 = digest;
        lock.archiveContentLength = content.length;
      },
      (path) => runArchivePreparation(['--lock', path, '--archive', archivePath, '--verify-only']),
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.sha256, digest);
    assert.equal(result.json.contentLength, content.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function withArchiveCase(entries, callback) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-unsafe-archive-'));
  const archivePath = join(root, 'release.tar.xz');
  const cacheDir = join(root, 'cache');
  const stagingDir = join(root, 'staging');
  const completeMarker = join(cacheDir, 'complete.json');
  const releaseMarker = join(cacheDir, expectedToolchainLayout.releaseMarkerRelativePath);
  const outsideDir = join(root, 'outside');
  const sentinelPath = join(outsideDir, 'sentinel.txt');
  mkdirSync(outsideDir);
  writeFileSync(sentinelPath, 'untouched');
  writeArchive(archivePath, entries);
  const fakeBin = join(root, 'fake-bin');
  const xzCallMarker = join(root, 'xz-called');
  mkdirSync(fakeBin);
  for (const command of ['xz', 'unxz', 'tar']) {
    const fakePath = join(fakeBin, command);
    writeFileSync(fakePath, `#!/bin/sh\nprintf called > ${xzCallMarker}\nexit 99\n`);
    chmodSync(fakePath, 0o755);
  }
  const pythonCommandPath = execFileSync(
    process.platform === 'win32' ? 'where' : 'which',
    [pythonCommand],
    { encoding: 'utf8' },
  )
    .trim()
    .split(/\r?\n/)[0];
  const pythonPath = realpathSync(pythonCommandPath);
  const env = {
    PATH: `${fakeBin}:${resolve(process.execPath, '..')}:${resolve(pythonCommandPath, '..')}:${resolve(pythonPath, '..')}`,
    FORGEAX_TEST_DISABLE_XZ: '0',
  };
  try {
    callback({
      root,
      archivePath,
      cacheDir,
      stagingDir,
      completeMarker,
      releaseMarker,
      sentinelPath,
      xzCallMarker,
      env,
    });
  } finally {
    assert.equal(readFileSync(sentinelPath, 'utf8'), 'untouched');
    assert.equal(existsSync(completeMarker), false);
    assert.equal(existsSync(xzCallMarker), false);
    assert.equal(existsSync(stagingDir), false);
    rmSync(root, { recursive: true, force: true });
  }
}

function archiveArgs(paths) {
  return [
    '--version',
    '6.0.2',
    '--lock',
    lockPath,
    '--archive',
    paths.archivePath,
    '--cache-dir',
    paths.cacheDir,
    '--staging-dir',
    paths.stagingDir,
    '--complete-marker',
    paths.completeMarker,
  ];
}

function archiveDigest(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
}

function metadataArgs(paths, metadataPath, digest) {
  return [...archiveArgs(paths), '--release-metadata', metadataPath, '--archive-sha256', digest];
}

function cacheFingerprint() {
  return runHelper(['--version', '6.0.2', '--resolve-identity', '--lock', lockPath]).json
    .compilerFingerprint;
}

function withCacheCase(marker, callback) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-emscripten-cache-'));
  const cacheDir = join(root, 'cache');
  const completeMarker = join(cacheDir, 'complete.json');
  const releaseMarker = join(cacheDir, expectedToolchainLayout.releaseMarkerRelativePath);
  const readyMarker = join(root, 'consumer-ready');
  mkdirSync(join(cacheDir, expectedToolchainLayout.installRoot), { recursive: true });
  writeFileSync(join(cacheDir, expectedToolchainLayout.installRoot, 'emcc'), 'compiler');
  mkdirSync(join(cacheDir, '.forgeax'), { recursive: true });
  writeFileSync(
    releaseMarker,
    JSON.stringify({
      releaseIdentity: expectedReleaseIdentity,
      installRoot: expectedToolchainLayout.installRoot,
      toolBinRelativePath: expectedToolchainLayout.toolBinRelativePath,
      binaryenRootRelativePath: expectedToolchainLayout.binaryenRootRelativePath,
      emscriptenCacheRelativePath: expectedToolchainLayout.emscriptenCacheRelativePath,
      compilerRelativePath: expectedToolchainLayout.compilerRelativePath,
    }),
  );
  if (marker !== null) {
    writeFileSync(completeMarker, `${JSON.stringify(marker)}\n`);
  }
  try {
    callback({ root, cacheDir, completeMarker, releaseMarker, readyMarker });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cacheArgs(paths) {
  return [
    '--version',
    '6.0.2',
    '--lock',
    lockPath,
    '--validate-cache',
    '--cache-dir',
    paths.cacheDir,
    '--complete-marker',
    paths.completeMarker,
  ];
}

function readyCacheArgs(paths) {
  return [...cacheArgs(paths), '--ready-marker', paths.readyMarker];
}

test('resolves the fixed Linux Emscripten release identity', () => {
  const result = runHelper(['--version', '6.0.2', '--resolve-identity', '--lock', lockPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.status, 'ready');
  assert.equal(result.json.compilerFingerprint.emscriptenVersion, '6.0.2');
  assert.equal(result.json.compilerFingerprint.releaseIdentity, expectedReleaseIdentity);
  assert.equal(result.json.compilerFingerprint.releaseHash, expectedReleaseHash);
  assert.equal(result.json.compilerFingerprint.runnerOs, 'Linux');
  assert.equal(result.json.compilerFingerprint.runnerArch, 'x86_64');
  assert.deepEqual(result.json.toolchainLayout, expectedToolchainLayout);
  assert.match(result.json.compilerFingerprint.bootstrapInputDigest, /^sha256:[a-f0-9]{64}$/);
});

test('rejects an Emscripten version drift', () => {
  const result = runHelper(['--version', '6.0.1', '--resolve-identity', '--lock', lockPath]);
  assert.notEqual(result.status, 0);
  assert.equal(result.json.reason, 'version-mismatch');
  assert.equal(result.json.expected.emscriptenVersion, '6.0.2');
  assert.equal(result.json.observed.emscriptenVersion, '6.0.1');
});

test('rejects the SDK alias instead of the direct release tool', () => {
  const result = withLock(
    (lock) => {
      lock.releaseIdentity = `sdk-${expectedReleaseIdentity}`;
    },
    (path) => runHelper(['--version', '6.0.2', '--resolve-identity', '--lock', path]),
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.json.reason, 'release-identity-mismatch');
  assert.equal(result.json.expected.releaseIdentity, expectedReleaseIdentity);
  assert.equal(result.json.observed.releaseIdentity, `sdk-${expectedReleaseIdentity}`);
});

test('rejects a missing release identity', () => {
  const result = withLock(
    (lock) => {
      delete lock.releaseIdentity;
    },
    (path) => runHelper(['--version', '6.0.2', '--resolve-identity', '--lock', path]),
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.json.reason, 'missing-release-identity');
  assert.equal(result.json.expected.releaseIdentity, expectedReleaseIdentity);
});

test('observes the system Node four-tuple', () => {
  const result = runHelper(['--version', '6.0.2', '--resolve-identity', '--lock', lockPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.json.nodeAuthority.nodeExpectedVersion, '22.22.3');
  assert.equal(result.json.nodeAuthority.nodeVersion, process.versions.node);
  assert.equal(result.json.nodeAuthority.nodePath, systemNodePath());
  assert.equal(result.json.nodeAuthority.emsdkNode, result.json.nodeAuthority.nodePath);
});

test('accepts a matching Node authority contract', () => {
  const nodePath = systemNodePath();
  const result = withJson(
    {
      nodeExpectedVersion: '22.22.3',
      nodeVersion: 'v22.22.3',
      nodePath,
      emsdkNode: nodePath,
      bundledNodePaths: [],
    },
    (path) => runHelper(['--validate-node-json', path]),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.json.nodeAuthority, {
    nodeExpectedVersion: '22.22.3',
    nodeVersion: '22.22.3',
    nodePath,
    emsdkNode: nodePath,
  });
});

test('rejects Node version, node path, and EMSDK_NODE mismatches', () => {
  const nodePath = systemNodePath();
  const cases = [
    ['version-mismatch', { nodeVersion: 'v21.0.0' }],
    ['node-path-mismatch', { nodePath: '/tmp/other-node' }],
    ['emsdk-node-mismatch', { emsdkNode: '/tmp/other-node' }],
  ];
  for (const [reason, changes] of cases) {
    const result = withJson(
      {
        nodeExpectedVersion: '22.22.3',
        nodeVersion: 'v22.22.3',
        nodePath,
        emsdkNode: nodePath,
        bundledNodePaths: [],
        ...changes,
      },
      (path) => runHelper(['--validate-node-json', path]),
    );
    assert.notEqual(result.status, 0, reason);
    assert.equal(result.json.reason, reason);
    assert.equal(result.json.stage, 'node-authority');
    assert.ok(result.json.hint);
  }
});

test('rejects missing Node authority fields', () => {
  const nodePath = systemNodePath();
  for (const field of ['nodeExpectedVersion', 'nodeVersion', 'nodePath', 'emsdkNode']) {
    const contract = {
      nodeExpectedVersion: '22.22.3',
      nodeVersion: 'v22.22.3',
      nodePath,
      emsdkNode: nodePath,
      bundledNodePaths: [],
    };
    delete contract[field];
    const result = withJson(contract, (path) => runHelper(['--validate-node-json', path]));
    assert.notEqual(result.status, 0, field);
    assert.equal(result.json.reason, 'missing-node-field');
    assert.equal(result.json.observed.field, field);
  }
});

test('rejects an emsdk bundled Node path', () => {
  const result = withJson(
    {
      nodeExpectedVersion: '22.22.3',
      nodeVersion: 'v22.22.3',
      nodePath: '/opt/node/bin/node',
      emsdkNode: '/tmp/emsdk-main/node/22.22.3_64bit/bin/node',
      bundledNodePaths: ['/tmp/emsdk-main/node/22.22.3_64bit/bin/node'],
    },
    (path) => runHelper(['--validate-node-json', path]),
  );
  assert.notEqual(result.status, 0);
  assert.equal(result.json.reason, 'bundled-node');
  assert.equal(result.json.stage, 'node-authority');
});

test('rejects an archive when Python lzma is unavailable', () => {
  withArchiveCase([{ name: 'install/emscripten/emcc', data: 'compiler' }], (paths) => {
    const result = runBootstrap(archiveArgs(paths), {
      env: { ...paths.env, FORGEAX_TEST_DISABLE_LZMA: '1' },
    });
    assertStructuredRejection(result, 'lzma-missing');
  });
});

test('rejects absolute and POSIX or Windows traversal members', () => {
  const cases = [
    ['archive-member-unsafe', [{ name: '/outside.txt', data: 'escape' }]],
    ['archive-member-unsafe', [{ name: '../outside.txt', data: 'escape' }]],
    ['archive-member-unsafe', [{ name: 'C:\\\\outside.txt', data: 'escape' }]],
    ['archive-member-unsafe', [{ name: 'dir\\\\..\\\\outside.txt', data: 'escape' }]],
  ];
  for (const [reason, entries] of cases) {
    withArchiveCase(entries, (paths) => {
      assertStructuredRejection(runBootstrap(archiveArgs(paths), { env: paths.env }), reason);
    });
  }
});

test('rejects symlink and hardlink members that escape the staging root', () => {
  const cases = [
    [{ name: 'emsdk/link', kind: 'symlink', linkname: '../../outside.txt' }],
    [{ name: 'emsdk/link', kind: 'hardlink', linkname: '../../outside.txt' }],
    [
      {
        name: 'install/emscripten/node_modules/.bin/link',
        kind: 'symlink',
        linkname: '../../../../../outside.txt',
      },
    ],
  ];
  for (const entries of cases) {
    withArchiveCase(entries, (paths) => {
      assertStructuredRejection(
        runBootstrap(archiveArgs(paths), { env: paths.env }),
        'archive-link-unsafe',
      );
    });
  }
});

test('accepts a contained relative symlink and preserves its linkname', () => {
  withArchiveCase(
    [
      { name: 'install/emscripten/node_modules/google-closure-compiler/cli.js', data: 'compiler' },
      {
        name: 'install/emscripten/node_modules/.bin/google-closure-compiler',
        kind: 'symlink',
        linkname: '../google-closure-compiler/cli.js',
      },
    ],
    (paths) => {
      const result = runBootstrap(archiveArgs(paths), { env: paths.env });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json.status, 'ready');
      assert.equal(
        readlinkSync(
          join(paths.cacheDir, 'install/emscripten/node_modules/.bin/google-closure-compiler'),
        ),
        '../google-closure-compiler/cli.js',
      );
      rmSync(paths.completeMarker, { force: true });
    },
  );
});

test('preserves executable regular-file bits without unsafe special bits', () => {
  withArchiveCase(
    [
      {
        name: 'install/emscripten/emcc',
        data: '#!/bin/sh\nprintf emcc-ready\n',
        mode: 0o4755,
      },
      { name: 'install/emscripten/emscripten-version.txt', data: '6.0.2' },
    ],
    (paths) => {
      const metadataPath = join(paths.root, 'release.json');
      writeFileSync(metadataPath, JSON.stringify({ releaseIdentity: expectedReleaseIdentity }));
      const result = runBootstrap(
        metadataArgs(paths, metadataPath, archiveDigest(paths.archivePath)),
        { env: paths.env },
      );
      assert.equal(result.status, 0, result.stderr);
      const compilerPath = join(paths.cacheDir, 'install/emscripten/emcc');
      const mode = statSync(compilerPath).mode & 0o7777;
      assert.equal(mode & 0o777, 0o755);
      assert.equal(mode & 0o7000, 0);
      assert.equal(statSync(compilerPath).mode & 0o111, 0o111);
      assert.equal(spawnSync(compilerPath, { encoding: 'utf8' }).stdout, 'emcc-ready');
      rmSync(paths.completeMarker, { force: true });
    },
  );
});

test('rejects device and FIFO members', () => {
  for (const entries of [
    [{ name: 'emsdk/device', kind: 'char-device' }],
    [{ name: 'emsdk/fifo', kind: 'fifo' }],
  ]) {
    withArchiveCase(entries, (paths) => {
      assertStructuredRejection(
        runBootstrap(archiveArgs(paths), { env: paths.env }),
        'archive-special-file',
      );
    });
  }
});

test('rejects duplicate members before writing the target', () => {
  withArchiveCase(
    [
      { name: 'emsdk/duplicate', data: 'first' },
      { name: 'emsdk/duplicate', data: 'second' },
    ],
    (paths) => {
      assertStructuredRejection(
        runBootstrap(archiveArgs(paths), { env: paths.env }),
        'archive-duplicate-member',
      );
    },
  );
});

test('rejects file and directory collisions before writing the target', () => {
  withArchiveCase(
    [
      { name: 'emsdk/collision', data: 'file' },
      { name: 'emsdk/collision/child', data: 'child' },
    ],
    (paths) => {
      assertStructuredRejection(
        runBootstrap(archiveArgs(paths), { env: paths.env }),
        'archive-member-collision',
      );
    },
  );
});

test('rejects a missing release metadata file before installation', () => {
  withArchiveCase([{ name: 'install/emscripten/emcc', data: 'compiler' }], (paths) => {
    const missingMetadata = join(paths.root, 'missing-release.json');
    const result = runBootstrap(
      metadataArgs(paths, missingMetadata, archiveDigest(paths.archivePath)),
      { env: paths.env },
    );
    assertStructuredRejection(result, 'release-metadata-missing');
  });
});

test('rejects release metadata with a mismatched identity', () => {
  withArchiveCase([{ name: 'install/emscripten/emcc', data: 'compiler' }], (paths) => {
    const metadataPath = join(paths.root, 'release.json');
    writeFileSync(
      metadataPath,
      JSON.stringify({
        releaseIdentity: 'releases-stale-64bit',
        archiveSha256: archiveDigest(paths.archivePath),
      }),
    );
    const result = runBootstrap(
      metadataArgs(paths, metadataPath, archiveDigest(paths.archivePath)),
      { env: paths.env },
    );
    assertStructuredRejection(result, 'release-identity-mismatch');
  });
});

test('rejects an archive digest mismatch before installation', () => {
  withArchiveCase([{ name: 'install/emscripten/emcc', data: 'compiler' }], (paths) => {
    const metadataPath = join(paths.root, 'release.json');
    writeFileSync(
      metadataPath,
      JSON.stringify({ releaseIdentity: expectedReleaseIdentity, archiveSha256: 'sha256:stale' }),
    );
    const result = runBootstrap(metadataArgs(paths, metadataPath, 'sha256:stale'), {
      env: paths.env,
    });
    assertStructuredRejection(result, 'archive-digest-mismatch');
  });
});

test('accepts an archive with release metadata and an explicit digest', () => {
  withArchiveCase(
    [
      { name: 'install/emscripten/emcc', data: 'compiler' },
      { name: 'install/emscripten/emscripten-version.txt', data: '6.0.2' },
    ],
    (paths) => {
      const metadataPath = join(paths.root, 'release.json');
      const githubEnv = join(paths.root, 'github.env');
      const githubPath = join(paths.root, 'github.path');
      writeFileSync(metadataPath, JSON.stringify({ releaseIdentity: expectedReleaseIdentity }));
      const result = runBootstrap(
        [
          ...metadataArgs(paths, metadataPath, archiveDigest(paths.archivePath)),
          '--github-env',
          githubEnv,
          '--github-path',
          githubPath,
        ],
        { env: paths.env },
      );
      try {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.json.status, 'ready');
        assert.equal(result.json.cacheStatus, 'cold-created');
        assert.equal(result.json.noXz.pythonLzma, 'stdlib');
        assert.deepEqual(result.json.toolchainLayout, expectedToolchainLayout);
        assert.equal(
          readFileSync(join(paths.cacheDir, expectedToolchainLayout.installRoot, 'emcc'), 'utf8'),
          'compiler',
        );
        assert.deepEqual(JSON.parse(readFileSync(paths.releaseMarker, 'utf8')), {
          schemaVersion: 1,
          releaseIdentity: expectedReleaseIdentity,
          installRoot: expectedToolchainLayout.installRoot,
          toolBinRelativePath: expectedToolchainLayout.toolBinRelativePath,
          binaryenRootRelativePath: expectedToolchainLayout.binaryenRootRelativePath,
          emscriptenCacheRelativePath: expectedToolchainLayout.emscriptenCacheRelativePath,
          compilerRelativePath: expectedToolchainLayout.compilerRelativePath,
        });
        const activatedCache = realpathSync(paths.cacheDir);
        const configPath = join(activatedCache, 'forgeax-emscripten-config.py');
        const environment = readFileSync(githubEnv, 'utf8');
        assert.match(environment, new RegExp(`^EM_CONFIG=${configPath}$`, 'm'));
        assert.match(
          environment,
          new RegExp(`^EMSCRIPTEN=${join(activatedCache, 'install/emscripten')}$`, 'm'),
        );
        assert.match(
          environment,
          new RegExp(`^EMSDK_NODE=${result.json.nodeAuthority.emsdkNode}$`, 'm'),
        );
        assert.equal(
          readFileSync(githubPath, 'utf8'),
          `${join(activatedCache, 'install/emscripten')}\n${join(activatedCache, 'install/bin')}\n`,
        );
        assert.match(readFileSync(configPath, 'utf8'), /^LLVM_ROOT = /m);
      } finally {
        rmSync(paths.completeMarker, { force: true });
      }
    },
  );
});

test('accepts only an exact complete cache with the expected fingerprint', () => {
  const fingerprint = cacheFingerprint();
  withCacheCase({ complete: true, compilerFingerprint: fingerprint }, (paths) => {
    const result = runHelper(cacheArgs(paths));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.status, 'ready');
    assert.equal(result.json.cacheStatus, 'exact-valid');
    assert.equal(result.json.noXz.pythonLzma, 'stdlib');
    assert.equal(result.json.cacheKey, result.json.expectedCacheKey);
    assert.equal(result.json.nodeAuthority.nodeExpectedVersion, '22.22.3');
    assert.ok(result.json.nodeAuthority.nodePath);
    assert.equal(result.json.nodeAuthority.nodePath, result.json.nodeAuthority.emsdkNode);
    assert.equal(
      result.json.nodeAuthorityStatus,
      process.platform === 'linux' ? 'ready' : 'version-mismatch',
    );
    assert.deepEqual(result.json.bundledNodePaths, []);
    assert.equal(result.json.bundledNodeExcluded, true);
    assert.deepEqual(result.json.toolchainLayout, expectedToolchainLayout);
  });
});

for (const state of ['exact', 'partial', 'fingerprint-drift']) {
  test(`archive fallback admits an existing cache only when exact: ${state}`, () => {
    const fingerprint = cacheFingerprint();
    const marker = {
      complete: state !== 'partial',
      compilerFingerprint:
        state === 'fingerprint-drift'
          ? { ...fingerprint, bootstrapInputDigest: 'stale' }
          : fingerprint,
    };
    withCacheCase(marker, (paths) => {
      const archivePath = join(paths.root, 'release.tar.xz');
      const metadataPath = join(paths.root, 'release.json');
      writeArchive(archivePath, [
        { name: 'install/emscripten/emcc', data: 'rebuilt-compiler' },
        { name: 'install/emscripten/emscripten-version.txt', data: '6.0.2' },
      ]);
      writeFileSync(metadataPath, JSON.stringify({ releaseIdentity: expectedReleaseIdentity }));
      const result = runBootstrap(
        metadataArgs(
          { ...paths, archivePath, stagingDir: join(paths.root, 'staging') },
          metadataPath,
          archiveDigest(archivePath),
        ),
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal(result.json.cacheStatus, state === 'exact' ? 'exact-valid' : 'cold-created');
      assert.equal(
        readFileSync(join(paths.cacheDir, expectedToolchainLayout.installRoot, 'emcc'), 'utf8'),
        state === 'exact' ? 'compiler' : 'rebuilt-compiler',
      );
      const admitted = runHelper(cacheArgs(paths));
      assert.equal(admitted.status, 0, admitted.stderr);
      assert.equal(admitted.json.cacheStatus, 'exact-valid');
      assert.deepEqual(admitted.json.compilerFingerprint, fingerprint);
    });
  });
}

test('rejects partial, missing, and invalid compiler caches', () => {
  const fingerprint = cacheFingerprint();
  const cases = [
    ['partial', { complete: false, compilerFingerprint: fingerprint }],
    ['miss', null],
    [
      'invalid',
      { complete: true, compilerFingerprint: { ...fingerprint, releaseIdentity: 'stale' } },
    ],
  ];
  for (const [label, marker] of cases) {
    withCacheCase(marker, (paths) => {
      const result = runHelper(cacheArgs(paths));
      assert.notEqual(result.status, 0, label);
      assert.equal(result.json.status, 'rejected', label);
      assert.ok(
        ['partial', 'cache-miss', 'fingerprint-mismatch'].includes(result.json.reason),
        label,
      );
      for (const field of ['stage', 'expected', 'observed', 'hint']) {
        assert.ok(
          result.json[field] !== undefined && result.json[field] !== '',
          `${label}: ${field}`,
        );
      }
    });
  }
});

test('rejects a cache service failure as a valid compiler cache', () => {
  const fingerprint = cacheFingerprint();
  withCacheCase({ complete: true, compilerFingerprint: fingerprint }, (paths) => {
    const result = runHelper(cacheArgs(paths), {
      env: { FORGEAX_TEST_CACHE_SERVICE_FAILURE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.status, 'ready');
    assert.equal(result.json.cacheStatus, 'service-unavailable-cold');
    assert.notEqual(result.json.cacheStatus, 'exact-valid');
  });
});

test('rejects cache mutations across all five fingerprint dimensions', () => {
  const fingerprint = cacheFingerprint();
  for (const field of [
    'emscriptenVersion',
    'releaseIdentity',
    'runnerOs',
    'runnerArch',
    'bootstrapInputDigest',
  ]) {
    const mutated = { ...fingerprint, [field]: `${fingerprint[field]}-mutated` };
    withCacheCase({ complete: true, compilerFingerprint: mutated }, (paths) => {
      const result = runHelper(cacheArgs(paths));
      assert.notEqual(result.status, 0, field);
      assert.equal(result.json.reason, 'fingerprint-mismatch', field);
      assert.equal(result.json.expected[field], fingerprint[field], field);
      assert.equal(result.json.observed[field], mutated[field], field);
    });
  }
});

test('requires a complete marker, release marker, and compiler file before ready', () => {
  const fingerprint = cacheFingerprint();
  const cases = [
    ['missing-complete-marker', (paths) => rmSync(paths.completeMarker, { force: true })],
    [
      'missing-compiler',
      (paths) =>
        rmSync(join(paths.cacheDir, expectedToolchainLayout.installRoot, 'emcc'), { force: true }),
    ],
    ['truncated-release-file', (paths) => writeFileSync(paths.releaseMarker, '')],
    ['missing-release-marker', (paths) => rmSync(paths.releaseMarker, { force: true })],
  ];
  for (const [reason, mutate] of cases) {
    withCacheCase({ complete: true, compilerFingerprint: fingerprint }, (paths) => {
      mutate(paths);
      const result = runHelper(readyCacheArgs(paths));
      assert.notEqual(result.status, 0, reason);
      assert.equal(result.json.status, 'rejected', reason);
      assert.ok(
        result.json.reason.includes(reason.split('-')[1]) || result.json.reason === 'partial',
        reason,
      );
      assert.equal(existsSync(paths.readyMarker), false, reason);
      for (const field of ['stage', 'expected', 'observed', 'hint']) {
        assert.ok(
          result.json[field] !== undefined && result.json[field] !== '',
          `${reason}: ${field}`,
        );
      }
    });
  }
});

test('does not consume an atomic publication intermediate state', () => {
  const fingerprint = cacheFingerprint();
  withCacheCase(null, (paths) => {
    writeFileSync(
      join(paths.cacheDir, 'complete.json.tmp'),
      JSON.stringify({ complete: true, compilerFingerprint: fingerprint }),
    );
    const result = runHelper(readyCacheArgs(paths));
    assert.notEqual(result.status, 0);
    assert.equal(result.json.status, 'rejected');
    assert.ok(['cache-miss', 'partial'].includes(result.json.reason));
    assert.equal(existsSync(paths.readyMarker), false);
  });
});

test('publishes the consumer ready barrier only for an exact cache', () => {
  const fingerprint = cacheFingerprint();
  withCacheCase({ complete: true, compilerFingerprint: fingerprint }, (paths) => {
    const result = runHelper(readyCacheArgs(paths));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.status, 'ready');
    assert.equal(result.json.cacheStatus, 'exact-valid');
    assert.equal(existsSync(paths.readyMarker), true);
  });
});
