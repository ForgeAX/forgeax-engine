import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attachRecorder } from '@forgeax/engine-rhi-debug';
import * as webgpu from '@forgeax/engine-rhi-webgpu';
import { assert, expect, it } from 'vitest';
import { referenceSurfaceMaterialSnapshot } from '../../raytracing/material-bindings';
import {
  CARD_PLANES,
  prepareSurfaceCapture,
  type SurfaceCapture,
  type SurfaceCaptureSource,
  surfaceCardKey,
} from '../../raytracing/surface-cards';
import {
  cardParameterExpected,
  cardParameterSource,
  cardTilePlanes,
  cardParameterValues as values,
} from './custom-surface-card-parameters.fixture';
import {
  assessNumericPlanes,
  numericCardCases,
  numericCardFixture,
  numericTransform,
  saveNumericPlanes,
} from './custom-surface-cards.fixture';
import { readCardPlanes } from './sdf-cards.fixture';

const diagnostic = process.env.FORGEAX_CUSTOM_CARD_PARAMETER_DIAGNOSTICS === '1' ? it : it.skip;

diagnostic(
  'keeps shared custom material planes coherent across one-tile parameter updates',
  async () => {
    const directory = process.env.FORGEAX_CUSTOM_CARD_PARAMETER_EVIDENCE;
    if (directory) await mkdir(directory, { recursive: true });
    const fixture = await numericCardFixture({ source: cardParameterSource(), values: values[0] });
    const originalMaterial = fixture.source.sections[0]?.material;
    assert(originalMaterial);
    const snapshot = referenceSurfaceMaterialSnapshot(originalMaterial);
    const sources: SurfaceCaptureSource[] = [numericCardCases[0], numericCardCases[2]].map(
      (context, index) => {
        const source = {
          ...fixture.source,
          instance: {
            ...fixture.source.instance,
            instanceId: 7 + index,
            transform: numericTransform(context),
          },
        };
        return {
          instance: source.instance,
          layout: source.layout,
          captureKey: surfaceCardKey(source),
          sections: source.sections.map((section) => ({
            indexOffset: section.indexOffset,
            indexCount: section.indexCount,
            material: {
              id: originalMaterial.id,
              identity: snapshot,
              snapshot,
              program: {
                source: originalMaterial.program.wgsl,
                paramSchema: originalMaterial.program.paramSchema,
              },
            },
          })),
        };
      },
    );
    const recorder = attachRecorder(webgpu).unwrap();
    const adapter = (await recorder.backend.rhi.requestAdapter()).unwrap();
    const device = (await adapter.requestDevice()).unwrap();
    const native = device.nativeDevice().unwrap() as GPUDevice;
    const errors: string[] = [];
    native.addEventListener('uncapturederror', (event) => errors.push(event.error.message));
    let capture: SurfaceCapture | undefined;
    const records: unknown[] = [];
    const assess = async (
      name: string,
      planes: readonly Uint8Array[],
      versions: readonly number[],
    ) => {
      assert(capture);
      for (let tile = 0; tile < 2; tile++) {
        const version = versions[tile],
          context = tile === 0 ? numericCardCases[0] : numericCardCases[2];
        assert(version !== undefined && values[version]);
        const actual = cardTilePlanes(planes, capture, tile),
          expected = cardParameterExpected(values[version]);
        await saveNumericPlanes(
          directory,
          `${name}-tile${tile}-v${version}`,
          actual,
          context,
          expected,
        );
        const result = assessNumericPlanes(actual, context, expected);
        records.push({ name, tile, version, ...result });
        expect(result.invalid).toBe(0);
        expect(result.maximumError).toBeLessThanOrEqual(result.tolerance);
      }
    };
    const drawTile = async (tile: number) => {
      const current = capture;
      assert(current);
      const tiles = { first: tile, count: 1 };
      current.prepareTiles(tiles);
      const encoder = device.createCommandEncoder({ label: 'custom-card-parameter-tile' }).unwrap();
      const pass = encoder.beginRenderPass({
        colorAttachments: CARD_PLANES.map((name) => ({
          view: current.views[name],
          loadOp: 'load' as const,
          storeOp: 'store' as const,
        })),
        depthStencilAttachment: {
          view: current.views.depth,
          depthLoadOp: 'load',
          depthStoreOp: 'store',
        },
      });
      current.clearTiles(pass, tiles).unwrap();
      current.recordPass(pass, tiles).unwrap();
      pass.end();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      return readCardPlanes(device, current);
    };
    try {
      capture = (
        await prepareSurfaceCapture(device, recorder.backend.createShaderModule, sources, {
          kind: 'cards',
          resolution: 32,
        })
      ).unwrap();
      // Preparation initializes the shared row; this counter covers later uploads.
      expect(capture.materialWork.uniformUploads).toBe(0);
      const encoder = device.createCommandEncoder({}).unwrap();
      capture.record(encoder).unwrap();
      device.queue.submit([encoder.finish().unwrap()]).unwrap();
      const initial = await readCardPlanes(device, capture);
      await assess('initial', initial, [0, 0]);
      // An omitted parameter adoption would leave this actual GPU state behind.
      const stale = cardTilePlanes(initial, capture, 0),
        expectedChanged = cardParameterExpected(values[1]);
      await saveNumericPlanes(
        directory,
        'negative-skipped-update',
        stale,
        numericCardCases[0],
        expectedChanged,
      );
      const staleResult = assessNumericPlanes(stale, numericCardCases[0], expectedChanged);
      records.push({ name: 'negative-skipped-update', tile: 0, version: 1, ...staleResult });
      expect(staleResult.invalid).toBe(0);
      expect(staleResult.maximumError).toBeGreaterThan(0.1);
      const adopt = (version: number) => {
        const current = capture;
        assert(current);
        const value = values[version];
        assert(value);
        const work = current
          .adoptMaterial(snapshot, {
            ...snapshot,
            paramSnapshot: { ...snapshot.paramSnapshot, ...value },
          })
          .unwrap();
        expect(work?.tiles).toBe(2);
      };
      adopt(1);
      await assess('partial-B', await drawTile(0), [1, 0]);
      adopt(2);
      await assess('superseded-B', await drawTile(1), [1, 2]);
      await assess('complete-C', await drawTile(0), [2, 2]);
      const invalid = capture.adoptMaterial(snapshot, {
        ...snapshot,
        paramSnapshot: { ...snapshot.paramSnapshot, roughness: NaN },
      });
      expect(invalid.ok).toBe(false);
      await assess('rejected-invalid-keeps-C', await drawTile(1), [2, 2]);
      expect(capture.materialWork).toEqual({
        roots: 2,
        drawVisits: 6,
        uniformUploads: 2,
        assetRoots: 0,
        bindingRefreshes: 0,
      });
    } finally {
      try {
        capture?.dispose();
      } finally {
        try {
          (await recorder.dispose()).unwrap();
        } finally {
          try {
            if (directory)
              await writeFile(
                join(directory, 'assessment.json'),
                JSON.stringify(
                  {
                    scope:
                      'Shared material root and sparse native Card plane updates only; no Renderer scheduler, textures, final GI or performance qualification',
                    adapter: native.adapterInfo,
                    records,
                    materialWork: capture?.materialWork,
                    errors,
                  },
                  null,
                  2,
                ),
              );
          } finally {
            expect.soft(errors).toEqual([]);
          }
        }
      }
    }
  },
  90_000,
);
