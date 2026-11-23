// @ts-nocheck — remaining legacy assertions are migrated separately.
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: source test block isolation
import { ok } from '@forgeax/engine-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { projectViewLayout } from '../../../render/src/environment/bindings';
import { buildPbrPipelineLayouts, buildUnlitMaterialBgl } from '../../../render/src/pbr-pipeline';

afterEach(() => vi.restoreAllMocks());
{
  // --- from skylight-pipeline-layout.test.ts ---

  const STORAGE_CAPS: PbrCaps = { storageBuffer: true };

  // ─── Mock device ────────────────────────────────────────────────────────────
  //
  // Captures every descriptor passed to createBindGroupLayout / createPipelineLayout
  // so the test inspects the final pipeline-layout shape without standing up a
  // real GPU.

  interface CapturedBgl {
    readonly label: string | undefined;
    readonly entries: readonly GPUBindGroupLayoutEntry[];
  }

  interface CapturedPipelineLayout {
    readonly label: string | undefined;
    readonly bindGroupLayouts: readonly unknown[];
  }

  interface MockDevice {
    readonly createBindGroupLayout: ReturnType<typeof vi.fn>;
    readonly createPipelineLayout: ReturnType<typeof vi.fn>;
    readonly capturedBgls: CapturedBgl[];
    readonly capturedPipelineLayouts: CapturedPipelineLayout[];
  }

  function makeMockDevice(): MockDevice {
    const capturedBgls: CapturedBgl[] = [];
    const capturedPipelineLayouts: CapturedPipelineLayout[] = [];
    const createBindGroupLayout = vi.fn(
      (desc: { label?: string; entries: readonly GPUBindGroupLayoutEntry[] }) => {
        const captured: CapturedBgl = { label: desc.label, entries: desc.entries };
        capturedBgls.push(captured);
        // Return an opaque BindGroupLayout handle (the captured descriptor) so
        // downstream `createPipelineLayout` calls can refer to it by identity.
        return ok(captured);
      },
    );
    const createPipelineLayout = vi.fn(
      (desc: { label?: string; bindGroupLayouts: readonly unknown[] }) => {
        const captured: CapturedPipelineLayout = {
          label: desc.label,
          bindGroupLayouts: desc.bindGroupLayouts,
        };
        capturedPipelineLayouts.push(captured);
        return { ok: true, value: captured };
      },
    );
    return {
      createBindGroupLayout,
      createPipelineLayout,
      capturedBgls,
      capturedPipelineLayouts,
    };
  }

  // ─── (a)..(d) PBR pipeline layout shape ─────────────────────────────────────

  describe('t57 (M4 round-4) -- standardPipeline pipeline-layout shape', () => {
    it('(a) buildPbrPipelineLayouts returns bindGroupLayouts.length === 4 (no @group(4))', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      const result = buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      expect(result.bindGroupLayouts).toHaveLength(4);
      // And the captured pipeline layout descriptor matches.
      expect(device.capturedPipelineLayouts).toHaveLength(2);
      const layout = device.capturedPipelineLayouts.find((entry) => entry.label === 'pbr-pl');
      expect(layout?.bindGroupLayouts).toHaveLength(4);
      expect(layout?.label).toBe('pbr-pl');
    });

    it('keeps the material slots and Scene material row without environment inputs', () => {
      const device = makeMockDevice();
      buildPbrPipelineLayouts(device, STORAGE_CAPS);
      const entries = device.capturedBgls.find(
        (b) => b.label === 'pbr-material-skylight-bgl',
      )?.entries;
      const surface = Array.from({ length: 25 }, (_, binding) => binding).filter(
        (binding) => binding !== 15 && binding !== 16,
      );
      expect(entries?.map(({ binding }) => binding)).toEqual([...surface, 46]);
      expect(entries?.at(-1)).toMatchObject({
        binding: 46,
        buffer: { type: 'read-only-storage', hasDynamicOffset: false },
      });
    });

    it('projects the sky and transmission backdrop through View', () => {
      const device = makeMockDevice();
      const { viewBgl } = buildPbrPipelineLayouts(device, STORAGE_CAPS);
      const reads = new Map([34, 35, 38, 39].map((binding) => [binding, 2]));
      const view = projectViewLayout(device, viewBgl, reads);
      expect(view.entries).toEqual([
        expect.objectContaining({ binding: 0 }),
        expect.objectContaining({
          binding: 10,
          buffer: { type: 'uniform', hasDynamicOffset: true },
        }),
        expect.objectContaining({ binding: 34, buffer: { type: 'uniform', minBindingSize: 112 } }),
        expect.objectContaining({ binding: 35, buffer: { type: 'uniform' } }),
        expect.objectContaining({
          binding: 38,
          texture: { sampleType: 'float', viewDimension: '2d' },
        }),
        expect.objectContaining({
          binding: 39,
          texture: { sampleType: 'float', viewDimension: '2d' },
        }),
      ]);
    });

    it('(d) bindGroupLayouts[0..3] order matches [view, material, meshArray, instances]', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      const result = buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      expect(result.bindGroupLayouts[0]).toBe(result.viewBgl);
      expect(result.bindGroupLayouts[1]).toBe(result.materialBgl);
      expect(result.bindGroupLayouts[2]).toBe(result.meshArrayBgl);
      expect(result.bindGroupLayouts[3]).toBe(result.instancesBgl);
      // Labels confirm slot identity.
      const view = device.capturedBgls.find((b) => b.label === 'pbr-view-bgl');
      const mesh = device.capturedBgls.find((b) => b.label === 'pbr-mesh-array-bgl');
      const instances = device.capturedBgls.find((b) => b.label === 'pbr-instances-bgl');
      expect(view).toBeDefined();
      expect(mesh).toBeDefined();
      expect(instances).toBeDefined();
    });
  });

  // ─── (e)(f) Unlit material BGL shape + name ─────────────────────────────────

  describe('t57 (M4 round-4) -- unlitPipeline material BGL shape', () => {
    it('(e) unlit material BGL retains only the 25-entry user region', () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildUnlitMaterialBgl(device as any);
      const unlitBgl = device.capturedBgls.find((b) => b.label === 'unlit-material-bgl');
      expect(unlitBgl).toBeDefined();
      expect(unlitBgl?.entries).toHaveLength(25);
    });

    it("(f) PBR material BGL labelled 'pbr-material-skylight-bgl'; unlit labelled 'unlit-material-bgl'", () => {
      const device = makeMockDevice();
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildPbrPipelineLayouts(device as any, STORAGE_CAPS);
      // biome-ignore lint/suspicious/noExplicitAny: structural mock
      buildUnlitMaterialBgl(device as any);
      const pbr = device.capturedBgls.find((b) => b.label === 'pbr-material-skylight-bgl');
      const unlit = device.capturedBgls.find((b) => b.label === 'unlit-material-bgl');
      expect(pbr).toBeDefined();
      expect(unlit).toBeDefined();
    });
  });
}
