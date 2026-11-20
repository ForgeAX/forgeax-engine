import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { resolveAsset } from '../../../packages/wgpu-wasm/scripts/content-key.mjs';
import {
  projectSharedShader,
  reusableSharedShader,
  sharedShaderInputFingerprint,
  sharedShaderReceipt,
} from '../../lib/shared-build-cache.mjs';
import * as coreInputs from '../restore-core-shader-inputs.mjs';
import { coreBaseShaderDirectory, restoreCoreBaseShader } from '../restore-core-shader-inputs.mjs';
import { nativeBundle, nativeFingerprint } from './fixtures/native-compiler.mjs';

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

test('restores from an original checkout and rejects a conflicting producer receipt', () => {
  const f = fixture();
  try {
    const checkout = join(f.directory, 'checkout');
    execFileSync('git', ['clone', '--quiet', f.root, checkout]);
    cpSync(join(f.extracted, coreBaseShaderDirectory), join(checkout, coreBaseShaderDirectory), {
      recursive: true,
    });
    restoreCoreBaseShader(f.root, checkout);
    assert.deepEqual(
      readFileSync(join(f.root, coreBaseShaderDirectory, 'manifest.json')),
      readFileSync(f.receipt),
    );
    f.write(
      join(checkout, 'engine-prerequisite-build-manifest.json'),
      JSON.stringify({ engineSha: 'b'.repeat(40) }),
    );
    assert.throws(
      () => restoreCoreBaseShader(f.root, checkout),
      /source revision differs from input checkout HEAD/,
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const baseDirectory of [
  'shared-app-inputs/profiles/base-ssao',
  'shared-build-inputs-release/base-ssao',
])
  test(`${baseDirectory} retains independent BASE identity after Core transfer is lost`, () => {
    const f = fixture();
    try {
      restoreCoreBaseShader(f.root, f.extracted);
      const base = join(f.root, coreBaseShaderDirectory, 'manifest.json');
      const target = join(f.root, baseDirectory);
      const fingerprint = sharedShaderInputFingerprint(f.root, {
        pointShadows: false,
        hdrpSsao: true,
      });
      projectSharedShader(f.root, base, target, fingerprint);
      rmSync(join(f.root, coreBaseShaderDirectory), { recursive: true });
      const projected = join(target, 'manifest.json');
      const payload = reusableSharedShader(f.root, projected, fingerprint);
      assert.equal(readFileSync(payload, 'utf8'), readFileSync(f.shader, 'utf8'));
      assert.equal(
        reusableSharedShader(
          f.root,
          projected,
          sharedShaderInputFingerprint(f.root, {
            pointShadows: true,
            hdrpSsao: true,
          }),
        ),
        null,
        'POINT cannot satisfy BASE or vice versa',
      );
      const projectedRoot = join(f.directory, 'compatible-consumer');
      cpSync(f.root, projectedRoot, { recursive: true });
      restoreCoreBaseShader(projectedRoot, f.root);
      assert.equal(
        readFileSync(join(projectedRoot, coreBaseShaderDirectory, 'shaders/manifest.json'), 'utf8'),
        readFileSync(f.shader, 'utf8'),
      );
      assert.ok(
        reusableSharedShader(
          projectedRoot,
          join(projectedRoot, coreBaseShaderDirectory, 'manifest.json'),
          fingerprint,
        ),
      );
      f.write(payload, 'tampered');
      assert.equal(reusableSharedShader(f.root, projected, fingerprint), null);
      assert.throws(() => projectSharedShader(f.root, projected, target, fingerprint), /rejected/);
      assert.throws(() => restoreCoreBaseShader(projectedRoot, f.root));
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });

test('Core adoption pairs BASE with exact native bytes from its admitted producer', async () => {
  const f = fixture();
  try {
    const producer = join(f.extracted, 'packages/wgpu-wasm/pkg');
    const consumer = join(f.root, 'packages/wgpu-wasm/pkg');
    await nativeBundle(f, producer, 'Core');
    rmSync(consumer, { recursive: true });
    cpSync(producer, consumer, { recursive: true });
    f.manifest.shaderBuild.inputFingerprint = sharedShaderInputFingerprint(f.root, {
      pointShadows: false,
      hdrpSsao: true,
    });
    f.write(f.receipt, JSON.stringify(f.manifest));
    await nativeBundle(f, consumer, 'independent same-source build');
    assert.throws(() => restoreCoreBaseShader(f.root, f.extracted), /identity mismatch/);
    await coreInputs.restoreCoreCompiler(f.root, f.extracted);
    restoreCoreBaseShader(f.root, f.extracted);
    assert.equal(readFileSync(join(consumer, 'wgpu_wasm.js'), 'utf8'), 'Core glue');
    assert.equal(
      readFileSync(join(f.root, 'packages/wgpu-wasm/dist/wgpu_wasm_glue.bytes'), 'utf8'),
      'Core glue',
    );
    assert.equal(readFileSync(join(f.root, 'packages/compiler/dist/index.js'), 'utf8'), 'compiler');
    assert.deepEqual(
      readFileSync(join(f.root, coreBaseShaderDirectory, 'manifest.json')),
      readFileSync(f.receipt),
    );
  } finally {
    rmSync(f.directory, { recursive: true, force: true });
  }
});

for (const drift of ['wasm', 'glue', 'source', 'revision']) {
  test(`Core native admission rejects ${drift} drift before publishing`, async () => {
    const f = fixture();
    try {
      const producer = join(f.extracted, 'packages/wgpu-wasm/pkg');
      await nativeBundle(f, producer, 'Core');
      if (drift === 'wasm') f.write(join(producer, 'wgpu_wasm_bg.wasm'), 'corrupted');
      if (drift === 'glue') f.write(join(producer, 'wgpu_wasm.js'), 'corrupted');
      if (drift === 'source') {
        const path = join(producer, 'provenance.json');
        const manifest = JSON.parse(readFileSync(path));
        manifest.sourceContentKey = `sha256-${'a'.repeat(64)}`;
        manifest.compilerFingerprint = nativeFingerprint(manifest);
        f.write(path, JSON.stringify(manifest));
      }
      if (drift === 'revision')
        f.write(
          join(f.extracted, 'engine-prerequisite-build-manifest.json'),
          JSON.stringify({ engineSha: 'b'.repeat(40) }),
        );
      await assert.rejects(coreInputs.restoreCoreCompiler(f.root, f.extracted));
      assert.equal(
        readFileSync(join(f.root, 'packages/wgpu-wasm/pkg/compiler.wasm'), 'utf8'),
        'naga',
      );
      assert.equal(existsSync(join(f.root, 'packages/wgpu-wasm/dist/wgpu_wasm_glue.bytes')), false);
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
}

for (const mutation of ['none', 'revision', 'source', 'wasm', 'glue', 'fingerprint']) {
  test(`compiler preparation retains exact producer bytes and rejects drift: ${mutation}`, async () => {
    const f = fixture();
    try {
      const { restoreCoreCompiler } = await import('../restore-core-shader-inputs.mjs');
      assert.equal(typeof restoreCoreCompiler, 'function');
      const hash = (value) => createHash('sha256').update(value).digest('hex');
      const pkg = join(f.extracted, 'packages/wgpu-wasm/pkg');
      const wasm = 'original producer wasm';
      const glue = 'original producer glue';
      const facts = {
        schemaVersion: 'wgpu-wasm-provenance/1',
        sourceContentKey:
          mutation === 'source' ? 'stale' : `sha256-${(await resolveAsset()).sha256}`,
        artifactSha256: hash(wasm),
        artifactBytes: Buffer.byteLength(wasm),
        glueSha256: hash(glue),
        glueBytes: Buffer.byteLength(glue),
        toolchain: {},
        dependencies: {},
      };
      const { artifactBytes, glueBytes, ...identity } = facts;
      facts.compilerFingerprint = `sha256-${hash(JSON.stringify(identity))}`;
      if (mutation === 'fingerprint') facts.compilerFingerprint = 'invalid';
      f.write(join(pkg, 'provenance.json'), JSON.stringify(facts));
      f.write(join(pkg, 'wgpu_wasm_bg.wasm'), mutation === 'wasm' ? 'tampered' : wasm);
      f.write(join(pkg, 'wgpu_wasm.js'), mutation === 'glue' ? 'tampered' : glue);
      if (mutation === 'none') {
        // Construct the producer's original receipt before the consumer diverges.
        rmSync(join(f.root, 'packages/wgpu-wasm/pkg'), { recursive: true });
        cpSync(pkg, join(f.root, 'packages/wgpu-wasm/pkg'), { recursive: true });
        f.manifest.shaderBuild = sharedShaderReceipt(
          f.extracted,
          f.shader,
          sharedShaderInputFingerprint(f.root, { pointShadows: false, hdrpSsao: true }),
        );
        f.write(f.receipt, JSON.stringify(f.manifest));
      }
      f.write(join(f.root, 'packages/wgpu-wasm/pkg/wgpu_wasm.js'), 'independently built glue');
      if (mutation === 'revision')
        f.write(
          join(f.extracted, 'engine-prerequisite-build-manifest.json'),
          JSON.stringify({ engineSha: 'b'.repeat(40) }),
        );
      if (mutation !== 'none') {
        await assert.rejects(restoreCoreCompiler(f.root, f.extracted));
        assert.equal(
          readFileSync(join(f.root, 'packages/wgpu-wasm/pkg/wgpu_wasm.js'), 'utf8'),
          'independently built glue',
        );
      } else {
        const receipt = readFileSync(f.receipt);
        await restoreCoreCompiler(f.root, f.extracted);
        assert.equal(
          readFileSync(join(f.root, 'packages/wgpu-wasm/pkg/wgpu_wasm.js'), 'utf8'),
          glue,
        );
        assert.equal(
          readFileSync(join(f.root, 'packages/wgpu-wasm/pkg/wgpu_wasm_bg.wasm'), 'utf8'),
          wasm,
        );
        assert.equal(
          readFileSync(join(f.root, 'packages/wgpu-wasm/dist/wgpu_wasm_glue.bytes'), 'utf8'),
          glue,
        );
        assert.deepEqual(readFileSync(f.receipt), receipt);
        assert.equal(
          readFileSync(join(f.root, 'packages/compiler/dist/index.js'), 'utf8'),
          'compiler',
        );
        assert.equal(existsSync(join(f.root, coreBaseShaderDirectory)), false);
        restoreCoreBaseShader(f.root, f.extracted);
        assert.deepEqual(
          readFileSync(join(f.root, coreBaseShaderDirectory, 'manifest.json')),
          receipt,
        );
      }
    } finally {
      rmSync(f.directory, { recursive: true, force: true });
    }
  });
}
