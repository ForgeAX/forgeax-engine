#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(SCRIPT_DIR, '..');
export const REPO_ROOT = resolve(PKG_ROOT, '../..');

function dirPaths(dirName = 'pkg') {
  const dir = resolve(PKG_ROOT, dirName);
  return {
    dir,
    wasmPath: resolve(dir, 'modeling_kernel.wasm'),
    provenancePath: resolve(dir, 'provenance.json'),
  };
}

function collectRustSources(dir, out) {
  for (const entry of readdirSync(dir).sort()) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      collectRustSources(full, out);
    } else if (entry.endsWith('.rs')) {
      out.push(full);
    }
  }
}

export function computeSourceSha256() {
  const files = [
    resolve(REPO_ROOT, 'crates/forgeax-modeling-kernel/Cargo.toml'),
    resolve(PKG_ROOT, 'Cargo.toml'),
    resolve(PKG_ROOT, 'build.sh'),
  ];
  collectRustSources(resolve(REPO_ROOT, 'crates/forgeax-modeling-kernel/src'), files);
  collectRustSources(resolve(PKG_ROOT, 'src'), files);
  files.sort((a, b) => relative(REPO_ROOT, a).localeCompare(relative(REPO_ROOT, b)));

  const hash = createHash('sha256');
  for (const file of files) {
    const rel = relative(REPO_ROOT, file).replaceAll('\\', '/');
    hash.update(`${rel}\0`);
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function writeProvenance(dirName = 'pkg') {
  const { wasmPath, provenancePath } = dirPaths(dirName);
  if (!existsSync(wasmPath)) {
    throw new Error(`modeling-kernel-wasm missing at ${wasmPath}`);
  }
  const bytes = readFileSync(wasmPath);
  if (!WebAssembly.validate(bytes)) {
    throw new Error(`modeling-kernel-wasm failed WebAssembly.validate: ${wasmPath}`);
  }
  const provenance = {
    schemaVersion: 1,
    sourceSha256: computeSourceSha256(),
    wasmSha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  };
  writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  return provenance;
}

export function verifyCurrent(dirName = 'pkg') {
  const { wasmPath, provenancePath } = dirPaths(dirName);
  if (!existsSync(wasmPath)) {
    throw new Error(`modeling-kernel-wasm missing: ${wasmPath}`);
  }
  if (!existsSync(provenancePath)) {
    throw new Error(`modeling-kernel-wasm provenance missing: ${provenancePath}`);
  }
  const bytes = readFileSync(wasmPath);
  if (!WebAssembly.validate(bytes)) {
    throw new Error(`modeling-kernel-wasm invalid WebAssembly binary: ${wasmPath}`);
  }
  const provenance = JSON.parse(readFileSync(provenancePath, 'utf8'));
  const expectedSource = computeSourceSha256();
  if (provenance.sourceSha256 !== expectedSource) {
    throw new Error(
      `modeling-kernel-wasm source mismatch: expected ${expectedSource}, got ${provenance.sourceSha256}`,
    );
  }
  const actualWasm = createHash('sha256').update(bytes).digest('hex');
  if (provenance.wasmSha256 !== actualWasm || provenance.bytes !== bytes.byteLength) {
    throw new Error(
      `modeling-kernel-wasm digest mismatch: expected ${provenance.wasmSha256}, got ${actualWasm}`,
    );
  }
  return provenance;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2] ?? '--verify';
  try {
    if (mode === '--source-key') {
      process.stdout.write(`${computeSourceSha256()}\n`);
    } else if (mode === '--write-provenance') {
      const p = writeProvenance('pkg');
      process.stdout.write(
        `[modeling-kernel-wasm] wrote provenance (source=${p.sourceSha256.slice(0, 12)}, bytes=${p.bytes})\n`,
      );
    } else if (mode === '--verify' || mode === '--verify-dist') {
      const p = verifyCurrent(mode === '--verify-dist' ? 'dist' : 'pkg');
      process.stdout.write(
        `[modeling-kernel-wasm] OK (${mode === '--verify-dist' ? 'dist' : 'pkg'} source=${p.sourceSha256.slice(0, 12)}, bytes=${p.bytes})\n`,
      );
    } else {
      throw new Error('usage: verify-current.mjs [--verify|--verify-dist|--source-key|--write-provenance]');
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
