import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { PNG } from 'pngjs';

test('the Browser capture records the actual configured evidence directory for pixel assertions', async () => {
  const source = readFileSync(new URL('../smoke-browser.mjs', import.meta.url), 'utf8');
  const imageFunctions = source.slice(source.indexOf('function sha256File('), source.indexOf('function resultShape('));
  const capture = source.slice(source.indexOf('  async function captureStage('), source.indexOf("  await page.evaluate(() => globalThis.__bloomCarrierProbe.setStage('on'))"));
  const evidenceDir = mkdtempSync(join(tmpdir(), 'bloom-browser-evidence-'));
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(255);
  const paths = [];
  const screenshot = async ({ path }) => {
    paths.push(path);
    writeFileSync(path, PNG.sync.write(png));
  };
  const page = {
    waitForTimeout: async () => {},
    screenshot,
    locator: () => ({ screenshot }),
    evaluate: async (callback) => callback.toString().includes('__bloomCarrierProbe.inspect')
      ? { submittedFrames: 60 } : undefined,
  };
  try {
    const stage = await runInNewContext(
      `${imageFunctions}\n${capture}\ncaptureStage('on')`,
      { createHash, readFileSync, PNG, page, evidenceDir, resolve, evidence: { stages: [] },
        resultShape: (result) => result, console: { log() {} } },
    );
    for (const readback of [stage.readback, stage.sceneReadback, stage.compositorReadback]) {
      assert.ok(paths.includes(readback.path), `pixel assertion path was not captured: ${readback.path}`);
      assert.equal(readback.sha256, createHash('sha256').update(readFileSync(readback.path)).digest('hex'));
    }
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});
