#!/usr/bin/env node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import process from 'node:process';

const FORBIDDEN = [
  /shared-components/i,
  /(?:RuntimeShim|WrapperGeneric)/,
  /@forgeax\/engine-runtime\/internal/,
];
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);
const SKIP = new Set(['node_modules', '.git', 'dist', '.forgeax-harness', 'report']);

function walk(root, dir = root, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(root, path, out);
    else if (EXTENSIONS.has(path.slice(path.lastIndexOf('.')))) out.push(path);
  }
  return out;
}

export function compatibilityFindings(rootDirectory) {
  const root = resolve(rootDirectory);
  const findings = [];
  for (const file of walk(root)) {
    if (
      file.endsWith('/scripts/check-runtime-compat.mjs') ||
      file.endsWith('/scripts/__tests__/check-runtime-compat.unit.test.ts')
    )
      continue;
    const text = readFileSync(file, 'utf8');
    for (const pattern of FORBIDDEN) {
      const match = text.match(pattern);
      if (match)
        findings.push({ file: relative(root, file), pattern: pattern.source, match: match[0] });
    }
  }
  return findings;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex >= 0 ? process.argv[rootIndex + 1] : process.cwd();
  const findings = compatibilityFindings(root);
  if (findings.length) {
    process.stderr.write(`[fail] compatibility obligations found: ${findings.length}\n`);
    for (const finding of findings) process.stderr.write(`- ${finding.file}: ${finding.match}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      '[ok] no shared-component, wrapper-generic, or compatibility shim findings\n',
    );
  }
}
