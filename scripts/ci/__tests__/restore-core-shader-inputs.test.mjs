import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  sharedShaderInputFingerprint,
  sharedShaderReceipt,
} from '../../lib/shared-build-cache.mjs';
import { coreBaseShaderDirectory, restoreCoreBaseShader } from '../restore-core-shader-inputs.mjs';

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-core-base-admission-'));
  const root = join(directory, 'consumer');
  const extracted = join(directory, 'archive');
  const write = (path, value) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, value);
  };
  write(join(root, 'package.json'), '{"type":"module"}');
  write(join(root, 'pnpm-lock.yaml'), 'fixture');
  for (const [owner, manifest] of Object.entries({
    compiler: { name: '@fixture/compiler' },
    'vfx-render': { name: '@forgeax/engine-vfx-render' },
    'vite-plugin-shader': {
      name: '@forgeax/engine-vite-plugin-shader',
      dependencies: { '@fixture/compiler': 'workspace:*' },
    },
  }))
    write(join(root, 'packages', owner, 'package.json'), JSON.stringify(manifest));
  write(join(root, 'packages/compiler/dist/index.js'), 'compiler');
  write(join(root, 'packages/shader/src/surface.wgsl'), 'source');
  write(join(root, 'packages/wgpu-wasm/pkg/compiler.wasm'), 'naga');
  for (const file of [
    'scripts/build-shared-inputs.mjs',
    'scripts/lib/shader-source-budget.mjs',
    'scripts/lib/runner-resources.mjs',
    'scripts/ci/build-shared-app-inputs.mjs',
    'scripts/lib/shared-build-cache.mjs',
    'scripts/build-task-cache.mjs',
  ])
    write(join(root, file), file);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  write(
    join(extracted, 'engine-prerequisite-build-manifest.json'),
    JSON.stringify({ engineSha: sha }),
  );
  const shader = join(extracted, coreBaseShaderDirectory, 'shaders/manifest.json');
  write(shader, '{"completeBasePayload":true}');
  const manifest = {
    producer: 'repo-build-inputs',
    payload: { engineShaderManifest: `${coreBaseShaderDirectory}/shaders/manifest.json` },
    shaderBuild: sharedShaderReceipt(
      extracted,
      shader,
      sharedShaderInputFingerprint(root, { pointShadows: false, hdrpSsao: true }),
    ),
  };
  const receipt = join(extracted, coreBaseShaderDirectory, 'manifest.json');
  write(receipt, JSON.stringify(manifest));
  return { directory, root, extracted, manifest, receipt, shader, write };
}

