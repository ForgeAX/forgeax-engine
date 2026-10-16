#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

export const CODE_FILE_LINE_LIMIT = 4096;

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.wgsl',
  '.glsl',
  '.vert',
  '.frag',
  '.rs',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.py',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.rb',
  '.lua',
  '.sql',
  '.html',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.vue',
  '.svelte',
  '.go',
  '.java',
  '.kt',
  '.kts',
  '.swift',
  '.php',
]);

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function normalizePath(path) {
  return path.split('\\').join('/');
}

function splitNullSeparated(text) {
  return text === '' ? [] : text.split('\0').filter(Boolean);
}

export function countPhysicalLines(text) {
  const source =
    typeof text === 'string'
      ? text
      : text instanceof Uint8Array
        ? UTF8_DECODER.decode(text)
        : String(text);
  if (source.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    if (code === 13) {
      lines += 1;
      if (source.charCodeAt(index + 1) === 10) index += 1;
      continue;
    }
    if (code === 10) lines += 1;
  }
  const lastCode = source.charCodeAt(source.length - 1);
  if (lastCode !== 10 && lastCode !== 13) lines += 1;
  return lines;
}

export function splitPhysicalLines(text) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 13 || code === 10) {
      lines.push(text.slice(start, index));
      if (code === 13 && text.charCodeAt(index + 1) === 10) index += 1;
      start = index + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

export function isCodeFilePath(path, firstLine) {
  const lowerPath = path.toLowerCase();
  const basename = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
  const dotIndex = basename.lastIndexOf('.');
  // A leading dot is part of a dotfile name, not an extension (for example
  // `.profile` is still an extensionless shebang entry).
  const ext = dotIndex <= 0 ? '' : basename.slice(dotIndex);
  if (CODE_EXTENSIONS.has(ext)) return true;
  if (ext !== '') return false;
  if (typeof firstLine === 'string') return firstLine.startsWith('#!');
  if (firstLine instanceof Uint8Array) {
    return firstLine.length >= 2 && firstLine[0] === 35 && firstLine[1] === 33;
  }
  return false;
}

// The staged listing outgrew Node's 1 MiB default buffer (ENOBUFS) at ~10k files.
const GIT_LIST_MAX_BUFFER = 64 * 1024 * 1024;

function readTrackedEntries(root) {
  try {
    const output = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--stage', '-z'], {
      encoding: 'utf8',
      maxBuffer: GIT_LIST_MAX_BUFFER,
    });
    return splitNullSeparated(output).map((entry) => {
      const tabIndex = entry.indexOf('\t');
      if (tabIndex === -1) {
        throw new Error(`code-file-lines: malformed git ls-files entry: ${entry}`);
      }
      const meta = entry.slice(0, tabIndex);
      const path = entry.slice(tabIndex + 1);
      const [mode] = meta.split(' ');
      return { mode, path };
    });
  } catch (error) {
    throw new Error(
      `code-file-lines: unable to enumerate tracked files via git: ${String(
        error?.message ?? error,
      )}`,
    );
  }
}

function decodeText(path, bytes) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new Error(
      `code-file-lines: ${path}: invalid UTF-8 text: ${String(error?.message ?? error)}`,
    );
  }
}

export function scanCodeFileLines(root = process.cwd()) {
  const absoluteRoot = resolve(root);
  const trackedEntries = readTrackedEntries(absoluteRoot);
  const records = [];

  for (const { mode, path: relativePath } of trackedEntries) {
    const path = normalizePath(relativePath);
    if (!mode.startsWith('100')) continue;
    const absolutePath = resolve(absoluteRoot, relativePath);
    const stats = lstatSync(absolutePath, { throwIfNoEntry: false });
    if (stats === undefined || !stats.isFile()) {
      throw new Error(
        `code-file-lines: failed to read ${path}: tracked code file is missing or not a regular file`,
      );
    }

    const bytes = readFileSync(absolutePath);
    const firstLine = bytes.subarray(
      0,
      bytes.indexOf(10) === -1 ? bytes.length : bytes.indexOf(10),
    );
    if (!isCodeFilePath(path, firstLine)) continue;

    const text = decodeText(path, bytes);
    records.push({ lines: countPhysicalLines(text), path });
  }

  records.sort((left, right) => {
    if (right.lines !== left.lines) return right.lines - left.lines;
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
  return records;
}

export function collectCodeFileLineFindings({ root = process.cwd() } = {}) {
  const records = scanCodeFileLines(root);
  return {
    codeFileCount: records.length,
    findings: records.filter((record) => record.lines > CODE_FILE_LINE_LIMIT),
  };
}

export function formatCodeFileLineLimitReport(result) {
  if (result.findings.length === 0) {
    return {
      status: 0,
      stdout: `[code-file-lines] PASS files=${result.codeFileCount} max=${CODE_FILE_LINE_LIMIT}\n`,
      stderr: '',
    };
  }

  const lines = result.findings.map(
    (finding) =>
      `[code-file-lines] FAIL path=${finding.path} lines=${finding.lines} max=${CODE_FILE_LINE_LIMIT}`,
  );
  lines.push(
    `[code-file-lines] FAIL total=${result.findings.length} files=${result.codeFileCount} max=${CODE_FILE_LINE_LIMIT}`,
  );
  lines.push(
    '[code-file-lines] HINT split the owning boundary into smaller code files; there is no baseline, whitelist, or suppress path.',
  );

  return { status: 1, stdout: '', stderr: `${lines.join('\n')}\n` };
}

export function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  let root = process.cwd();
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--root') {
      const value = args.shift();
      if (!value) {
        throw new Error('code-file-lines: --root requires a path');
      }
      root = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/check-code-file-lines.mjs [--root <repo-root>]\n');
      return 0;
    }
    throw new Error(`code-file-lines: unknown argument ${arg}`);
  }

  const report = formatCodeFileLineLimitReport(collectCodeFileLineFindings({ root }));
  if (report.stdout) process.stdout.write(report.stdout);
  if (report.stderr) process.stderr.write(report.stderr);
  return report.status;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`[code-file-lines] setup error: ${String(error?.message ?? error)}\n`);
    process.exitCode = 2;
  }
}
