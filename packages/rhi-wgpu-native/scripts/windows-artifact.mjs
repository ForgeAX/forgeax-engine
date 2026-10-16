import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const filename = 'forgeax-rhi-wgpu-native.win32-x64.node';
export const releaseFlags = '-C target-cpu=x86-64 -C target-feature=+crt-static --remap-path-prefix=C:\\=/forgeax/c --remap-path-prefix=D:\\=/forgeax/d';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const systemImports = new Set([
  'advapi32.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'cfgmgr32.dll', 'combase.dll', 'comctl32.dll', 'crypt32.dll',
  'd3d12.dll', 'd3dcompiler_47.dll', 'dbghelp.dll', 'dcomp.dll', 'dwmapi.dll',
  'dxcore.dll', 'dxgi.dll', 'gdi32.dll', 'imm32.dll', 'kernel32.dll', 'kernelbase.dll',
  'msvcrt.dll', 'ntdll.dll', 'ole32.dll', 'oleaut32.dll', 'opengl32.dll', 'rpcrt4.dll', 'secur32.dll', 'setupapi.dll',
  'shell32.dll', 'shlwapi.dll', 'user32.dll', 'userenv.dll', 'version.dll',
  'ucrtbase.dll', 'winhttp.dll', 'winmm.dll', 'wintrust.dll', 'ws2_32.dll', 'node.exe',
]);

// Inspect normal and delay-load PE imports. A static DXC/CRT release must have
// no unbundled private DLL, even if the build machine could load one from PATH.
export function inspectWindowsBinary(bytes) {
  const fail = () => { throw new Error('native-artifact-invalid-pe'); };
  const fits = (offset, count) => Number.isInteger(offset) && offset >= 0 && offset + count <= bytes.length;
  if (!fits(0, 64) || bytes.readUInt16LE(0) !== 0x5a4d) fail();
  const pe = bytes.readUInt32LE(0x3c);
  if (!fits(pe, 24) || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664) fail();
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20);
  if (optionalSize < 240 || !fits(optional, optionalSize) || bytes.readUInt16LE(optional) !== 0x20b) fail();
  const sectionTable = optional + optionalSize;
  const sections = bytes.readUInt16LE(pe + 6);
  if (!fits(sectionTable, sections * 40) || bytes.readUInt32LE(optional + 108) < 14) fail();
  const atRva = (rva, count) => {
    for (let index = 0; index < sections; index++) {
      const section = sectionTable + index * 40;
      const start = bytes.readUInt32LE(section + 12);
      const size = bytes.readUInt32LE(section + 16);
      const offset = bytes.readUInt32LE(section + 20) + rva - start;
      if (rva >= start && rva + count <= start + size && fits(offset, count)) return offset;
    }
    fail();
  };
  const nameAt = (rva) => {
    let name = '';
    for (let index = 0; index < 256; index++) {
      const value = bytes[atRva(rva + index, 1)];
      if (value === 0) {
        if (!/^[a-z0-9_.-]+\.(dll|exe)$/.test(name)) fail();
        return name;
      }
      name += String.fromCharCode(value).toLowerCase();
    }
    fail();
  };
  const imports = new Set();
  for (const [directory, stride, nameOffset] of [[1, 20, 12], [13, 32, 4]]) {
    const rva = bytes.readUInt32LE(optional + 112 + directory * 8);
    const size = bytes.readUInt32LE(optional + 116 + directory * 8);
    if (!rva && !size) continue;
    if (!rva || size < stride) fail();
    let terminated = false;
    for (let index = 0; index + stride <= size; index += stride) {
      const offset = atRva(rva + index, stride);
      if (bytes.subarray(offset, offset + stride).every((value) => value === 0)) {
        terminated = true;
        break;
      }
      if (directory === 13 && bytes.readUInt32LE(offset) !== 1) fail();
      imports.add(nameAt(bytes.readUInt32LE(offset + nameOffset)));
    }
    if (!terminated) fail();
  }
  const names = [...imports].sort();
  const privateDlls = names.filter((name) => !systemImports.has(name) && !/^(api|ext)-ms-win-[a-z0-9-]+\.dll$/.test(name));
  if (privateDlls.length) throw new Error(`native-artifact-unbundled-imports:${privateDlls.join(',')}`);
  return names;
}

