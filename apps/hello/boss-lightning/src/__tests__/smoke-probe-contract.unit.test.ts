import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyDawnErrors,
  isSimulationUpdate,
  READINESS_FRAME_LIMIT,
} from '../../scripts/smoke-diagnostics.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const dawnSource = readFileSync(resolve(appRoot, 'scripts/smoke-dawn.mjs'), 'utf8');
const browserSource = readFileSync(resolve(appRoot, 'scripts/smoke-browser.mjs'), 'utf8');
const falsifySource = readFileSync(resolve(appRoot, 'scripts/smoke-falsify.mjs'), 'utf8');

describe('Boss Lightning smoke probe contract', () => {
  it('counts separate and fused simulation updates without counting auxiliary dispatches', () => {
    expect(isSimulationUpdate('forgeax_vfx_update_main')).toBe(true);
    expect(isSimulationUpdate('forgeax_vfx_update_compact_main')).toBe(true);
    for (const entryPoint of [
      undefined,
      'forgeax_vfx_spawn_main',
      'forgeax_vfx_scan_blocks_main',
      'forgeax_vfx_scan_compact_main',
      'forgeax_vfx_compact_main',
      'forgeax_vfx_stage_main',
      'forgeax_vfx_billboard_main',
      'forgeax_vfx_update_custom_main',
    ]) {
      expect(isSimulationUpdate(entryPoint)).toBe(false);
    }
  });

  it('uses particle-specific Dawn signals and rejects persistent preparation errors', () => {
    expect(dawnSource).toContain('TARGET_FRAMES = Math.max(60,');
    expect(dawnSource).toContain('SEED = 42');
    expect(dawnSource).toContain('camera: CAMERA');
    expect(dawnSource).toContain('queuedIntents');
    expect(dawnSource).toContain('runtimeDiagnostics');
    expect(dawnSource).toContain('runtime.hasPlayer(playerEntity)');
    expect(dawnSource).toContain('billboardEnergy');
    expect(dawnSource).toContain('meshEnergy');
    expect(dawnSource).toContain('persistentErrors');
    expect(dawnSource).toContain('strikeOnly');
    expect(dawnSource).not.toContain('console.error = () => {}');

    const classified = classifyDawnErrors(
      [
        {
          code: 'render-feature-preparation-failed',
          detail: { stage: 'prepare', recovery: 'next-frame' },
          frame: 3,
        },
        {
          code: 'render-feature-preparation-failed',
          detail: { stage: 'prepare', recovery: 'next-frame' },
          frame: READINESS_FRAME_LIMIT + 1,
        },
      ],
      8,
    );
    expect(classified.warmupErrors).toHaveLength(1);
    expect(classified.persistentErrors).toHaveLength(1);
  });

  it('keeps Browser validation, readiness, and falsifier exits explicit', () => {
    expect(browserSource).toContain('validationErrors');
    expect(browserSource).toContain('runtime.diagnostics.length !== 0');
    expect(browserSource).toContain('cameraReady');
    expect(browserSource).toContain('seed: 42');
    expect(falsifySource).toContain("'disable-vfx'");
    expect(falsifySource).toContain("'emitter-zero'");
    expect(falsifySource).toContain("'material-empty'");
    expect(falsifySource).toContain('result.status !== 0');
  });

  it('keeps each Batch B falsifier on the same observable path', () => {
    for (const mode of [
      'billboard-fallback',
      'freeze-generation',
      'event-queue-cleared',
      'missing-depth',
      'stage-cycle',
      'stage-hazard',
      'stage-budget',
    ]) {
      expect(falsifySource).toContain(`'${mode}'`);
      expect(browserSource).toContain(mode);
    }
    expect(browserSource).toContain('screenshot');
    expect(browserSource).toContain('visualEvidence');
    expect(browserSource).not.toContain('cpuParticle');
    expect(browserSource).not.toContain('readback');
  });
});
