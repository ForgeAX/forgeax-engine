// feat-20260611 R2 / M8 / w29 (IS-14): record-stage skin BindGroup unit test.
//
// Why this file exists:
//   M8 wires the record stage to bind a 3-binding `pbr-skin-mesh-array-bgl`
//   (binding 0 mesh-array UBO + binding 1 current palette UBO + binding 2
//   previous palette UBO) at group(2) when
//   the per-entry skin discriminator (`entry.source.skin !== undefined`) is
//   set. R1 of this loop discovered the prior 1-binding `pbr-mesh-bg`
//   build path triggered every-frame BGL-mismatch device errors against
//   `pbr-skin-pl`, but every static gate (typecheck / unit / dawn smoke)
//   stayed GREEN -- the regression only surfaced in browser deviceErrors.
//   This test lifts the BGL-shape check from the device runtime to a
//   compile-and-run unit gate so the next regression at this slot fails
//   fast in CI rather than at frame N.
//
// What this test asserts:
//   (1) `buildPbrSkinLayouts` returns a 3-entry meshArrayBgl labeled
//       `pbr-skin-mesh-array-bgl` with bindings 0 + 1 + 2 all
//       `hasDynamicOffset: true`. This is the BGL the record stage
//       must use to build a BG matching `pbr-skin-pl`.
//   (2) The skin pipeline layout `pbr-skin-pl` references the SAME
//       skin meshArrayBgl handle at slot 2, NOT the standard PBR
//       `pbr-mesh-array-bgl`. This pins the BG-vs-PipelineLayout
//       contract that R1 violated.
//   (3) Regression guard: `buildPbrPipelineLayouts` (URP) returns a
//       1-entry meshArrayBgl labeled `pbr-mesh-array-bgl`. M8 must
//       NOT leak the 3-entry skin BGL into the URP path.
//
// What this test deliberately does NOT cover:
//   - The actual `pass.setBindGroup(2, ...)` dispatch site is exercised
//     by `apps/hello/skin/scripts/smoke-browser.mjs` (w27 strict gate +
//     w30 rerun); driving recordFrame from a unit fixture would mock too
//     much of the renderer to be a useful regression net.
//   - Palette UBO data correctness (joint world * IBM premultiply): the
//     skin animator integration is OOS-3 of feat-20260611. This test
//     cares only about BGL shape + buffer-binding contract.

