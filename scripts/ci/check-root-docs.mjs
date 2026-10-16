#!/usr/bin/env node
// check-root-docs.mjs — the engine repository has no tracked root docs/** files.
// Documentation owned by the engine lives beside its package or in the floating
// harness clone; this guard prevents the retired root surface from returning.

import { execFileSync } from 'node:child_process';
import process from 'node:process';

export function isRootDocsPath(value) {
  return typeof value === 'string' && (value === 'docs' || value.startsWith('docs/'));
}

/**
 * Return files that would violate the root docs policy.
 *
 * String entries represent the final tracked tree and are always forbidden.
 * API entries represent pull-request file records; a deletion is the only
 * allowed transition while the repository drains the retired directory.
 */
export function rootDocsPolicyViolations(files) {
  return (Array.isArray(files) ? files : [])
    .filter((file) => {
      const currentPath = typeof file === 'string' ? file : file?.filename;
      const previousPath =
        typeof file === 'object' && file !== null ? file.previous_filename : null;
      const touchesRootDocs = isRootDocsPath(currentPath) || isRootDocsPath(previousPath);
      if (!touchesRootDocs) return false;
      return typeof file === 'string' || file?.status !== 'removed';
    })
    .map((file) => {
      if (typeof file === 'string') return { filename: file, status: 'present' };
      return {
        filename: file?.filename ?? '<unknown>',
        previousFilename: file?.previous_filename,
        status: file?.status ?? '<unknown>',
      };
    });
}

export function trackedRootDocs(root = process.cwd()) {
  const indexTree = execFileSync('git', ['-C', root, 'write-tree'], { encoding: 'utf8' }).trim();
  const output = execFileSync(
    'git',
    ['-C', root, 'ls-tree', '-r', '--name-only', indexTree, '--', 'docs'],
    { encoding: 'utf8' },
  );
  return output
    .split(/\r?\n/)
    .map((path) => path.trim())
    .filter(Boolean);
}

export function assertNoTrackedRootDocs(root = process.cwd()) {
  const violations = rootDocsPolicyViolations(trackedRootDocs(root));
  if (violations.length > 0) {
    const files = violations.map((file) => file.filename).join(', ');
    throw new Error(`root docs are forbidden; remove tracked docs/** files: ${files}`);
  }
  return violations;
}

function main() {
  try {
    assertNoTrackedRootDocs();
    console.log('[ok] root-docs-policy: no tracked docs/** files');
  } catch (error) {
    console.error(`[reason] root-docs-forbidden: ${error.message ?? error}`);
    console.error(
      '[hint] keep engine documentation in package-local READMEs or the floating harness clone',
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
