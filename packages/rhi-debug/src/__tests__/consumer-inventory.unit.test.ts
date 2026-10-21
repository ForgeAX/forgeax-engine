import { spawnSync } from 'node:child_process';
// @perf-budget-skip: intentional repository-wide inventory subprocess gate.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../../../../', import.meta.url)));
const inventoryScript = join(repoRoot, 'apps/shared/scripts/rhi-debug-consumer-inventory.mjs');
const oosInventoryScript = join(repoRoot, 'apps/shared/scripts/rhi-debug-oos-inventory.mjs');

const deletedFieldConsumers = [
  'apps/shared/scripts/rhi-debug-browser-admission.mjs',
  'apps/shared/scripts/rhi-debug-verify.mjs',
  'apps/learn-render/4.advanced-opengl/5.framebuffers/scripts/smoke-browser-live.mjs',
  'apps/rhi-debug-viewer/src/viewer-model.ts',
  'apps/rhi-debug-viewer/scripts/smoke-browser.mjs',
  'apps/rhi-debug-viewer/scripts/smoke-browser-no-webgpu.mjs',
  'packages/rhi-debug/src/__tests__/e2e.browser.test.ts',
];

type ChannelReport = {
  totalMatches: number;
  scannedFileCount: number;
  matchedFileCount: number;
  matches: readonly {
    path: string;
    matches: readonly { pattern: string; count: number; lines: readonly number[] }[];
  }[];
};

type InventoryReport = {
  schemaVersion: number;
  channels: {
    readonly jsonSchema: ChannelReport;
    readonly tsModule: ChannelReport;
    readonly typesErasedScript: ChannelReport;
  };
  baseline: {
    scannedFileCount: number;
    matchedFileCount: number;
    totalMatches: number;
  };
};

function runInventory(root: string): { status: number | null; report: InventoryReport } {
  const result = spawnSync(process.execPath, [inventoryScript, '--root', root, '--json'], {
    encoding: 'utf8',
  });
  return {
    status: result.status,
    report: JSON.parse(result.stdout) as InventoryReport,
  };
}

describe('rhi-debug consumer inventory', () => {
  it('reports all nine OOS boundaries and retained owners as machine-readable pass rows', () => {
    const result = spawnSync(process.execPath, [oosInventoryScript, '--json', '--assert-pass'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      status: string;
      oos: readonly { id: string; status: string }[];
      retainedCore: readonly { present: boolean }[];
    };
    expect(report.status).toBe('pass');
    expect(report.oos.map((entry) => entry.id)).toEqual([
      'OOS-1',
      'OOS-2',
      'OOS-3',
      'OOS-4',
      'OOS-5',
      'OOS-6',
      'OOS-7',
      'OOS-8',
      'OOS-9',
    ]);
    expect(report.oos.every((entry) => entry.status === 'pass')).toBe(true);
    expect(report.retainedCore.every((entry) => entry.present)).toBe(true);
  });

  it('enumerates TS, erased-script, and JSON/schema consumer channels', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'forgeax-rhi-debug-consumers-'));
    try {
      mkdirSync(join(fixture, 'packages', 'rhi-debug', 'src'), { recursive: true });
      mkdirSync(join(fixture, 'apps', 'learn-render', 'demo', 'scripts'), { recursive: true });
      mkdirSync(join(fixture, 'apps', 'shared', 'scripts'), { recursive: true });
      mkdirSync(join(fixture, 'apps', 'rhi-debug-viewer', 'fixtures'), { recursive: true });
      mkdirSync(join(fixture, 'apps', 'hello', 'artifacts', 'sdk-source'), { recursive: true });
      writeFileSync(
        join(fixture, 'packages', 'rhi-debug', 'src', 'consumer.ts'),
        `const value = 0;\nexport const ${'draw' + 'Idx'} = 1;\nvoid drawIdx;\n`,
      );
      writeFileSync(
        join(fixture, 'apps', 'shared', 'scripts', 'rhi-debug-verify.mjs'),
        `const ${'report' + 'Path'} = "${'frame-0.' + 'report.json'}";\n`,
      );
      writeFileSync(
        join(fixture, 'apps', 'rhi-debug-viewer', 'fixtures', 'fixture.mjs'),
        `const ${'tape' + 'Path'} = "frame-0.tape";\n`,
      );
      writeFileSync(
        join(fixture, 'apps', 'learn-render', 'demo', 'scripts', 'smoke-browser-live.mjs'),
        'const capture = await captureFrame(1);\n',
      );
      writeFileSync(
        join(fixture, 'packages', 'rhi-debug', 'package.json'),
        JSON.stringify({ command: 'capture-' + 'frame', artifactKind: 'paired-' + 'differential' }),
      );
      writeFileSync(
        join(fixture, 'apps', 'hello', 'artifacts', 'sdk-source', 'old.ts'),
        `export const ${'draw' + 'Idx'} = 1;\n`,
      );
      writeFileSync(
        join(fixture, 'apps', 'hello', 'artifacts', 'sdk-source', 'package.json'),
        JSON.stringify({ artifactKind: 'paired-' + 'differential' }),
      );

      const result = runInventory(fixture);

      expect(result.status).toBe(0);
      expect(result.report.schemaVersion).toBe(1);
      expect(Object.keys(result.report.channels ?? {}).sort()).toEqual([
        'jsonSchema',
        'tsModule',
        'typesErasedScript',
      ]);
      expect(result.report.channels.tsModule.totalMatches).toBeGreaterThan(0);
      expect(result.report.channels.typesErasedScript.totalMatches).toBeGreaterThan(0);
      expect(result.report.channels.typesErasedScript.totalMatches).toBeGreaterThan(1);
      expect(result.report.channels.jsonSchema.totalMatches).toBeGreaterThan(0);
      expect(result.report.channels.tsModule.scannedFileCount).toBe(1);
      expect(result.report.channels.jsonSchema.scannedFileCount).toBe(1);
      expect(
        result.report.channels.tsModule.matches
          .find(({ path }) => path === 'packages/rhi-debug/src/consumer.ts')
          ?.matches.find(({ pattern }) => pattern === 'drawIdx')?.lines,
      ).toEqual([2, 3]);
      expect(result.report.baseline.totalMatches).toBe(
        result.report.channels.tsModule.totalMatches +
          result.report.channels.typesErasedScript.totalMatches +
          result.report.channels.jsonSchema.totalMatches,
      );
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it('finds no deleted FrameModel fields across the three consumer channels', () => {
    const deleted =
      /(?:\bmodel\.(?:tree|draws|meta|resourceTable|resourceEntries|totalDraws)|buildTapeIndex)/;
    const matches = deletedFieldConsumers.flatMap((relativePath) => {
      const source = readFileSync(join(repoRoot, relativePath), 'utf8');
      return deleted.test(source) ? [relativePath] : [];
    });
    expect(matches).toEqual([]);
  });
});