import type { BindGroupLayout, PipelineLayout, RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import {
  buildPbrPipelineLayouts,
  buildPbrSkinLayouts,
  type PbrPipelineDevice,
} from '../../../render/src/pbr-pipeline';

interface CapturedBglDesc {
  readonly label: string | undefined;
  readonly entries: readonly GPUBindGroupLayoutEntry[];
}

interface CapturedPipelineLayoutDesc {
  readonly label: string | undefined;
  readonly bindGroupLayouts: readonly BindGroupLayout[];
}

interface MockDeviceCapture {
  readonly bgls: CapturedBglDesc[];
  readonly pipelineLayouts: CapturedPipelineLayoutDesc[];
  readonly bglByHandle: Map<BindGroupLayout, CapturedBglDesc>;
}

function makeMockDevice(): { device: PbrPipelineDevice; capture: MockDeviceCapture } {
  const bgls: CapturedBglDesc[] = [];
  const pipelineLayouts: CapturedPipelineLayoutDesc[] = [];
  const bglByHandle = new Map<BindGroupLayout, CapturedBglDesc>();
  const device: PbrPipelineDevice = {
    createBindGroupLayout(desc): Result<BindGroupLayout, RhiError> {
      const captured: CapturedBglDesc = { label: desc.label, entries: desc.entries ?? [] };
      bgls.push(captured);
      // Each call returns a fresh opaque handle; using a plain object lets us
      // reference-compare layouts later (the assertion at (2) needs handle
      // equality between the skin meshArrayBgl and pbr-skin-pl slot 2).
      const handle = {} as BindGroupLayout;
      bglByHandle.set(handle, captured);
      return ok(handle);
    },
    createPipelineLayout(desc): Result<PipelineLayout, RhiError> {
      pipelineLayouts.push({ label: desc.label, bindGroupLayouts: [...desc.bindGroupLayouts] });
      return ok({} as PipelineLayout);
    },
  };
  return { device, capture: { bgls, pipelineLayouts, bglByHandle } };
}

describe('feat-20260611 R2 / M8 / w29 — record-stage skin BindGroup BGL contract', () => {
  it('(1) buildPbrSkinLayouts returns a 3-entry meshArrayBgl labeled pbr-skin-mesh-array-bgl with bindings 0 + 1 + 2 all hasDynamicOffset:true (storage path)', () => {
    const { device, capture } = makeMockDevice();
    const pbr = buildPbrPipelineLayouts(device, { storageBuffer: true });
    const skin = buildPbrSkinLayouts(device, { storageBuffer: true }, pbr);

    const skinDesc = capture.bglByHandle.get(skin.meshArrayBgl);
    expect(skinDesc).toBeDefined();
    expect(skinDesc?.label).toBe('pbr-skin-mesh-array-bgl');
    expect(skinDesc?.entries).toHaveLength(3);
    expect(skinDesc?.entries[0]?.binding).toBe(0);
    expect(skinDesc?.entries[0]?.buffer?.hasDynamicOffset).toBe(true);
    expect(skinDesc?.entries[0]?.buffer?.type).toBe('read-only-storage');
    expect(skinDesc?.entries[1]?.binding).toBe(1);
    expect(skinDesc?.entries[1]?.buffer?.hasDynamicOffset).toBe(true);
    expect(skinDesc?.entries[1]?.buffer?.type).toBe('read-only-storage');
    expect(skinDesc?.entries[2]?.binding).toBe(2);
    expect(skinDesc?.entries[2]?.buffer?.hasDynamicOffset).toBe(true);
    expect(skinDesc?.entries[2]?.buffer?.type).toBe('read-only-storage');
  });

  it('(1b) uniform fallback path: buildPbrSkinLayouts BGL bindings 0 + 1 + 2 all type=uniform', () => {
    const { device, capture } = makeMockDevice();
    const pbr = buildPbrPipelineLayouts(device, { storageBuffer: false });
    const skin = buildPbrSkinLayouts(device, { storageBuffer: false }, pbr);

    const skinDesc = capture.bglByHandle.get(skin.meshArrayBgl);
    expect(skinDesc?.entries[0]?.buffer?.type).toBe('uniform');
    expect(skinDesc?.entries[1]?.buffer?.type).toBe('uniform');
    expect(skinDesc?.entries[2]?.buffer?.type).toBe('uniform');
  });

  it('(2) pbr-skin-pl slot 2 === skin meshArrayBgl handle (NOT the standard pbr-mesh-array-bgl) — pins the BG vs PipelineLayout contract R1 violated', () => {
    const { device, capture } = makeMockDevice();
    const pbr = buildPbrPipelineLayouts(device, { storageBuffer: true });
    const skin = buildPbrSkinLayouts(device, { storageBuffer: true }, pbr);

    // Find the pipeline layout descriptor labeled 'pbr-skin-pl'.
    const skinPlDesc = capture.pipelineLayouts.find((d) => d.label === 'pbr-skin-pl');
    expect(skinPlDesc).toBeDefined();
    expect(skinPlDesc?.bindGroupLayouts).toHaveLength(4);
    // Slot 2 must be the skin meshArrayBgl handle, NOT pbr.meshArrayBgl.
    expect(skinPlDesc?.bindGroupLayouts[2]).toBe(skin.meshArrayBgl);
    expect(skinPlDesc?.bindGroupLayouts[2]).not.toBe(pbr.meshArrayBgl);
    // View / material / instances slots are reused from the URP bundle (factory
    // contract: only meshArrayBgl is fresh).
    expect(skinPlDesc?.bindGroupLayouts[0]).toBe(pbr.viewBgl);
    expect(skinPlDesc?.bindGroupLayouts[1]).toBe(pbr.materialBgl);
    expect(skinPlDesc?.bindGroupLayouts[3]).toBe(pbr.instancesBgl);
  });

  it('(3) regression guard: buildPbrPipelineLayouts (URP) returns 1-entry meshArrayBgl labeled pbr-mesh-array-bgl — M8 must NOT leak the 3-entry skin BGL into URP', () => {
    const { device, capture } = makeMockDevice();
    const pbr = buildPbrPipelineLayouts(device, { storageBuffer: true });

    const urpMeshDesc = capture.bglByHandle.get(pbr.meshArrayBgl);
    expect(urpMeshDesc).toBeDefined();
    expect(urpMeshDesc?.label).toBe('pbr-mesh-array-bgl');
    expect(urpMeshDesc?.entries).toHaveLength(1);
    expect(urpMeshDesc?.entries[0]?.binding).toBe(0);
    expect(urpMeshDesc?.entries[0]?.buffer?.hasDynamicOffset).toBe(true);
  });
});
