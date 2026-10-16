#!/usr/bin/env node

import { readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const defaultPackagesRoot = path.resolve(repositoryRoot, 'packages');

const VIOLATION_ERROR = {
  code: 'engine-prefixed-package-directories',
  expected: 'no direct packages child directory starts with engine-',
  hint: 'Rename the listed directories, update repository paths and both lockfiles, then rerun pnpm run check:package-directory-names.',
};

const UNAVAILABLE_ERROR = {
  code: 'package-directory-check-unavailable',
  expected: 'packages root exists and is readable as a directory',
  hint: 'Restore the packages root or pass --packages-root to a readable directory, then rerun pnpm run check:package-directory-names.',
};

function readPackagesRootArgument(argv) {
  const optionIndex = argv.indexOf('--packages-root');
  if (optionIndex < 0) return defaultPackagesRoot;
  const optionValue = argv[optionIndex + 1];
  if (!optionValue || optionValue.startsWith('--')) {
    throw new Error('--packages-root requires a directory path');
  }
  return path.resolve(process.cwd(), optionValue);
}

function repositoryPath(packagesRoot, entryName) {
  return path
    .relative(path.dirname(packagesRoot), path.join(packagesRoot, entryName))
    .split(path.sep)
    .join('/');
}

function writeReport(report, exitCode) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = exitCode;
}

function run() {
  let packagesRoot;
  try {
    packagesRoot = readPackagesRootArgument(process.argv.slice(2));
  } catch (error) {
    writeReport(
      {
        ok: false,
        error: {
          ...UNAVAILABLE_ERROR,
          detail: {
            checkedRoot: defaultPackagesRoot,
            reason: error instanceof Error ? error.message : String(error),
          },
        },
      },
      2,
    );
    return;
  }

  let entries;
  try {
    entries = readdirSync(packagesRoot, { withFileTypes: true });
  } catch (error) {
    writeReport(
      {
        ok: false,
        error: {
          ...UNAVAILABLE_ERROR,
          detail: {
            checkedRoot: packagesRoot,
            reason: error instanceof Error ? error.message : String(error),
          },
        },
      },
      2,
    );
    return;
  }

  const violations = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('engine-'))
    .map((entry) => repositoryPath(packagesRoot, entry.name))
    .sort();

  if (violations.length > 0) {
    writeReport(
      {
        ok: false,
        error: {
          ...VIOLATION_ERROR,
          detail: { checkedRoot: packagesRoot, violations },
        },
      },
      1,
    );
    return;
  }

  writeReport({ ok: true, checkedRoot: packagesRoot, violations: [] }, 0);
}

run();
