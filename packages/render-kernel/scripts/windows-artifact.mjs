#!/usr/bin/env node
// Portable Windows x64 PE import audit and artifact packer for forgeax-render-kernel.win32-x64.node.
// Mirrors packages/rhi-wgpu-native/scripts/windows-artifact.mjs: guarantees zero unbundled private
// DLL dependencies when built with static CRT + static-dxc.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
export const filename = 'forgeax-render-kernel.win32-x64.node';
export const releaseFlags =
  '-C target-cpu=x86-64 -C target-feature=+crt-static --remap-path-prefix=C:\\=/forgeax/c --remap-path-prefix=D:\\=/forgeax/d';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

const systemImports = new Set([
  'advapi32.dll', 'bcrypt.dll', 'bcryptprimitives.dll', 'cfgmgr32.dll', 'combase.dll', 'comctl32.dll',
  'crypt32.dll', 'd3d12.dll', 'd3dcompiler_47.dll', 'dbghelp.dll', 'dcomp.dll', 'dwmapi.dll',
  'dxcore.dll', 'dxgi.dll', 'gdi32.dll', 'imm32.dll', 'kernel32.dll', 'kernelbase.dll',
  'msvcrt.dll', 'ntdll.dll', 'ole32.dll', 'oleaut32.dll', 'opengl32.dll', 'rpcrt4.dll',
  'secur32.dll', 'setupapi.dll', 'shell32.dll', 'shlwapi.dll', 'user32.dll', 'userenv.dll',
  'version.dll', 'ucrtbase.dll', 'uxtheme.dll', 'winhttp.dll', 'winmm.dll', 'wintrust.dll',
  'ws2_32.dll', 'xinput1_4.dll', 'node.exe',
]);

function readPeImportDirectory(bytes, optional, atRva, nameAt, imports, fail) {
  for (const [directory, stride, nameOffset] of [
    [1, 20, 12],
    [13, 32, 4],
  ]) {
    const rva = bytes.readUInt32LE(optional + 112 + directory * 8);
    const size = bytes.readUInt32LE(optional + 116 + directory * 8);
    if (!rva && !size) continue;
    if (!rva || size < stride) fail();
    let terminated = false;
    for (let index = 0; index + stride <= size; index += stride) {
      const offset = atRva(rva + index, stride);
      if (bytes.subarray(offset, offset + stride).every((v) => v === 0)) {
        terminated = true;
        break;
      }
      if (directory === 13 && bytes.readUInt32LE(offset) !== 1) fail();
      imports.add(nameAt(bytes.readUInt32LE(offset + nameOffset)));
    }
    if (!terminated) fail();
  }
}

export function inspectWindowsBinary(bytes) {
  const fail = () => {
    throw new Error('render-kernel-artifact-invalid-pe');
  };
  const fits = (offset, count) =>
    Number.isInteger(offset) && offset >= 0 && offset + count <= bytes.length;
  if (!fits(0, 64) || bytes.readUInt16LE(0) !== 0x5a4d) fail();
  const pe = bytes.readUInt32LE(0x3c);
  if (!fits(pe, 24) || bytes.readUInt32LE(pe) !== 0x4550 || bytes.readUInt16LE(pe + 4) !== 0x8664)
    fail();
  const optional = pe + 24;
  const optionalSize = bytes.readUInt16LE(pe + 20);
  if (optionalSize < 240 || !fits(optional, optionalSize) || bytes.readUInt16LE(optional) !== 0x20b)
    fail();
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
  readPeImportDirectory(bytes, optional, atRva, nameAt, imports, fail);
  const names = [...imports].sort();
  const privateDlls = names.filter(
    (name) => !systemImports.has(name) && !/^(api|ext)-ms-win-[a-z0-9-]+\.dll$/.test(name),
  );
  if (privateDlls.length) {
    throw new Error(`render-kernel-artifact-unbundled-imports:${privateDlls.join(',')}`);
  }
  return names;
}

export function packArtifact(directory, root = packageRoot) {
  const source = join(root, 'native', filename);
  const binary = readFileSync(source);
  const imports = inspectWindowsBinary(binary);
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : 'unknown';
  };
  const manifest = {
    schemaVersion: 1,
    platform: 'win32',
    architecture: 'x64',
    nodeApi: 8,
    filename,
    target: 'x86_64-pc-windows-msvc',
    rustFlags: process.env.RUSTFLAGS ?? releaseFlags,
    engineCommit: process.env.GITHUB_SHA ?? git(['rev-parse', 'HEAD']),
    sha256: digest(binary),
    bytes: binary.length,
    imports,
  };
  mkdirSync(directory, { recursive: true });
  copyFileSync(source, join(directory, filename));
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, directory] = process.argv.slice(2);
  if (command === 'pack' && directory) {
    console.log(JSON.stringify(packArtifact(resolve(directory)), null, 2));
  } else {
    console.error('usage: windows-artifact.mjs pack <dir>');
    process.exitCode = 1;
  }
}
