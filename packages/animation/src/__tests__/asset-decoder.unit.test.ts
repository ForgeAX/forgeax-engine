import { type AssetDecoderContribution, type AssetDecoderInput, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { animationClipContribution, animationGraphContribution } from '../assets/animation-decoder';

async function decoded<P>(
  contribution: AssetDecoderContribution<P>,
  payload: object,
  refs: readonly string[] = [],
): Promise<P | undefined> {
  const result = await contribution.decoder.decode({
    envelope: {
      guid: 'decoder-test',
      kind: contribution.kind.kind,
      payload: { kind: contribution.kind.kind, ...payload },
      refs,
      artifacts: {},
    },
    artifacts: { read: async () => ok(new Uint8Array()) },
    signal: new AbortController().signal,
  } as unknown as AssetDecoderInput<P>);
  if (!result.ok) expect(result.error.code).toBe('asset-package-invalid');
  return result.ok ? result.value : undefined;
}
function requireValue<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing fixture value');
  return value;
}
describe('animationClipContribution', async () => {
  it('retains cubic tangents through JSON Cook transport and rejects malformed samplers', async () => {
    const payload = {
      duration: 2,
      channels: [
        {
          targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
          property: 'translation',
          sampler: {
            input: [0, 2],
            output: [0, 0, 0, 0, 0, 0, 3, 0, 0, -3, 0, 0, 0, 0, 0, 0, 0, 0],
            interpolation: 'CUBICSPLINE',
          },
        },
      ],
    };
    const loaded = (await decoded(
      animationClipContribution,
      JSON.parse(JSON.stringify(payload)),
    )) as unknown as {
      channels: { sampler: { input: Float32Array; output: Float32Array; interpolation: string } }[];
    };
    expect(loaded.channels[0]?.sampler).toEqual({
      input: new Float32Array([0, 2]),
      output: new Float32Array(requireValue(payload.channels[0]).sampler.output),
      interpolation: 'CUBICSPLINE',
    });
    for (const sampler of [
      { input: [0, 0], output: requireValue(payload.channels[0]).sampler.output },
      { input: [0, 2], output: [0, 0, 0, 1, 2, 3] },
      {
        input: [0, 2],
        output: [...requireValue(payload.channels[0]).sampler.output.slice(0, -1), NaN],
      },
    ])
      expect(
        await decoded(animationClipContribution, {
          ...payload,
          channels: [
            { ...payload.channels[0], sampler: { ...sampler, interpolation: 'CUBICSPLINE' } },
          ],
        }),
      ).toBeUndefined();
  });
  it('retains property bindings and STEP values across the JSON transport', async () => {
    const channel = (output: unknown, interpolation = 'STEP') => ({
      targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
      property: 'property',
      binding: 'state',
      sampler: { input: [0, 1], output, interpolation },
    });
    for (const output of [
      [false, true],
      ['idle', 'run'],
      [0, 1],
    ]) {
      const raw = JSON.parse(JSON.stringify({ duration: 1, channels: [channel(output)] }));
      const clip = (await decoded(animationClipContribution, raw)) as unknown as {
        channels: [{ binding: string; sampler: { output: ArrayLike<unknown> } }];
      };
      expect(clip.channels[0].binding).toBe('state');
      expect(Array.from(clip.channels[0].sampler.output)).toEqual(output);
    }
    expect(
      await decoded(animationClipContribution, { channels: [channel(['idle', 'run'], 'LINEAR')] }),
    ).toBeUndefined();
    expect(
      await decoded(animationClipContribution, { channels: [{ ...channel([0, 1]), binding: '' }] }),
    ).toBeUndefined();
  });
  it('accepts a valid channel with LINEAR sampler arrays', async () => {
    const out = await decoded(animationClipContribution, {
      duration: 1,
      channels: [
        {
          targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
          property: 'translation',
          sampler: { input: [0, 1], output: [0, 0, 0, 1, 1, 1], interpolation: 'LINEAR' },
        },
      ],
    });
    expect((out as { kind?: string }).kind).toBe('animation-clip');
  });

  it('rejects legacy, dual, and malformed target wires', async () => {
    const sampler = { input: [0], output: [0, 0, 0], interpolation: 'LINEAR' };
    const loadChannel = async (channel: Record<string, unknown>) =>
      await decoded(animationClipContribution, {
        channels: [{ ...channel, property: 'translation', sampler }],
      });

    expect(await loadChannel({ targetPath: ['root'] })).toBeUndefined();
    expect(
      await loadChannel({
        targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
        targetPath: ['root'],
      }),
    ).toBeUndefined();
    expect(await loadChannel({ targetId: 'A95DA0EC669159F98273E8F86D8AD9F2' })).toBeUndefined();
    expect(await loadChannel({ targetId: 'a95da0ec669159f98273e8f86d8ad9f' })).toBeUndefined();
  });

  it('rejects a bad property / missing sampler / bad interpolation', async () => {
    expect(
      await decoded(animationClipContribution, {
        channels: [{ targetId: 'a95da0ec669189f98273e8f86d8ad9f2', property: 'bogus' }],
      }),
    ).toBeUndefined();
    expect(
      await decoded(animationClipContribution, {
        channels: [{ targetId: 'a95da0ec669189f98273e8f86d8ad9f2', property: 'scale' }],
      }),
    ).toBeUndefined();
    expect(
      await decoded(animationClipContribution, {
        channels: [
          {
            targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
            property: 'scale',
            sampler: { input: [0], output: [0], interpolation: 'CUBIC' },
          },
        ],
      }),
    ).toBeUndefined();
  });

  it('rejects a non-array channels payload', async () => {
    expect(await decoded(animationClipContribution, { channels: 'bad' })).toBeUndefined();
  });
});

it('resolves graph clip refs and enforces every node-table address', async () => {
  const clip = { type: 'clip', clip: 0, weight: 1 };
  const nodes = [
    clip,
    { type: 'blend', children: [0], weight: 1 },
    { type: 'add', base: 0, additive: [1], weight: 1 },
  ];
  expect(
    await decoded(animationGraphContribution, { root: 2, nodes }, ['clip-guid']),
  ).toMatchObject({ root: 2, nodes: [{ ...clip, clip: 'clip-guid' }, nodes[1], nodes[2]] });
  for (const graph of [
    { root: 3, nodes },
    { root: -1, nodes },
    { root: 0, nodes: [{ ...clip, clip: 2 }] },
    { root: 0, nodes: [{ type: 'blend', children: [1], weight: 1 }] },
    { root: 0, nodes: [{ type: 'add', base: 1, additive: [], weight: 1 }] },
    { root: 0, nodes: [{ type: 'add', base: 0, additive: [1], weight: 1 }] },
    { root: 0, nodes: [{ ...clip, weight: NaN }] },
  ])
    expect(await decoded(animationGraphContribution, graph, ['clip-guid'])).toBeUndefined();
});

it('rejects malformed discrete sample counts and validates timeline events after sampler normalization', async () => {
  const channel = {
    targetId: 'a95da0ec669189f98273e8f86d8ad9f2',
    property: 'property',
    binding: 'state',
    sampler: { input: [0, 1], output: ['one'], interpolation: 'STEP' },
  };
  expect(
    await decoded(animationClipContribution, { duration: 1, channels: [channel] }),
  ).toBeUndefined();
  const clip = {
    duration: 1,
    channels: [],
    events: [
      { time: 2, targetId: channel.targetId, action: { kind: 'method', name: 'fire', args: [] } },
    ],
  };
  expect(await decoded(animationClipContribution, clip)).toBeUndefined();
});
