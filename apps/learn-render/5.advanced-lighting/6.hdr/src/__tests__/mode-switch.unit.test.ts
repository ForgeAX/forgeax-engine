// apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/mode-switch.unit.test.ts
//
// LearnOpenGL section 5.6 HDR mode-switch pure-function unit tests.
// AC-10 + plan-strategy section 5.1 TDD: the keyboard '1'/'2' -> pipeline
// asset table-lookup is a pure function with no GPU dependency. The four
// covered paths mirror the gamma-correction Result error-shape (AC-10):
//   (a) key '1'  -> Result.ok with HDR pipeline asset
//   (b) key '2'  -> Result.ok with LDR pipeline asset (different from (a))
//   (c) bad key  -> Result.err code='unknown-hdr-key', detail echoes received
//   (d) renderer-not-ready -> Result.err code='pipelines-not-ready', hint
//                              suggests `await app.start()` before calling

import { describe, it, expect, beforeEach } from 'vitest';
import {
  installHdrPipelineByKey,
  resetHdrPipelineRegistryForTest,
  setHdrPipelineRegistryForTest,
  type HdrMode,
} from '../hdr-pipeline';

const modeCalls: HdrMode[] = [];

beforeEach(() => {
  modeCalls.length = 0;
  resetHdrPipelineRegistryForTest();
});

describe('installHdrPipelineByKey', () => {
  it("returns Result.ok and installs HDR pipeline for key '1'", () => {
    setHdrPipelineRegistryForTest({ setMode: (mode) => modeCalls.push(mode) });
    const result = installHdrPipelineByKey('1');
    expect(result.ok).toBe(true);
    expect(modeCalls).toEqual(['hdr']);
  });

  it("returns Result.ok and installs LDR pipeline for key '2'", () => {
    setHdrPipelineRegistryForTest({ setMode: (mode) => modeCalls.push(mode) });
    const result = installHdrPipelineByKey('2');
    expect(result.ok).toBe(true);
    expect(modeCalls).toEqual(['ldr']);
  });

  it('the two known keys map to different assets', () => {
    setHdrPipelineRegistryForTest({ setMode: (mode) => modeCalls.push(mode) });
    installHdrPipelineByKey('1');
    installHdrPipelineByKey('2');
    expect(modeCalls).toEqual(['hdr', 'ldr']);
  });

  it("returns Result.err code='unknown-hdr-key' for unknown key with detail echo", () => {
    setHdrPipelineRegistryForTest({ setMode: (mode) => modeCalls.push(mode) });
    const result = installHdrPipelineByKey('9');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('unknown-hdr-key');
      expect(result.error.hint).toContain('9');
      expect(result.error.hint).toContain('1');
      expect(result.error.hint).toContain('2');
    }
    expect(modeCalls).toHaveLength(0);
  });

  it("returns Result.err code='pipelines-not-ready' when registry is unset", () => {
    const result = installHdrPipelineByKey('1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('pipelines-not-ready');
      expect(result.error.hint).toContain('app.start()');
    }
    expect(modeCalls).toHaveLength(0);
  });
});