test('restores the exact verified base bytes without copying other compiler or package outputs', () => {
  const f = fixture();
  try {
    f.write(
      join(f.extracted, 'packages/compiler/dist/index.js'),
      'must not replace local compiler',
    );
    const before = readFileSync(f.receipt);
    restoreCoreBaseShader(f.root, f.extracted);
    assert.deepEqual(readFileSync(join(f.root, coreBaseShaderDirectory, 'manifest.json')), before);
    assert.deepEqual(
      readFileSync(join(f.root, coreBaseShaderDirectory, 'shaders/manifest.json')),
      readFileSync(f.shader),
    );
    assert.equal(readFileSync(join(f.root, 'packages/compiler/dist/index.js'), 'utf8'), 'compiler');
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('rejects source, compiler, profile, payload and receipt drift before publishing', () => {
  for (const change of [
    (f) =>
      f.write(
        join(f.extracted, 'engine-prerequisite-build-manifest.json'),
        JSON.stringify({ engineSha: 'b'.repeat(40) }),
      ),
    (f) => f.write(join(f.root, 'packages/compiler/dist/index.js'), 'changed compiler'),
    (f) => f.write(join(f.root, 'packages/shader/src/surface.wgsl'), 'changed WGSL'),
    (f) => f.write(join(f.root, 'packages/wgpu-wasm/pkg/compiler.wasm'), 'changed naga'),
    (f) => {
      f.manifest.shaderBuild.inputFingerprint = sharedShaderInputFingerprint(f.root, {
        pointShadows: true,
        hdrpSsao: true,
      });
      f.write(f.receipt, JSON.stringify(f.manifest));
    },
    (f) => f.write(f.shader, 'corrupt payload'),
    (f) => {
      f.manifest.payload.engineShaderManifest = 'other/manifest.json';
      f.write(f.receipt, JSON.stringify(f.manifest));
    },
    (f) => f.write(f.receipt, '{}'),
    (f) => rmSync(f.receipt),
  ]) {
    const f = fixture();
    try {
      change(f);
      assert.throws(() => restoreCoreBaseShader(f.root, f.extracted));
      assert.equal(existsSync(join(f.root, coreBaseShaderDirectory)), false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  }
});

test('projected source admits BASE after its compiler rebuild with an explicit original revision', () => {
  const f = fixture();
  try {
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: f.root,
      encoding: 'utf8',
    }).trim();
    rmSync(join(f.root, '.git'), { recursive: true });
    f.write(join(f.extracted, 'packages/compiler/dist/index.js'), 'producer compiler');
    const receipt = readFileSync(f.receipt);
    const payload = readFileSync(f.shader);
    restoreCoreBaseShader(f.root, f.extracted, { sourceRevision });
    assert.deepEqual(readFileSync(join(f.root, coreBaseShaderDirectory, 'manifest.json')), receipt);
    assert.deepEqual(
      readFileSync(join(f.root, coreBaseShaderDirectory, 'shaders/manifest.json')),
      payload,
    );
    assert.equal(readFileSync(join(f.root, 'packages/compiler/dist/index.js'), 'utf8'), 'compiler');
    assert.deepEqual(readFileSync(f.receipt), receipt);
    assert.equal(existsSync(join(f.root, 'shared-build-inputs')), false);
    assert.equal(existsSync(join(f.root, '.git')), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('projected source accepts the original admitted checkout BASE without inventing an artifact receipt', () => {
  const f = fixture();
  try {
    const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: f.root,
      encoding: 'utf8',
    }).trim();
    execFileSync('git', ['init', '--quiet'], { cwd: f.extracted });
    execFileSync('git', ['fetch', '--quiet', f.root, 'HEAD'], { cwd: f.extracted });
    execFileSync('git', ['update-ref', 'HEAD', sourceRevision], { cwd: f.extracted });
    rmSync(join(f.extracted, 'engine-prerequisite-build-manifest.json'));
    rmSync(join(f.root, '.git'), { recursive: true });
    restoreCoreBaseShader(f.root, f.extracted, { sourceRevision });
    assert.deepEqual(
      readFileSync(join(f.root, coreBaseShaderDirectory, 'manifest.json')),
      readFileSync(f.receipt),
    );
    assert.equal(existsSync(join(f.extracted, 'engine-prerequisite-build-manifest.json')), false);
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

test('explicit revision cannot replace either checkout HEAD or an existing producer receipt', () => {
  for (const drift of ['consumer-head', 'input-head', 'input-receipt']) {
    const f = fixture();
    try {
      const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: f.root,
        encoding: 'utf8',
      }).trim();
      if (drift === 'consumer-head') {
        assert.throws(
          () =>
            restoreCoreBaseShader(f.root, f.extracted, {
              sourceRevision: 'b'.repeat(40),
            }),
          /differs from checkout HEAD/,
        );
      } else {
        execFileSync('git', ['init', '--quiet'], { cwd: f.extracted });
        execFileSync('git', ['fetch', '--quiet', f.root, 'HEAD'], { cwd: f.extracted });
        execFileSync('git', ['update-ref', 'HEAD', sourceRevision], { cwd: f.extracted });
        const sha = drift === 'input-receipt' ? 'b'.repeat(40) : sourceRevision;
        writeFileSync(
          join(f.extracted, 'engine-prerequisite-build-manifest.json'),
          JSON.stringify({ engineSha: sha }),
        );
        if (drift === 'input-head') {
          execFileSync(
            'git',
            [
              '-c',
              'user.name=Fixture',
              '-c',
              'user.email=fixture@example.invalid',
              'commit',
              '--allow-empty',
              '-qm',
              'drift',
            ],
            { cwd: f.extracted },
          );
        }
        rmSync(join(f.root, '.git'), { recursive: true });
        assert.throws(
          () => restoreCoreBaseShader(f.root, f.extracted, { sourceRevision }),
          /source revision differs from input checkout HEAD/,
        );
      }
      assert.equal(existsSync(join(f.root, coreBaseShaderDirectory)), false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  }
});

test('projected source rejects revision, rebuilt compiler, profile and payload drift before restoring BASE', () => {
  for (const change of [
    (f) => {
      f.sourceRevision = 'b'.repeat(40);
    },
    (f) => {
      f.sourceRevision = 'invalid';
    },
    (f) => f.write(join(f.root, 'packages/compiler/dist/index.js'), 'new compiler'),
    (f) => f.write(join(f.root, 'packages/shader/src/surface.wgsl'), 'new source'),
    (f) => {
      f.manifest.shaderBuild.inputFingerprint = sharedShaderInputFingerprint(f.root, {
        pointShadows: true,
        hdrpSsao: true,
      });
      f.write(f.receipt, JSON.stringify(f.manifest));
    },
    (f) => f.write(f.shader, 'changed payload'),
    (f) => {
      f.manifest.payload.engineShaderManifest = 'other/manifest.json';
      f.write(f.receipt, JSON.stringify(f.manifest));
    },
  ]) {
    const f = fixture();
    try {
      f.sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: f.root,
        encoding: 'utf8',
      }).trim();
      rmSync(join(f.root, '.git'), { recursive: true });
      change(f);
      assert.throws(() =>
        restoreCoreBaseShader(f.root, f.extracted, {
          sourceRevision: f.sourceRevision,
        }),
      );
      assert.equal(existsSync(join(f.root, coreBaseShaderDirectory)), false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  }
});