export function sourceInputs(root = packageRoot) {
  const files = ['node/Cargo.toml', 'node/Cargo.lock', 'node/build.rs', 'scripts/build-native-addon.mjs', 'scripts/windows-artifact.mjs'];
  const walk = (directory, extension) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && entry.name !== '__tests__') walk(path, extension);
      else if (entry.isFile() && path.endsWith(extension)) files.push(path);
    }
  };
  walk('node/src', '.rs');
  walk('src', '.ts');
  const git = (args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('native-artifact-source-unavailable');
    return result.stdout.trim();
  };
  const wgpuRoot = resolve(root, '../../third_party/wgpu');
  const wgpuCommit = git(['-C', wgpuRoot, 'rev-parse', 'HEAD']);
  const gitlink = git(['-C', resolve(root, '../..'), 'ls-tree', 'HEAD', 'third_party/wgpu']);
  if (!gitlink.includes(`160000 commit ${wgpuCommit}\t`) || git(['-C', wgpuRoot, 'status', '--porcelain', '--untracked-files=no']))
    throw new Error('native-artifact-wgpu-source-mismatch');
  // Git checkouts on different hosts may materialize LF or CRLF. Source identity
  // canonicalizes text line endings; distributed binary hashes always use bytes.
  return { wgpuCommit, files: Object.fromEntries(files.sort().map((path) => [path, digest(readFileSync(join(root, path), 'utf8').replaceAll('\r\n', '\n'))])) };
}

export function verifyArtifact(directory, inputs) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || manifest.platform !== 'win32' || manifest.architecture !== 'x64' ||
      manifest.nodeApi !== 8 || manifest.filename !== filename || manifest.rustFlags !== releaseFlags ||
      manifest.target !== 'x86_64-pc-windows-msvc' || !/^[a-f0-9]{40}$/.test(manifest.engineCommit) ||
      JSON.stringify(manifest.sourceInputs) !== JSON.stringify(inputs))
    throw new Error('native-artifact-contract-mismatch');
  const binary = readFileSync(join(directory, filename));
  if (digest(binary) !== manifest.sha256) throw new Error('native-artifact-digest-mismatch');
  if (JSON.stringify(inspectWindowsBinary(binary)) !== JSON.stringify(manifest.imports))
    throw new Error('native-artifact-import-mismatch');
  return manifest;
}

export function packArtifact(directory, root = packageRoot) {
  if (process.platform !== 'win32' || process.arch !== 'x64' ||
      process.env.RUSTFLAGS !== releaseFlags || process.env.CARGO_ENCODED_RUSTFLAGS)
    throw new Error('native-artifact-portable-producer-required');
  const binary = readFileSync(join(root, 'native', filename));
  const commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error('native-artifact-source-unavailable');
  const manifest = {
    schemaVersion: 1, platform: 'win32', architecture: 'x64', nodeApi: 8,
    target: 'x86_64-pc-windows-msvc', rustFlags: releaseFlags, engineCommit: commit.stdout.trim(),
    sourceInputs: sourceInputs(root), filename, sha256: digest(binary), imports: inspectWindowsBinary(binary),
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, filename), binary);
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return verifyArtifact(directory, manifest.sourceInputs);
}

export function installArtifact(directory, root = packageRoot) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || Number(process.versions.napi) < 8)
    throw new Error('native-artifact-platform-unavailable');
  const manifest = verifyArtifact(directory, sourceInputs(root));
  const destination = join(root, 'native');
  mkdirSync(destination, { recursive: true });
  const temporary = join(destination, `${filename}.new-${process.pid}`);
  copyFileSync(join(directory, filename), temporary);
  renameSync(temporary, join(destination, filename));
  writeFileSync(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [operation, directory] = process.argv.slice(2);
  if (!directory || !['pack', 'install'].includes(operation)) throw new Error('usage: windows-artifact.mjs pack|install <directory>');
  console.log(JSON.stringify(operation === 'pack' ? packArtifact(resolve(directory)) : installArtifact(resolve(directory))));
}
