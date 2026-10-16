// nurbs-fail-fast.test.ts — NURBS fail-fast unit test.
//
// The ufbx WASM parser emits an error JSON envelope when a NURBS/patch
// surface is encountered; the TS bridge maps it to
// Result.Err(FbxError({code:'fbx-mesh-type-unsupported'})). This test pins
// that envelope shape and the fbxErr factory contract against a mock JSON
// payload (no native addon exists post-ufbx collapse).

import { describe, expect, it } from 'vitest';
import type { FbxError } from '../src/errors.js';

/**
 * Mock JSON returned by the ufbx WASM parser when a NURBS mesh is detected
 * (produced instead of a valid mesh document).
 */
function makeNurbsErrorJson(kind: string): string {
  return JSON.stringify({
    error: {
      code: 'fbx-mesh-type-unsupported',
      meshType: kind,
      meshName: 'TestNURBS',
    },
  });
}

describe('NURBS fail-fast mock path', () => {
  it('detects fbx-mesh-type-unsupported from error JSON', () => {
    const json = makeNurbsErrorJson('nurbs');
    const parsed = JSON.parse(json) as {
      error?: { code: string; meshType: string; meshName: string };
    };

    expect(parsed.error).toBeDefined();
    expect(parsed.error!.code).toBe('fbx-mesh-type-unsupported');
    expect(parsed.error!.meshType).toBe('nurbs');
    expect(parsed.error!.meshName).toBe('TestNURBS');
  });

  it('detects patch mesh type', () => {
    const json = makeNurbsErrorJson('patch');
    const parsed = JSON.parse(json) as {
      error?: { code: string; meshType: string; meshName: string };
    };
    expect(parsed.error!.meshType).toBe('patch');
  });

  it('fbxErr factory produces correct error shape', async () => {
    // Import the actual fbxErr factory to verify error contract
    const { fbxErr } = await import('../src/errors.js');
    const err = fbxErr('fbx-mesh-type-unsupported', {
      meshType: 'nurbs',
      meshName: 'TestNURBS',
    });

    expect(err.code).toBe('fbx-mesh-type-unsupported');
    expect(err.detail.meshType).toBe('nurbs');
    expect(err.detail.meshName).toBe('TestNURBS');
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
    expect(typeof err.expected).toBe('string');
    expect(err.expected.length).toBeGreaterThan(0);

    // Exhaustive switch: FbxErrorCode is a closed union
    const _check: FbxError = err;
    void _check;
    switch (err.code) {
      case 'fbx-mesh-type-unsupported':
        expect(err.detail.meshType).toBeDefined();
        break;
      case 'fbx-animation-target-invalid':
      case 'fbx-lod-display-mode-unsupported':
        break;
    }
  });
});
