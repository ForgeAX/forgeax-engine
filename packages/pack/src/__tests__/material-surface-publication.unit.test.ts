import { Buffer } from 'node:buffer';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Materials } from '@forgeax/engine-render';
import { describe, expect, it } from 'vitest';
import { validateCookedMaterialRecord } from '../material-cook.js';
import { NativeCookerRegistry } from '../native-cooker-registry.js';

const compilerModule = pathToFileURL(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../packages/shader-compiler/dist/index.mjs',
  ),
).href;

const GUID = '11111111-1111-4111-8111-111111111111';
const ROOT_GUID = '22222222-2222-4222-8222-222222222222';
const CHILD_GUID = '33333333-3333-4333-8333-333333333333';
const SURFACE = `#define_import_path game_3d::rusted_iron_surface
#import forgeax_material::surface_v1::{SurfaceData, SurfaceInput}
fn evaluate_surface(input: SurfaceInput) -> SurfaceData {
  return SurfaceData(vec3<f32>(0.4, 0.45, 0.47), input.vertexNormalWS, 0.0, 0.5, vec3<f32>(0.0), 1.0, 1.0, 0.0);
}`;

describe('Surface Pack publication', () => {
  it('publishes one complete cooked record with source closure and artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-surface-publication-'));
    try {
      const sourcePath = join(root, 'rusted-iron-surface.wgsl');
      await writeFile(sourcePath, SURFACE);
      const material = Materials.standard({
        surfaceModule: 'game_3d::rusted_iron_surface',
        parameters: [],
        values: {},
      });
      const { createMaterialPackCooker } = await import(compilerModule);
      const draft = await createMaterialPackCooker([root]).cook({
        guid: GUID,
        source: material,
        sourcePath,
      });
      const cooked = validateCookedMaterialRecord(draft.payload.cooked).unwrap();
      expect(cooked.receipt.sourceClosure).toContain(sourcePath);
      expect(cooked.programs.length).toBeGreaterThan(0);
      for (const program of cooked.programs) {
        const artifact = draft.artifacts[program.artifact.path];
        expect(artifact?.bytes.byteLength).toBeGreaterThan(0);
        expect(
          Buffer.from(artifact?.bytes ?? []).equals(Buffer.from(program.artifact.bytes)),
          program.artifact.path,
        ).toBe(true);
      }
      expect(
        cooked.resolved.passes?.find((pass) => pass.name === 'shadow-caster')?.program,
      ).toMatchObject({ module: 'forgeax::default-shadow-caster', fragmentEntry: 'fs_shadow' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps the accepted generation as last known good after cook failure', async () => {
    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'material',
      cook: async (input: { readonly fail?: boolean }) => {
        if (input.fail) throw new Error('surface compose failed');
        return {
          guid: GUID,
          payload: { generation: 1 },
          refs: [],
          artifacts: {},
          inputFingerprint: 'sha256:surface-input',
        };
      },
    });
    const first = await registry.runTransaction({ key: 'material', input: {} });
    expect(first).toMatchObject({ ok: true, value: { generation: 1, status: 'committed' } });
    if (!first.ok) return;
    const failed = await registry.runTransaction({
      key: 'material',
      input: { fail: true },
      previous: { draft: first.value.draft, generation: first.value.generation },
    });
    expect(failed).toMatchObject({
      ok: true,
      value: {
        status: 'recovered',
        draft: { payload: { generation: 1 } },
        generation: 1,
      },
    });
  });

  it('cold-cooks a child through the Pack-owned root table and publishes its parent ref', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-surface-root-child-'));
    try {
      const rootMaterial = Materials.standard({
        baseColor: [1, 1, 1, 1],
        metallic: 0,
        roughness: 0.5,
      });
      const child = {
        kind: 'material' as const,
        parent: ROOT_GUID as never,
        values: { baseColor: [0.4, 0.45, 0.47, 1] },
      };
      const { createMaterialPackCooker } = await import(compilerModule);
      const draft = await createMaterialPackCooker([root]).cook({
        guid: CHILD_GUID,
        source: child,
        table: { [ROOT_GUID]: rootMaterial, [CHILD_GUID]: child },
      });
      const cooked = draft.payload.cooked as {
        readonly authored: { readonly parent?: string };
        readonly resolved: {
          readonly parameters: readonly { readonly name: string }[];
          readonly values: Readonly<Record<string, unknown>>;
        };
        readonly refs: { readonly parent: readonly string[] };
      };
      expect(cooked.authored.parent).toBe(ROOT_GUID);
      expect(cooked.refs.parent).toEqual([ROOT_GUID]);
      expect(cooked.resolved.parameters.map((parameter) => parameter.name)).toContain('baseColor');
      expect(cooked.resolved.values.baseColor).toEqual([0.4, 0.45, 0.47, 1]);
      expect(draft.refs).toContain(ROOT_GUID);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('does not publish an artifact when a physical material requests Deferred', async () => {
    const { createMaterialPackCooker } = await import(compilerModule);
    const material = {
      kind: 'material' as const,
      staticSwitches: { clearcoat: true },
      passes: [
        {
          name: 'forward',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: 'forgeax_material::default_standard_surface' },
          },
        },
        {
          name: 'deferred',
          program: {
            module: 'forgeax_material::standard',
            moduleSlots: { surface: 'forgeax_material::default_standard_surface' },
          },
        },
      ],
      parameters: [
        { name: 'clearcoat', type: 'f32' as const },
        { name: 'clearcoatRoughness', type: 'f32' as const },
      ],
      values: { clearcoat: 0, clearcoatRoughness: 0.5 },
    };
    await expect(
      createMaterialPackCooker().cook({
        guid: GUID,
        source: material,
      }),
    ).rejects.toMatchObject({ code: 'material-physical-contract-invalid' });
  });
});
