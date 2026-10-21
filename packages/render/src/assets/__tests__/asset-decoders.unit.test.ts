import { type AssetDecoderContribution, type AssetDecoderInput, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  materialContribution,
  renderPipelineContribution,
  samplerContribution,
} from '../asset-decoders';

function decode<P>(
  contribution: AssetDecoderContribution<P>,
  payload: unknown,
  refs: readonly string[] = [],
  body?: unknown,
) {
  const bytes = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
  return contribution.decoder.decode({
    envelope: {
      guid: 'owner-decoder',
      kind: contribution.kind.kind,
      payload: { kind: contribution.kind.kind, ...(payload as object) },
      refs,
      artifacts:
        bytes === undefined ? {} : { body: { path: 'body.json', mediaType: 'application/json' } },
    },
    artifacts: { read: async () => ok(bytes ?? new Uint8Array()) },
    signal: new AbortController().signal,
  } as unknown as AssetDecoderInput<P>);
}
const root = { passes: [{ name: 'forward', program: { module: 'test::standard' } }] };

describe('Render owner decoders', () => {
  it.each([
    root,
    { parent: 'root-guid' },
    { parent: new Uint8Array(16).fill(1) },
  ])('preserves root and child static choices %j', async (contract) => {
    const staticSwitches = { clearcoat: true, textures: false };
    expect(
      await decode(materialContribution, {
        ...contract,
        staticSwitches,
        values: { clearcoat: 0.85 },
      }),
    ).toMatchObject({ ok: true, value: { staticSwitches, values: { clearcoat: 0.85 } } });
  });
  it.each([
    null,
    { clearcoat: 1 },
    { unknownLayer: true },
  ])('rejects malformed static choices %j', async (staticSwitches) => {
    expect(await decode(materialContribution, { ...root, staticSwitches })).toMatchObject({
      ok: false,
      error: { code: 'asset-package-invalid' },
    });
  });
  it.each([
    { colorSpace: 'linear' },
    { passes: root.passes },
    { parameters: [{ name: 'roughness', type: 'f32' }] },
    { passes: undefined },
  ])('rejects root fields on a child %j', async (forbidden) => {
    expect(await decode(materialContribution, { parent: 'root-guid', ...forbidden })).toMatchObject(
      { ok: false },
    );
  });
  it('preserves parameter, color, particle and surface contracts', async () => {
    const contract = {
      ...root,
      parameters: [
        { name: 'tint', type: 'color', colorSpace: 'linear' },
        { name: 'flowTexture', type: 'texture' },
      ],
      particleInputs: [{ name: 'heat', type: 'f32', visibility: 'fragment', lane: 0 }],
      values: { tint: [0.2, 0.6, 1, 1] },
      colorSpace: 'linear',
      surface: { shadingModel: 'unlit' },
    };
    expect(await decode(materialContribution, contract)).toMatchObject({
      ok: true,
      value: contract,
    });
  });
  it('resolves parent refs while preserving scalar child values', async () => {
    expect(
      await decode(
        materialContribution,
        {
          parent: 0,
          values: {
            roughness: 1,
            emissionStrength: 0,
            direction: -1,
            albedo: { texture: 1, sampler: 2 },
          },
        },
        ['root', 'texture', 'sampler'],
      ),
    ).toMatchObject({
      ok: true,
      value: {
        parent: 'root',
        values: {
          roughness: 1,
          emissionStrength: 0,
          direction: -1,
          albedo: { texture: 'texture', sampler: 'sampler' },
        },
      },
    });
    expect(await decode(materialContribution, { parent: 9 }, ['root'])).toMatchObject({
      ok: false,
    });
  });
  it('uses only the authored schema to distinguish bare texture refs from scalar integers', async () => {
    const values = { metallic: 0, baseColorTexture: 0 };
    expect(
      await decode(
        materialContribution,
        {
          ...root,
          parameters: [
            { name: 'metallic', type: 'f32' },
            { name: 'baseColorTexture', type: 'texture' },
          ],
          values,
        },
        ['texture'],
      ),
    ).toMatchObject({
      ok: true,
      value: { values: { metallic: 0, baseColorTexture: { texture: 'texture' } } },
    });
    for (const parameters of [undefined, [], [{ name: 'metallic', type: 'f32' }]]) {
      expect(
        await decode(materialContribution, { ...root, parameters, values }, ['texture']),
      ).toMatchObject({ ok: true, value: { values } });
    }
  });
  it('resolves explicit textures without a shader registry and preserves nonidentity coordinates', async () => {
    const coordinates = { set: 2, transform: { scale: [2, 3] } };
    expect(
      await decode(
        materialContribution,
        {
          ...root,
          parameters: [],
          values: {
            metallic: 0,
            transmissionTexture: { texture: 0, sampler: 1, coordinates },
            thicknessTexture: {
              texture: 0,
              coordinates: { set: 0, transform: { offset: [0, 0], scale: [1, 1], rotation: 0 } },
            },
          },
        },
        ['texture', 'sampler'],
      ),
    ).toMatchObject({
      ok: true,
      value: {
        values: {
          metallic: 0,
          transmissionTexture: { texture: 'texture', sampler: 'sampler', coordinates },
          thicknessTexture: { texture: 'texture' },
        },
      },
    });
  });
  it.each([
    { texture: 4 },
    { texture: 0, sampler: -1 },
  ])('rejects out-of-range texture references %j', async (value) => {
    expect(
      await decode(materialContribution, { ...root, values: { albedo: value } }, ['texture']),
    ).toMatchObject({ ok: false });
  });
  it('preserves the complete sampler descriptor', async () => {
    const sampler = {
      addressModeU: 'repeat',
      addressModeV: 'mirror-repeat',
      addressModeW: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
      lodMinClamp: 0,
      lodMaxClamp: 12,
      maxAnisotropy: 16,
      compare: 'less-equal',
    };
    expect(await decode(samplerContribution, sampler)).toMatchObject({ ok: true, value: sampler });
  });
  it.each([
    { addressModeU: 'invalid' },
    { maxAnisotropy: '16' },
    { lodMinClamp: Infinity },
    { compare: 'invalid' },
    { minFilter: 'cubic' },
  ])('rejects malformed sampler values %j', async (value) => {
    expect(await decode(samplerContribution, value)).toMatchObject({ ok: false });
  });
  it('reads the actual pipeline artifact and preserves output switches', async () => {
    const artifact = {
      kind: 'render-pipeline',
      pipelineId: 'forgeax::standard',
      renderPath: 'deferred',
      config: {
        outputDither: false,
        gpuOcclusion: true,
        passCount: 2,
        clusterGrid: { x: 16, y: 8, z: 24 },
        ssao: { enabled: true },
        postEffects: ['bloom'],
      },
    };
    expect(
      await decode(renderPipelineContribution, { pipelineId: 'forgeax::standard' }, [], artifact),
    ).toMatchObject({ ok: true, value: artifact });
    expect(await decode(renderPipelineContribution, artifact)).toMatchObject({
      ok: true,
      value: artifact,
    });
  });
  it.each([
    { passCount: 0 },
    { outputDither: 1 },
    { clusterGrid: { x: 65, y: 2, z: 2 } },
    { ssao: { enabled: 'yes' } },
    { gpuOcclusion: 1 },
    { postEffects: [''] },
  ])('rejects malformed pipeline config in inline and artifact sources %j', async (config) => {
    const value = { kind: 'render-pipeline', pipelineId: 'forgeax::standard', config };
    expect(await decode(renderPipelineContribution, value)).toMatchObject({ ok: false });
    expect(await decode(renderPipelineContribution, {}, [], value)).toMatchObject({ ok: false });
  });
  it.each([
    { pipelineId: 1 },
    { pipelineId: 'unknown' },
    { pipelineId: 'forgeax::standard', renderPath: 'other' },
  ])('rejects malformed pipeline identity %j', async (value) => {
    expect(await decode(renderPipelineContribution, value)).toMatchObject({ ok: false });
  });
});
