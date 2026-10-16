import { resolve } from 'node:path';
import { emit_reflection, parse, parseReflectionWire, validate } from '@forgeax/engine-naga';
import {
  type MaterialShaderArtifactReceipt,
  readShaderManifestPublication,
} from '@forgeax/engine-shader';
import {
  derive,
  MATERIAL_SCENE_ADDRESS_UNIT_BYTES,
  type ParamSchemaEntry,
} from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { forgeaxShader } from '../index.js';

const root = resolve(import.meta.dirname, '../../../..');

describe('Standard template alias publication', () => {
  it('cooks the full physical root without dedicated transmission bindings for WebGL2', async () => {
    const plugin = forgeaxShader({
      engineEntries: false,
      materialPackages: [
        resolve(root, 'apps/hello/physical-material/src/standard-full-physical.pack.json'),
      ],
    });
    const assets: { fileName: string; source: string }[] = [];
    const context = {
      emitFile(asset: { fileName: string; source: string }) {
        assets.push(asset);
        return asset.fileName;
      },
    };
    await plugin.buildStart?.call(context as never);
    plugin.generateBundle?.call(context as never);
    const emitted = assets.find((asset) => asset.fileName === 'shaders/manifest.json');
    expect(emitted).toBeDefined();
    if (emitted === undefined) return;
    const manifest = (await readShaderManifestPublication(JSON.parse(emitted.source))) as {
      materialShaders: {
        variants: {
          defines: Record<string, boolean>;
          composedWgsl: string;
        }[];
      }[];
    };
    const variants = manifest.materialShaders[0]?.variants ?? [];
    const low = variants.filter((variant) => variant.defines.STORAGE_BUFFER_AVAILABLE === false);
    expect(low.length).toBeGreaterThan(0);
    for (const variant of low) {
      expect(variant.composedWgsl).not.toMatch(/var\s+transmissionSampler\b/);
      expect(variant.composedWgsl).not.toMatch(/var\s+transmissionTexture\b/);
      expect(variant.composedWgsl).not.toMatch(/var\s+thicknessTexture\b/);
      expect(variant.composedWgsl).not.toMatch(/var\s+transmissionBackdropTexture\b/);
    }
    expect(
      variants.some(
        (variant) =>
          variant.defines.STORAGE_BUFFER_AVAILABLE === true &&
          /var\s+transmissionTexture\b/.test(variant.composedWgsl),
      ),
    ).toBe(true);
  }, 60_000);

  it.each([
    ['standard-clearcoat-factor-r', false],
    ['skin-clearcoat-factor-r', true],
  ] as const)(
    'retains the template geometry ABI: %s',
    async (file, skinned) => {
      const plugin = forgeaxShader({
        engineEntries: false,
        materialPackages: [resolve(root, `apps/hello/physical-material/src/${file}.pack.json`)],
      });
      const assets: { fileName: string; source: string }[] = [];
      const context = {
        emitFile(asset: { fileName: string; source: string }) {
          assets.push(asset);
          return asset.fileName;
        },
      };
      await plugin.buildStart?.call(context as never);
      plugin.generateBundle?.call(context as never);
      const emitted = assets.find((asset) => asset.fileName === 'shaders/manifest.json');
      expect(emitted).toBeDefined();
      if (emitted === undefined) throw new Error('Alias manifest missing');
      const manifest = (await readShaderManifestPublication(JSON.parse(emitted.source))) as {
        materialShaders: {
          paramSchema: string;
          variants: {
            defines: Record<string, boolean>;
            composedWgsl: string;
            receipt: MaterialShaderArtifactReceipt;
          }[];
        }[];
      };
      expect(manifest.materialShaders).toHaveLength(1);
      const entry = manifest.materialShaders[0];
      if (entry === undefined) throw new Error('Alias material missing');
      const schema = JSON.parse(entry.paramSchema) as readonly ParamSchemaEntry[];
      expect(schema).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'clearcoat', type: 'f32' }),
          expect.objectContaining({ name: 'clearcoatRoughness', type: 'f32' }),
          expect.objectContaining({ name: 'clearcoatTexture', type: 'texture2d' }),
        ]),
      );
      const derived = derive(schema);
      const expectedFields = schema.flatMap((parameter) => {
        if (derived.numericMembers.some((member) => member.name === parameter.name))
          return [parameter.name];
        const coordinates = derived.coordinateRecords.find(
          (record) => record.parameter === parameter.name,
        );
        return coordinates === undefined
          ? []
          : [coordinates.transformMember, coordinates.metadataMember, coordinates.rotationMember];
      });
      const variants = entry.variants;
      expect(variants).toHaveLength(6);
      for (const variant of variants ?? []) {
        expect(variant.receipt.directEntry).toBe('vs_main');
        // This fixture owns 112 numeric bytes and six 48-byte texture-coordinate records.
        expect(variant.receipt.materialRow.byteLength).toBe(400);
        expect(variant.composedWgsl).toMatch(/\.clearcoat\b/);
        expect(variant.composedWgsl).toContain('evaluateClearcoatLayer');
        expect(variant.receipt.resourceSlots).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ parameter: 'clearcoatTexture', kind: 'sampler' }),
            expect.objectContaining({ parameter: 'clearcoatTexture', kind: 'texture' }),
          ]),
        );
        const sceneEntry = /@vertex\s+fn\s+vs_scene_index\s*\(/.test(variant.composedWgsl);
        if (variant.defines.STORAGE_BUFFER_AVAILABLE) {
          expect(variant.receipt.sceneIndexEntry).toBe('vs_scene_index');
          expect(variant.receipt.materialRow.byteLength).toBe(
            Math.max(MATERIAL_SCENE_ADDRESS_UNIT_BYTES, derived.totalBytes),
          );
          expect(variant.receipt.materialRow.addressUnitBytes).toBe(
            MATERIAL_SCENE_ADDRESS_UNIT_BYTES,
          );
          expect(sceneEntry).toBe(variant.defines.GPU_DRIVEN_SCENE_INDEX_AVAILABLE);
        } else {
          expect(variant.receipt.sceneIndexEntry).toBeUndefined();
          expect(variant.receipt.materialRow.byteLength).toBe(derived.totalBytes);
          expect(variant.receipt.materialRow.addressUnitBytes).toBeUndefined();
          expect(sceneEntry).toBe(false);
        }
        if (sceneEntry) {
          const module = (await validate((await parse(variant.composedWgsl)).unwrap())).unwrap();
          try {
            const reflection = parseReflectionWire((await emit_reflection(module, '{}')).unwrap());
            const row = reflection.boundGlobals.find(
              (global) => global.group === 1 && global.binding === 46,
            );
            expect(row).toMatchObject({ span: 400, elementStride: 400, addressSpace: 'storage' });
            expect(row?.members).toEqual(
              expect.arrayContaining([
                expect.objectContaining({ name: 'clearcoat', offset: 92, size: 4 }),
                expect.objectContaining({ name: 'clearcoatRoughness', offset: 96, size: 4 }),
                expect.objectContaining({
                  name: 'clearcoatTextureCoordinatesTransform',
                  offset: 352,
                  size: 16,
                }),
                expect.objectContaining({
                  name: 'clearcoatTextureCoordinatesMetadata',
                  offset: 368,
                  size: 16,
                }),
                expect.objectContaining({
                  name: 'clearcoatTextureCoordinatesRotation',
                  offset: 384,
                  size: 16,
                }),
              ]),
            );
          } finally {
            module.free();
          }
        }
        expect(variant.receipt.materialRow.byteLength % MATERIAL_SCENE_ADDRESS_UNIT_BYTES).toBe(0);
        expect(variant.receipt.materialRow.fields).toEqual(expectedFields);
        expect(variant.receipt?.skinPaletteAddress).toEqual(
          skinned ? { group: 2, binding: 1, stride: 64 } : undefined,
        );
        expect(variant.receipt?.vertexInputs.some((input) => input.semantic === 'skinIndex')).toBe(
          skinned,
        );
        expect(variant.receipt?.vertexInputs.some((input) => input.semantic === 'skinWeight')).toBe(
          skinned,
        );
        expect(variant.receipt?.vertexInputs.some((input) => input.semantic === 'color')).toBe(
          variant.defines.VERTEX_COLOR_AVAILABLE,
        );
      }
    },
    60_000,
  );
});
