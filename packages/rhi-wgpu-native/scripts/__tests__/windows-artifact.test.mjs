import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { filename, inspectWindowsBinary, packArtifact, releaseFlags, sourceInputs, verifyArtifact } from '../windows-artifact.mjs';

function binary(normal = ['kernel32.dll', 'node.exe'], delayed = []) {
  const bytes = Buffer.alloc(2048);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(64, 0x3c);
  bytes.writeUInt32LE(0x4550, 64);
  bytes.writeUInt16LE(0x8664, 68);
  bytes.writeUInt16LE(1, 70);
  bytes.writeUInt16LE(240, 84);
  const optional = 88;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(16, optional + 108);
  const section = optional + 240;
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(1536, section + 16);
  bytes.writeUInt32LE(512, section + 20);
  for (const [names, directory, stride, offset, nameOffset] of [[normal, 1, 20, 512, 12], [delayed, 13, 32, 1024, 4]]) {
    if (!names.length) continue;
    bytes.writeUInt32LE(0x1000 + offset - 512, optional + 112 + directory * 8);
    bytes.writeUInt32LE((names.length + 1) * stride, optional + 116 + directory * 8);
    names.forEach((name, index) => {
      if (directory === 13) bytes.writeUInt32LE(1, offset + index * stride);
      const nameFileOffset = offset + 256 + index * 64;
      bytes.writeUInt32LE(0x1000 + nameFileOffset - 512, offset + index * stride + nameOffset);
      bytes.write(name + '\0', nameFileOffset, 'ascii');
    });
  }
  return bytes;
}

test('PE admission reads normal and delayed imports and rejects workstation-only DLLs', () => {
  assert.deepEqual(inspectWindowsBinary(binary(['KERNEL32.dll'], ['DXGI.dll'])), ['dxgi.dll', 'kernel32.dll']);
  assert.deepEqual(inspectWindowsBinary(binary(['BCryptPrimitives.dll'])), ['bcryptprimitives.dll']);
  assert.deepEqual(inspectWindowsBinary(binary(['COMCTL32.dll'])), ['comctl32.dll']);
  assert.deepEqual(inspectWindowsBinary(binary(['OPENGL32.dll'])), ['opengl32.dll']);
  assert.throws(() => inspectWindowsBinary(binary(['dxcompiler.dll'])), /unbundled-imports:dxcompiler.dll/);
  assert.throws(() => inspectWindowsBinary(binary([], ['vcruntime140.dll'])), /unbundled-imports:vcruntime140.dll/);
});

test('PE admission rejects other architectures, truncated tables and invalid RVAs', () => {
  const bytes = binary();
  bytes.writeUInt16LE(0xaa64, 68);
  assert.throws(() => inspectWindowsBinary(bytes), /invalid-pe/);
  assert.throws(() => inspectWindowsBinary(binary().subarray(0, 100)), /invalid-pe/);
  const corrupted = binary();
  corrupted.writeUInt32LE(0xffffffff, 524);
  assert.throws(() => inspectWindowsBinary(corrupted), /invalid-pe/);
});

test('artifact admission checks source, ABI, path, file bytes and actual imports', () => {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-native-artifact-'));
  try {
    const bytes = binary();
    const inputs = { wgpuCommit: 'a'.repeat(40), files: { 'node/Cargo.toml': 'b'.repeat(64) } };
    const manifest = {
      schemaVersion: 1, platform: 'win32', architecture: 'x64', nodeApi: 8,
      target: 'x86_64-pc-windows-msvc', rustFlags: releaseFlags, engineCommit: 'c'.repeat(40),
      sourceInputs: inputs, filename, sha256: createHash('sha256').update(bytes).digest('hex'),
      imports: inspectWindowsBinary(bytes),
    };
    writeFileSync(join(directory, filename), bytes);
    const write = (value) => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(value));
    write(manifest);
    assert.deepEqual(verifyArtifact(directory, inputs), manifest);
    for (const patch of [{ nodeApi: 9 }, { filename: '../escape.node' }, { rustFlags: '-C target-cpu=native' }, { target: 'aarch64-pc-windows-msvc' }]) {
      write({ ...manifest, ...patch });
      assert.throws(() => verifyArtifact(directory, inputs), /contract-mismatch/);
    }
    write({ ...manifest, imports: [] });
    assert.throws(() => verifyArtifact(directory, inputs), /import-mismatch/);
    write(manifest);
    assert.throws(() => verifyArtifact(directory, { ...inputs, wgpuCommit: 'd'.repeat(40) }), /contract-mismatch/);
    bytes[2047] ^= 1;
    writeFileSync(join(directory, filename), bytes);
    assert.throws(() => verifyArtifact(directory, inputs), /digest-mismatch/);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('producer refuses host-specific CPU flags before reading any binary', () => {
  const previous = process.env.RUSTFLAGS;
  process.env.RUSTFLAGS = '-C target-cpu=native';
  try { assert.throws(() => packArtifact('unused'), /portable-producer-required/); }
  finally {
    if (previous === undefined) delete process.env.RUSTFLAGS;
    else process.env.RUSTFLAGS = previous;
  }
});

test('source identity binds the actual pinned wgpu and the Node/Rust transport closure', () => {
  const inputs = sourceInputs();
  assert.match(inputs.wgpuCommit, /^[a-f0-9]{40}$/);
  assert.ok(inputs.files['node/Cargo.lock']);
  assert.ok(inputs.files['node/src/lib.rs']);
  assert.ok(inputs.files['src/binding.ts']);
  assert.ok(inputs.files['scripts/windows-artifact.mjs']);
});
