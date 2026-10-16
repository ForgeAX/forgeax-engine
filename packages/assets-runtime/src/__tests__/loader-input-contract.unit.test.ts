import { describe, expect, it, vi } from 'vitest';
import { LoaderRegistry, type PackLoaderInput } from '../loader-registry';
import { renderPipelineLoader, tilesetLoader } from '../loaders/pack-artifact';

const input: PackLoaderInput = {
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'host-blob',
  payload: { value: 1 },
  refs: [],
  artifacts: {
    source: {
      descriptor: { path: 'source.bin', mediaType: 'application/octet-stream' },
      bytes: Uint8Array.of(1, 2),
    },
  },
};

describe('uniform Pack v2 loader input', () => {
  it('contains asset-local artifacts and no catalog transport facts', () => {
    expect(input.artifacts.source?.bytes).toEqual(Uint8Array.of(1, 2));
    expect(input).not.toHaveProperty('packageUrl');
    expect(input).not.toHaveProperty('packageUrl');
  });

  it('dispatches one uniform input to the registered kind loader', async () => {
    const load = vi.fn().mockResolvedValue({ ok: true, value: { kind: 'host-blob' } });
    const registry = new LoaderRegistry();
    registry.registerPackLoader({ kind: 'host-blob', load });
    const result = await registry.loadPack(input, {} as never);
    expect(result.ok).toBe(true);
    expect(load).toHaveBeenCalledWith(input, {});
  });

  it('rejects a malformed render-pipeline artifact descriptor', async () => {
    const result = await renderPipelineLoader.loadPack?.(
      {
        guid: input.guid,
        kind: 'render-pipeline',
        payload: { kind: 'render-pipeline', pipelineId: 'forgeax::standard' },
        refs: [],
        artifacts: {
          body: {
            descriptor: { path: 'pipeline.json', mediaType: 'application/json' },
            bytes: new TextEncoder().encode(
              JSON.stringify({
                kind: 'render-pipeline',
                pipelineId: 'forgeax::standard',
                config: { passCount: 0 },
              }),
            ),
          },
        },
      },
      {} as never,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('round-trips the render-pipeline output dither switch', async () => {
    const result = await renderPipelineLoader.loadPack?.(
      {
        guid: input.guid,
        kind: 'render-pipeline',
        payload: { kind: 'render-pipeline', pipelineId: 'forgeax::standard' },
        refs: [],
        artifacts: {
          body: {
            descriptor: { path: 'pipeline.json', mediaType: 'application/json' },
            bytes: new TextEncoder().encode(
              JSON.stringify({
                kind: 'render-pipeline',
                pipelineId: 'forgeax::standard',
                config: { outputDither: false },
              }),
            ),
          },
        },
      },
      {} as never,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { config: { outputDither: false } },
    });
  });

  it('rejects a non-boolean render-pipeline output dither switch', async () => {
    const result = await renderPipelineLoader.loadPack?.(
      {
        guid: input.guid,
        kind: 'render-pipeline',
        payload: { kind: 'render-pipeline', pipelineId: 'forgeax::standard' },
        refs: [],
        artifacts: {
          body: {
            descriptor: { path: 'pipeline.json', mediaType: 'application/json' },
            bytes: new TextEncoder().encode(
              JSON.stringify({
                kind: 'render-pipeline',
                pipelineId: 'forgeax::standard',
                config: { outputDither: 1 },
              }),
            ),
          },
        },
      },
      {} as never,
    );
    expect(result).toMatchObject({ ok: false });
  });

  it('rejects a tileset artifact whose atlas list differs from envelope refs', async () => {
    const refs = ['atlas-a', 'atlas-b'];
    const result = await tilesetLoader.loadPack?.(
      {
        guid: input.guid,
        kind: 'tileset',
        payload: { kind: 'tileset' },
        refs,
        artifacts: {
          body: {
            descriptor: { path: 'tileset.json', mediaType: 'application/json' },
            bytes: new TextEncoder().encode(
              JSON.stringify({
                kind: 'tileset',
                atlases: ['atlas-a', 'atlas-other'],
                tileWidth: 1,
                tileHeight: 1,
                columns: 1,
                rows: 1,
                regions: [{ x: 0, y: 0, width: 1, height: 1 }],
                tiles: [{ regionIndex: 0 }],
              }),
            ),
          },
        },
      },
      {} as never,
    );
    expect(result).toMatchObject({ ok: false });
  });
});
