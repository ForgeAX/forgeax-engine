#!/usr/bin/env node
// Verify pnpm-workspace.yaml#packages and package.json#workspaces describe the same
// glob set (K-5 dual-write SSOT). Exits 1 with a diff on stderr if they diverge.
// pre-commit hook (t1.14) and CI (t1.18) both invoke this. ≤ 50 LOC, no npm deps.
// w4: also export getEquivalentWorkspaces() so the drift detector (w9) reuses
// this SSOT (K-9 + architecture principle #2 Derive, Don't Duplicate).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function getEquivalentWorkspaces() {
  const root = process.cwd();
  const pkgJson = JSON.parse(readFileSync(`${root}/package.json`, 'utf8'));
  const pkgWs = pkgJson.workspaces;
  if (!Array.isArray(pkgWs)) {
    process.stderr.write('package.json#workspaces missing or not an array.\n');
    process.exit(1);
  }
  // Minimal yaml parser for top-level `packages:` block of pnpm-workspace.yaml.
  const yaml = readFileSync(`${root}/pnpm-workspace.yaml`, 'utf8');
  const lines = yaml.split(/\r?\n/);
  const yamlGlobs = [];
  let inPackages = false;
  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trimEnd();
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      if (/^\s+-\s+/.test(line)) {
        yamlGlobs.push(line.replace(/^\s+-\s+/, '').replace(/^["']|["']$/g, ''));
      } else if (line === '' || /^\s/.test(line)) {
        // blank or indented continuation: keep scanning
      } else {
        inPackages = false;
      }
    }
  }
  const a = new Set(pkgWs);
  const b = new Set(yamlGlobs);
  const onlyA = [...a].filter((x) => !b.has(x));
  const onlyB = [...b].filter((x) => !a.has(x));
  if (onlyA.length || onlyB.length) {
    process.stderr.write(
      'Workspace glob mismatch between package.json#workspaces and pnpm-workspace.yaml#packages:\n',
    );
    if (onlyA.length) process.stderr.write(`  only in package.json: ${JSON.stringify(onlyA)}\n`);
    if (onlyB.length)
      process.stderr.write(`  only in pnpm-workspace.yaml: ${JSON.stringify(onlyB)}\n`);
    process.exit(1);
  }
  return [...a].sort().flatMap((g) => expandGlob(root, g));
}

// Expand a workspace glob into resolved package directories. Supports any
// number of `*` segments (each `*` matches one filesystem level). Examples:
//   `apps/*`               -> readdir apps/, keep dirs containing package.json.
//   `apps/learn-render/*/*` -> readdir apps/learn-render/, descend each
//      first-level child, then list its children, keep dirs that contain
//      package.json. Required by D-6 (feat-20260515 plan-strategy section 2.10):
//      `apps/learn-render/*/*` registers the 7 LearnOpenGL section-1.* workspaces
//      without polluting `apps/*` (pnpm-workspace globs are not recursive,
//      research F-15).
function expandGlob(root, glob) {
  const segments = glob.split('/');
  let current = [''];
  for (const seg of segments) {
    if (seg === '*') {
      const next = [];
      for (const prefix of current) {
        const dir = prefix === '' ? root : `${root}/${prefix}`;
        let entries;
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          const childRel = prefix === '' ? name : `${prefix}/${name}`;
          if (statSync(`${root}/${childRel}`).isDirectory()) next.push(childRel);
        }
      }
      current = next;
    } else {
      current = current.map((prefix) => (prefix === '' ? seg : `${prefix}/${seg}`));
    }
  }
  return current.filter((rel) => existsSync(`${root}/${rel}/package.json`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(`workspace members: ${JSON.stringify(getEquivalentWorkspaces())}\n`);
}
