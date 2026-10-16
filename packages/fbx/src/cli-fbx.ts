#!/usr/bin/env node

import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createFbxMeta,
  type FbxMetaPreviousDocument,
  type FbxMetaSourceDocument,
  isFbxMetaDocument,
} from './meta.js';
import { initFbxWasm, parseFbx } from './wasm.js';

interface FbxCliContext {
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
}

interface FbxCliError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}

function emitError(ctx: FbxCliContext, error: FbxCliError): number {
  const payload: Record<string, unknown> = {
    code: error.code,
    expected: error.expected,
    hint: error.hint,
  };
  if (error.detail !== undefined) payload.detail = error.detail;
  ctx.stderrWrite(JSON.stringify(payload));
  return 1;
}

function serializeMetaJson(value: unknown): string {
  const sortKeysDeep = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(sortKeysDeep);
    if (current !== null && typeof current === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>).sort()) {
        sorted[key] = sortKeysDeep((current as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return current;
  };
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

function helpBody(): string {
  return [
    'forgeax asset import — FBX sidecar importer (internal producer)',
    '',
    'Usage:',
    '  forgeax asset import <path.fbx> --root <project>',
    '  forgeax asset import <path.fbx> --dry-run --root <project>',
    '',
    'produces mesh, material, scene, texture, skin, skeleton, and animation',
    'sub-asset entries in the sibling <source>.meta.json sidecar.',
    '',
  ].join('\n');
}

function existingMetaPath(sourcePath: string): string {
  return `${sourcePath}.meta.json`;
}

async function readExistingMeta(
  sourcePath: string,
  ctx: FbxCliContext,
): Promise<
  | {
      readonly ok: true;
      readonly path: string;
      readonly value: FbxMetaPreviousDocument | undefined;
    }
  | { readonly ok: false; readonly exitCode: number }
> {
  const metaPath = existingMetaPath(sourcePath);
  let raw: string;
  try {
    raw = await readFile(metaPath, 'utf8');
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, path: metaPath, value: undefined };
    }
    return {
      ok: false,
      exitCode: emitError(ctx, {
        code: 'asset-meta-unreadable',
        expected: 'an absent or readable JSON sidecar',
        hint: 'repair the existing FBX sidecar before importing the source again',
        detail: { source: sourcePath, metaPath },
      }),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    return {
      ok: false,
      exitCode: emitError(ctx, {
        code: 'asset-meta-unreadable',
        expected: 'the existing sidecar to contain valid JSON',
        hint: 'repair the existing FBX sidecar before importing the source again',
        detail: {
          source: sourcePath,
          metaPath,
          reason: cause instanceof Error ? cause.message : String(cause),
        },
      }),
    };
  }

  if (!isFbxMetaDocument(parsed)) {
    return {
      ok: false,
      exitCode: emitError(ctx, {
        code: 'asset-meta-conflict',
        expected: 'the existing sidecar to describe an FBX source package',
        hint: 'resolve the sidecar conflict explicitly; the importer will not replace another producer identity',
        detail: { source: sourcePath, metaPath },
      }),
    };
  }
  return { ok: true, path: metaPath, value: parsed };
}

export async function runCliFbx(rest: readonly string[], ctx: FbxCliContext): Promise<number> {
  const [sub, ...subRest] = rest;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    ctx.stdoutWrite(helpBody());
    return 0;
  }
  if (sub !== 'import') {
    return emitError(ctx, {
      code: 'unknown-subcommand',
      expected: "subcommand 'import'",
      hint: "run 'forgeax help asset import' for usage",
      detail: { subcommand: sub },
    });
  }

  const dryRun = subRest.includes('--dry-run');
  const sourcePath = subRest.find((argument) => !argument.startsWith('-'));
  if (sourcePath === undefined) {
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax asset import [--dry-run] <path.fbx> --root <project>',
      hint: "pass a positional <fbx> argument; run 'forgeax help asset import' for usage",
    });
  }
  if (extname(sourcePath).toLowerCase() !== '.fbx') {
    return emitError(ctx, {
      code: 'fbx-source-extension-unsupported',
      expected: 'a .fbx source path',
      hint: 'pass an FBX source to the FBX producer or use the matching built-in importer',
      detail: { path: sourcePath },
    });
  }

  const existing = await readExistingMeta(sourcePath, ctx);
  if (!existing.ok) return existing.exitCode;
  if (dryRun) return 0;

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = new Uint8Array(await readFile(sourcePath));
  } catch (cause) {
    return emitError(ctx, {
      code: 'fbx-source-read-failed',
      expected: 'a readable FBX source file',
      hint: 'check the source path and file permissions, then retry the import',
      detail: { path: sourcePath, reason: cause instanceof Error ? cause.message : String(cause) },
    });
  }

  let parsed: unknown;
  try {
    await initFbxWasm();
    parsed = JSON.parse(parseFbx(sourceBytes)) as unknown;
  } catch (cause) {
    return emitError(ctx, {
      code: 'fbx-import-failed',
      expected: 'the FBX producer to parse the source and expose a supported topology',
      hint: cause instanceof Error ? cause.message : 'inspect the FBX source and retry',
      detail: { path: sourcePath },
    });
  }

  if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const parserError = (parsed as { readonly error?: unknown }).error;
    if (parserError !== undefined && typeof parserError === 'object' && parserError !== null) {
      const detail = parserError as Record<string, unknown>;
      return emitError(ctx, {
        code: typeof detail.code === 'string' ? detail.code : 'fbx-import-failed',
        expected: 'the FBX producer to expose a supported topology',
        hint: 'repair or convert the FBX source, then retry the import',
        detail: { path: sourcePath, parser: detail },
      });
    }
  }

  const document = parsed as FbxMetaSourceDocument;

  const meta = createFbxMeta(document, basename(sourcePath), existing.value);
  if (!meta.ok) return emitError(ctx, meta.error);

  try {
    await writeFile(existing.path, serializeMetaJson(meta.value), 'utf8');
  } catch (cause) {
    return emitError(ctx, {
      code: 'asset-meta-write-failed',
      expected: 'the FBX sidecar to be writable beside the source',
      hint: 'check the project asset directory permissions and retry',
      detail: {
        path: existing.path,
        reason: cause instanceof Error ? cause.message : String(cause),
      },
    });
  }
  return 0;
}

const isBinEntry = await (async (): Promise<boolean> => {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string') return false;
  const argv1Real = await realpath(argv1).catch(() => argv1);
  const selfReal = await realpath(fileURLToPath(import.meta.url)).catch(() =>
    fileURLToPath(import.meta.url),
  );
  return argv1Real === selfReal;
})();

if (isBinEntry) {
  const exitCode = await runCliFbx(process.argv.slice(2), {
    stdoutWrite: (line) => {
      process.stdout.write(`${line}\n`);
    },
    stderrWrite: (line) => {
      process.stderr.write(`${line}\n`);
    },
  });
  process.exit(exitCode);
}
