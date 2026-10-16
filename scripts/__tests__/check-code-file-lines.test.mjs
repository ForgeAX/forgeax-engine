import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  countPhysicalLines,
  isCodeFilePath,
  scanCodeFileLines,
} from '../check-code-file-lines.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const gatePath = resolve(repoRoot, 'scripts', 'check-code-file-lines.mjs');

function makeLines(lineCount, lineEnding) {
  if (lineCount === 0) return Buffer.alloc(0);
  const terminator = lineEnding === 'crlf' ? '\r\n' : lineEnding === 'cr' ? '\r' : '\n';
  return Buffer.from(`${`x${terminator}`.repeat(lineCount - 1)}x`, 'utf8');
}

function withGitRepo(files, callback) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-code-file-lines-'));
  try {
    const init = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
    assert.equal(init.status ?? -1, 0);
    for (const [relativePath, contents] of files) {
      const absolutePath = join(root, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, contents);
    }
    const add = spawnSync('git', ['add', '-A'], { cwd: root, encoding: 'utf8' });
    assert.equal(add.status ?? -1, 0);
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function runGate(cwd) {
  const result = spawnSync(process.execPath, [gatePath], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

describe('check-code-file-lines line counting', () => {
  it('counts physical lines across newline styles and empty files', () => {
    assert.equal(countPhysicalLines(Buffer.alloc(0)), 0);
    assert.equal(countPhysicalLines(Buffer.from('x')), 1);
    assert.equal(countPhysicalLines(Buffer.from('x\n')), 1);
    assert.equal(countPhysicalLines(Buffer.from('x\r')), 1);
    assert.equal(countPhysicalLines(Buffer.from('x\r\n')), 1);
    assert.equal(countPhysicalLines(Buffer.from('x\ny')), 2);
    assert.equal(countPhysicalLines(Buffer.from('x\ry')), 2);
    assert.equal(countPhysicalLines(Buffer.from('x\r\ny')), 2);
    assert.equal(countPhysicalLines(Buffer.from('\n\n// blank lines and comments count\n')), 3);
    assert.equal(countPhysicalLines(makeLines(4096, 'lf')), 4096);
    assert.equal(countPhysicalLines(makeLines(4096, 'crlf')), 4096);
    assert.equal(countPhysicalLines(makeLines(4096, 'cr')), 4096);
    assert.equal(countPhysicalLines(makeLines(4097, 'lf')), 4097);
    assert.equal(countPhysicalLines(makeLines(4097, 'crlf')), 4097);
    assert.equal(countPhysicalLines(makeLines(4097, 'cr')), 4097);
  });

  it('recognizes code files by suffix and shebang only', () => {
    for (const suffix of [
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
    ]) {
      assert.equal(isCodeFilePath(`src/main${suffix}`, Buffer.from('source\n')), true, suffix);
    }
    assert.equal(isCodeFilePath('scripts/run', Buffer.from('#!/usr/bin/env node\n')), true);
    assert.equal(isCodeFilePath('scripts.v1/run', Buffer.from('#!/usr/bin/env node\n')), true);
    assert.equal(isCodeFilePath('.runner', Buffer.from('#!/usr/bin/env node\n')), true);
    assert.equal(isCodeFilePath('scripts/run', Buffer.from('console.log(1);\n')), false);
    assert.equal(isCodeFilePath('docs/readme.md', Buffer.from('# docs\n')), false);
  });
});

describe('check-code-file-lines scan and CLI contract', () => {
  it('enumerates a real tracked index above the child-process default buffer', () => {
    const prefix = Array.from({ length: 3 }, (_, index) => `${index}-${'a'.repeat(228)}`).join('/');
    const files = Array.from({ length: 1500 }, (_, index) => [`${prefix}/${index}.ts`, 'x\n']);
    withGitRepo(files, (root) => {
      const inventory = spawnSync('git', ['ls-files', '--cached', '--stage', '-z'], {
        cwd: root,
        maxBuffer: 16 * 1024 * 1024,
      });
      assert.equal(inventory.status, 0);
      assert(inventory.stdout.length > 1024 * 1024);
      const result = runGate(root);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '[code-file-lines] PASS files=1500 max=4096');
    });
  });
  it('includes code files, excludes docs/config/binary files, and keeps sorted output', () => {
    withGitRepo(
      [
        ['src/b.ts', `${`x\n`.repeat(4_096 - 1)}x`],
        ['src/a.ts', `${`x\n`.repeat(4_097 - 1)}x`],
        ['src/runner', '#!/usr/bin/env node\nconsole.log("hi");\n'],
        ['docs/readme.md', '# docs\n'],
        ['config/settings.json', '{ "ok": true }\n'],
        ['package-lock.json', '{ "lockfileVersion": 3 }\n'],
        ['snapshots/output.snap', 'snapshot\n'],
        ['assets/blob.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])],
      ],
      (root) => {
        const records = scanCodeFileLines(root);
        assert.deepEqual(
          records.map((record) => record.path),
          ['src/a.ts', 'src/b.ts', 'src/runner'],
        );
        assert.deepEqual(
          records.map((record) => record.lines),
          [4_097, 4_096, 2],
        );
      },
    );
  });

  it('passes at 4096 lines and fails at 4097 lines', () => {
    withGitRepo(
      [
        ['src/pass.ts', `${`x\n`.repeat(4_095)}x`],
        ['src/fail.ts', `${`x\n`.repeat(4_096)}x`],
      ],
      (root) => {
        const result = runGate(root);
        assert.equal(result.status, 1);
        assert.ok(
          result.stderr.includes('[code-file-lines] FAIL path=src/fail.ts lines=4097 max=4096'),
        );
        assert.ok(result.stderr.includes('[code-file-lines] FAIL total=1 files=2 max=4096'));
      },
    );
  });

  it('prints a pass summary for an all-green tree', () => {
    withGitRepo(
      [
        ['src/pass.ts', `${`x\n`.repeat(4_095)}x`],
        ['src/script', '#!/usr/bin/env node\nconsole.log("ok");\n'],
      ],
      (root) => {
        const result = runGate(root);
        assert.equal(result.status, 0);
        assert.equal(result.stdout.trim(), '[code-file-lines] PASS files=2 max=4096');
        assert.equal(result.stderr, '');
      },
    );
  });

  it('fails closed when git is unavailable', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-code-file-lines-no-git-'));
    try {
      const result = runGate(root);
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes('[code-file-lines] setup error:'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a tracked code file cannot be read', () => {
    withGitRepo([['src/broken.ts', 'x\n']], (root) => {
      rmSync(join(root, 'src', 'broken.ts'));
      mkdirSync(join(root, 'src', 'broken.ts'));
      const result = runGate(root);
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes('failed to read src/broken.ts'));
    });
  });

  it('fails closed when a tracked code file is not valid UTF-8', () => {
    withGitRepo([['src/broken.ts', Buffer.from([0xff, 0xfe])]], (root) => {
      const result = runGate(root);
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes('invalid UTF-8 text:'));
    });
  });

  it('fails closed when a tracked code path is replaced by a symlink', () => {
    withGitRepo([['src/link.ts', 'x\n']], (root) => {
      rmSync(join(root, 'src', 'link.ts'));
      symlinkSync(join(root, 'src', 'target.ts'), join(root, 'src', 'link.ts'));
      writeFileSync(join(root, 'src', 'target.ts'), 'x\n');
      const result = runGate(root);
      assert.equal(result.status, 2);
      assert.ok(result.stderr.includes('failed to read src/link.ts'));
    });
  });
});
