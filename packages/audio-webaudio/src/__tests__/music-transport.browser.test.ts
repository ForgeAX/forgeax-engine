import { createAudioIntentBackend, type MusicPreparation } from '@forgeax/engine-audio';
import { expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import { createHostAudioConsumer, createWebAudioBackend } from '../host-audio-consumer';
import { WebAudioEngine } from '../web-audio-engine';
import { pcmWav } from './support-tone';

const RATE = 48000;
it('keeps generic Host consumption lazy and accepts an ordinary graph without a music bus', async () => {
  const context = new OfflineAudioContext(1, RATE, RATE);
  const engine = new WebAudioEngine({ context });
  const consumer = createHostAudioConsumer(engine);
  try {
    expect(consumer.state().music?.phase).toBe('empty');
    const buses = [
      { id: 'master', parent: null },
      { id: 'voice', parent: 'master' },
      { id: 'room', parent: 'master' },
      { id: 'outside', parent: 'master' },
    ];
    expect(engine.configureBuses(buses).ok).toBe(true);
    expect(consumer.state().music?.nodes).toBe(0);
    const buffer = context.createBuffer(1, RATE, RATE);
    buffer.getChannelData(0).fill(0.1);
    engine.play(1, buffer, { loop: false, volume: 1, spatialBlend: 0, bus: 'voice' });
    expect(engine.configureBuses(buses).ok).toBe(true);
    expect((await context.startRendering()).getChannelData(0)[24000]).toBeCloseTo(0.1, 5);
  } finally {
    consumer.dispose();
  }
});

function score(count = 4): MusicPreparation {
  return {
    bpm: 120,
    beatsPerBar: 4,
    loopBeats: 4,
    stems: Array.from({ length: count }, (_, stem) => {
      const pcm = new Float32Array(RATE * 2);
      for (let beat = 0; beat < 4; beat++) pcm[(beat * RATE) / 2 + stem * 32] = (stem + 1) / 32;
      return {
        clip: {
          kind: 'audio',
          sourceKey: `impulse-${stem}`,
          mediaType: 'audio/wav',
          bytes: pcmWav(pcm),
        },
      };
    }),
  };
}
async function fixture(seconds = 3, count = 4) {
  const context = new OfflineAudioContext(1, RATE * seconds, RATE);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(structuredClone(intent)),
    state: () => consumer.state(),
  });
  consumer.prepareMusic(1, score(count));
  await expect.poll(() => backend.getState().music?.phase).toBe('ready');
  const epoch = backend.getState().music?.epoch ?? -1;
  return { context, consumer, backend, epoch };
}

it('prepares ordinary clips locally through the public Host backend and renders its scheduled PCM', async () => {
  const context = new OfflineAudioContext(1, RATE, RATE);
  const backend = createWebAudioBackend(new WebAudioEngine({ context }));
  try {
    const authored = score(1);
    const encoded = authored.stems[0]?.clip.bytes;
    if (!encoded) throw new Error('fixture must provide ordinary WAV bytes');
    const independentInput = await context.decodeAudioData(encoded.slice().buffer as ArrayBuffer);
    backend.music({ kind: 'prepare', requestId: 1, score: authored });
    await expect.poll(() => backend.getState().music?.phase).toBe('ready');
    backend.music({
      kind: 'mix',
      requestId: 2,
      epoch: backend.getState().music?.epoch ?? -1,
      gains: [1],
      boundary: 'beat',
      atBeat: 0,
      late: 'reject',
    });
    const pcm = (await context.startRendering()).getChannelData(0);
    expect(pcm[960]).toBeCloseTo(independentInput.getChannelData(0)[0] ?? NaN, 6);
  } finally {
    backend.destroy();
  }
});

for (const atBeat of [1e308, Number.MAX_SAFE_INTEGER])
  it(`rejects an unrepresentable native target ${atBeat} without retiring accepted music`, async () => {
    const { context, consumer, backend, epoch } = await fixture(1, 1);
    try {
      const bytes = score(1).stems[0]?.clip.bytes;
      if (!bytes) throw new Error('native target fixture requires ordinary WAV bytes');
      const input = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
      const expected = input.getChannelData(0)[0] ?? NaN;
      backend.music({
        kind: 'mix',
        requestId: 2,
        epoch,
        gains: [1],
        boundary: 'beat',
        atBeat: 0,
        late: 'reject',
      });
      const before = backend.getState().music;
      backend.music({
        kind: 'mix',
        requestId: 3,
        epoch,
        gains: [0.5],
        boundary: 'beat',
        atBeat,
        late: 'reject',
      });
      const after = backend.getState().music;
      const pcm = (await context.startRendering()).getChannelData(0);
      console.info(
        'native target admission',
        JSON.stringify({ atBeat, before, after, sample: 960, actual: pcm[960], expected }),
      );
      expect(after?.receipts.find((row) => row.requestId === 3)?.failure?.code).toBe(
        'invalid-command',
      );
      expect(after?.epoch).toBe(before?.epoch);
      expect(after?.pending).toBe(1);
      expect(after?.nodes).toBe(2);
      expect(after?.receipts.find((row) => row.requestId === 2)?.status).toBe('scheduled');
      expect(pcm[960]).toBeCloseTo(expected, 6);
    } finally {
      consumer.dispose();
    }
  });

it('reports not-ready and native decode failure without scheduling a partial score', async () => {
  const context = new OfflineAudioContext(1, RATE, RATE);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  try {
    consumer.consume({
      kind: 'music',
      command: {
        kind: 'mix',
        requestId: 1,
        epoch: 0,
        gains: [1],
        boundary: 'beat',
        atBeat: 0,
        late: 'reject',
      },
    });
    expect(consumer.state().music?.receipts[0]?.failure?.code).toBe('not-ready');
    const declared = score(2);
    consumer.prepareMusic(2, {
      ...declared,
      stems: [
        ...declared.stems.slice(0, 1),
        {
          clip: {
            kind: 'audio',
            sourceKey: 'invalid-decode',
            mediaType: 'audio/wav',
            bytes: new Uint8Array([1, 2, 3, 4]),
          },
        },
      ],
    });
    await expect
      .poll(
        () => consumer.state().music?.receipts.find((row) => row.requestId === 2)?.failure?.code,
      )
      .toBe('decode-failed');
    expect(consumer.state().music?.nodes).toBe(0);
    expect(consumer.state().music?.pending).toBe(0);
    const pcm = (await context.startRendering()).getChannelData(0);
    expect(pcm.every((value) => value === 0)).toBe(true);
  } finally {
    consumer.dispose();
  }
});

it('applies all 101 beat changes to the independently decoded native impulse sample', async () => {
  const context = new OfflineAudioContext(1, RATE * 56, RATE);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  try {
    const authored = score(1);
    const bytes = authored.stems[0]?.clip.bytes;
    if (!bytes) throw new Error('native impulse fixture needs WAV bytes');
    const input = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    consumer.prepareMusic(1, authored);
    await expect.poll(() => consumer.state().music?.phase).toBe('ready');
    const epoch = consumer.state().music?.epoch ?? -1;
    for (let beat = 0; beat <= 100; beat++)
      consumer.consume({
        kind: 'music',
        command: {
          kind: 'mix',
          requestId: beat + 2,
          epoch,
          boundary: 'beat',
          atBeat: beat,
          late: 'reject',
          gains: [beat % 2 ? 0.5 : 1],
        },
      });
    expect(consumer.state().music?.pending).toBe(101);
    const pcm = (await context.startRendering()).getChannelData(0);
    for (let beat = 0; beat <= 100; beat++)
      expect(pcm[960 + beat * 24000], `native impulse gain at beat ${beat}`).toBeCloseTo(
        (input.getChannelData(0)[0] ?? NaN) * (beat % 2 ? 0.5 : 1),
        6,
      );
  } finally {
    consumer.dispose();
  }
});

it('starts all prepared ordinary stems on one native sample and changes a complete layer mix on the next bar', async () => {
  const { context, consumer, backend, epoch } = await fixture();
  try {
    backend.music({
      kind: 'mix',
      requestId: 2,
      epoch,
      gains: [1, 1, 1, 1],
      boundary: 'beat',
      atBeat: 0,
      late: 'reject',
    });
    backend.music({
      kind: 'mix',
      requestId: 3,
      epoch,
      gains: [0, 0, 1, 0],
      boundary: 'bar',
      late: 'reject',
    });
    const receipts = backend.getState().music?.receipts ?? [];
    expect(receipts[1]?.status).toBe('scheduled');
    expect(receipts[1]?.targetTime).toBe(0.02);
    expect(receipts[2]?.targetTime).toBe(2.02);
    const pcm = (await context.startRendering()).getChannelData(0);
    const normalizedOnsets = [];
    for (let stem = 0; stem < 4; stem++) {
      const expected = 960 + stem * 32;
      const actual = pcm.findIndex(
        (value, sample) => sample >= expected - 2 && sample <= expected + 2 && value > 0.01,
      );
      expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1);
      normalizedOnsets.push(actual - stem * 32);
      const atBar = 96960 + stem * 32;
      expect(pcm[atBar]).toBeCloseTo(stem === 2 ? Math.round((3 / 32) * 32767) / 32768 : 0, 5);
    }
    expect(Math.max(...normalizedOnsets) - Math.min(...normalizedOnsets)).toBeLessThanOrEqual(1);
  } finally {
    consumer.dispose();
  }
});

it('cancels native gain automation, preserves duplicate identity and rejects stale epochs', async () => {
  const { context, consumer, backend, epoch } = await fixture(2, 1);
  try {
    const mix = {
      kind: 'mix',
      requestId: 2,
      epoch,
      gains: [1],
      boundary: 'beat',
      atBeat: 1,
      late: 'reject',
    } as const;
    backend.music(mix);
    backend.music(mix);
    expect(backend.getState().music?.pending).toBe(1);
    backend.music({ kind: 'cancel', requestId: 3, epoch, cancelRequestId: 2 });
    backend.music({ kind: 'pause', requestId: 4, epoch });
    backend.music({ ...mix, requestId: 5 });
    expect(
      backend.getState().music?.receipts.find((item) => item.requestId === 5)?.failure?.code,
    ).toBe('stale-epoch');
    const pcm = (await context.startRendering()).getChannelData(0);
    expect(pcm.every((value) => value === 0)).toBe(true);
    expect(backend.getState().music?.nodes).toBe(0);
  } finally {
    consumer.dispose();
  }
});

it('rejects late requests and reports explicit next-boundary deferral after native clock advance', async () => {
  const { context, consumer, backend, epoch } = await fixture(2, 1);
  try {
    const suspension = context.suspend(0.5);
    const rendered = context.startRendering();
    await suspension;
    const mix = {
      kind: 'mix',
      requestId: 2,
      epoch,
      gains: [1],
      boundary: 'beat',
      atBeat: 1,
      late: 'reject',
    } as const;
    backend.music(mix);
    expect(backend.getState().music?.receipts.at(-1)?.failure?.code).toBe('missed-boundary');
    backend.music({ ...mix, requestId: 3, late: 'next-boundary' });
    expect(backend.getState().music?.receipts.at(-1)?.deferred).toBe(true);
    expect(backend.getState().music?.receipts.at(-1)?.targetTime).toBe(1.02);
    await context.resume();
    const pcm = (await rendered).getChannelData(0);
    expect(pcm.slice(0, 48000).every((value) => value === 0)).toBe(true);
    expect(pcm[48960]).toBeGreaterThan(0.01);
  } finally {
    consumer.dispose();
  }
});

it('bounds pending schedules before changing native automation and clears all nodes on destroy', async () => {
  const { consumer, backend, epoch } = await fixture(2, 16);
  try {
    for (let index = 0; index < 129; index++)
      backend.music({
        kind: 'mix',
        requestId: index + 2,
        epoch,
        gains: Array.from({ length: 16 }, () => 0.25),
        boundary: 'beat',
        atBeat: index + 1,
        late: 'reject',
      });
    const state = backend.getState().music;
    expect(state?.pending).toBe(128);
    expect(state?.nodes).toBe(32);
    expect(state?.receipts.at(-1)?.failure?.code).toBe('capacity');
    backend.destroy();
    expect(consumer.state().music?.nodes).toBe(0);
    expect(consumer.state().music?.pending).toBe(0);
  } finally {
    consumer.dispose();
  }
});

it('fails the same PCM alignment oracle for immediate staggered stem starts', async () => {
  const context = new OfflineAudioContext(1, RATE, RATE);
  const buffers = await Promise.all(
    score().stems.map((stem) =>
      context.decodeAudioData((stem.clip.bytes ?? new Uint8Array()).slice().buffer),
    ),
  );
  for (const [index, buffer] of buffers.entries()) {
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(context.destination);
    node.start(0.02 + index / 60);
  }
  const pcm = (await context.startRendering()).getChannelData(0);
  const onsets = buffers.map((_, index) => {
    const expected = Math.round((0.02 + index / 60) * RATE) + index * 32;
    return (
      pcm.findIndex(
        (value, sample) => sample >= expected - 2 && sample <= expected + 2 && value > 0.01,
      ) -
      index * 32
    );
  });
  expect(Math.max(...onsets) - Math.min(...onsets)).toBeGreaterThan(1);
});

it('matches an independent sample envelope and preserves beat/gain through pause, resume and tempo epoch changes', async () => {
  const context = new OfflineAudioContext(1, RATE * 3, RATE);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(intent),
    state: () => consumer.state(),
  });
  const constant = new Float32Array(RATE * 2).fill(0.2);
  consumer.prepareMusic(1, {
    bpm: 120,
    beatsPerBar: 4,
    loopBeats: 4,
    stems: [
      {
        clip: {
          kind: 'audio',
          sourceKey: 'constant',
          mediaType: 'audio/wav',
          bytes: pcmWav(constant),
        },
      },
    ],
  });
  await expect.poll(() => backend.getState().music?.phase).toBe('ready');
  let epoch = backend.getState().music?.epoch ?? -1;
  backend.music({
    kind: 'mix',
    requestId: 2,
    epoch,
    boundary: 'beat',
    atBeat: 0,
    late: 'reject',
    gains: [1],
  });
  backend.music({
    kind: 'mix',
    requestId: 3,
    epoch,
    boundary: 'beat',
    atBeat: 1,
    late: 'reject',
    gains: [0],
    fadeBeats: 1,
  });
  backend.music({
    kind: 'mix',
    requestId: 4,
    epoch,
    boundary: 'beat',
    atBeat: 4,
    late: 'reject',
    gains: [1],
  });
  const pause = context.suspend(0.75),
    resume = context.suspend(1.25),
    tempo = context.suspend(1.75);
  const rendering = context.startRendering();
  try {
    await pause;
    const pauseAt = context.currentTime;
    const beat = backend.getState().music?.beat;
    backend.music({ kind: 'pause', requestId: 5, epoch });
    epoch = backend.getState().music?.epoch ?? -1;
    expect(backend.getState().music?.receipts.find((row) => row.requestId === 4)?.status).toBe(
      'cancelled',
    );
    await context.resume();
    await resume;
    expect(backend.getState().music?.beat).toBe(beat);
    backend.music({ kind: 'resume', requestId: 6, epoch });
    const resumeAt =
      backend.getState().music?.receipts.find((row) => row.requestId === 6)?.targetTime ?? -1;
    epoch = backend.getState().music?.epoch ?? -1;
    await context.resume();
    await tempo;
    const tempoAt = context.currentTime;
    const beatAtTempo = backend.getState().music?.beat;
    backend.music({ kind: 'tempo', requestId: 7, epoch, bpm: 137 });
    const restartedAt =
      backend.getState().music?.receipts.find((row) => row.requestId === 7)?.targetTime ?? -1;
    expect(backend.getState().music?.beat).toBe(beatAtTempo);
    await context.resume();
    const pcm = (await rendering).getChannelData(0);
    const amplitude = Math.round(0.2 * 32767) / 32768;
    const heldGain = 1 - (pauseAt - 0.52) / 0.5;
    let error = 0;
    for (let sample = 0; sample < pcm.length; sample++) {
      const t = sample / RATE;
      const expected =
        t < 0.02
          ? 0
          : t < 0.52
            ? amplitude
            : t < pauseAt
              ? amplitude * (1 - (t - 0.52) / 0.5)
              : t < resumeAt
                ? 0
                : t < tempoAt
                  ? amplitude * heldGain
                  : t < restartedAt
                    ? 0
                    : amplitude * heldGain;
      error = Math.max(error, Math.abs((pcm[sample] ?? 0) - expected));
    }
    expect(error).toBeLessThan(0.00001);
  } finally {
    consumer.dispose();
  }
});

it('keeps musical time frozen in a real suspended AudioContext and closes its native lifetime', async () => {
  const context = new AudioContext({ sampleRate: RATE });
  await context.resume();
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  consumer.prepareMusic(1, score(1));
  await expect.poll(() => consumer.state().music?.phase).toBe('ready');
  const epoch = consumer.state().music?.epoch ?? -1;
  consumer.consume({
    kind: 'music',
    command: {
      kind: 'mix',
      requestId: 2,
      epoch,
      boundary: 'beat',
      late: 'next-boundary',
      gains: [0],
    },
  });
  await context.suspend();
  const before = consumer.state().music?.beat;
  await new Promise((resolve) => setTimeout(resolve, 80));
  expect(consumer.state().music?.beat).toBe(before);
  await context.resume();
  await expect.poll(() => consumer.state().music?.beat).toBeGreaterThan(before ?? -1);
  await context.close();
  expect(consumer.state().music?.phase).toBe('closed');
  expect(consumer.state().music?.nodes).toBe(0);
  expect(consumer.state().cache?.sources).toBe(0);
  consumer.consume({
    kind: 'music',
    command: { kind: 'resume', requestId: 3, epoch: consumer.state().music?.epoch ?? -1 },
  });
  expect(consumer.state().music?.receipts.find((row) => row.requestId === 3)?.failure?.code).toBe(
    'context-closed',
  );
  expect(consumer.engine.musicOutput()).toBeUndefined();
  consumer.dispose();
});

it('rejects a one-native-sample-short loop with actionable frame evidence and silent PCM', async () => {
  const rate = 44100;
  const context = new OfflineAudioContext(1, rate * 2, rate);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const samples = new Float32Array(rate * 2 - 1).fill(0.25);
  const bytes = pcmWav(samples, rate);
  try {
    const independentlyDecoded = await context.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    expect(independentlyDecoded.sampleRate).toBe(rate);
    expect(independentlyDecoded.length).toBe(88199);
    consumer.prepareMusic(1, {
      ...score(1),
      stems: [
        { clip: { kind: 'audio', sourceKey: 'short-native-loop', mediaType: 'audio/wav', bytes } },
      ],
    });
    await expect.poll(() => consumer.state().music?.receipts[0]?.status).toBe('rejected');
    const state = consumer.state().music;
    expect(state?.phase).toBe('empty');
    expect(state?.nodes).toBe(0);
    expect(state?.receipts[0]?.failure?.code).toBe('invalid-score');
    expect(state?.receipts[0]?.failure?.detail.reason).toContain('loopFrames=88200');
    expect(state?.receipts[0]?.failure?.detail.reason).toContain('44100Hz/88199frames');
    const pcm = (await context.startRendering()).getChannelData(0);
    expect(pcm.some((sample) => sample !== 0)).toBe(false);
  } finally {
    consumer.dispose();
  }
});

it('resumes the same owned musical Context through a trusted browser gesture', async () => {
  const engine = new WebAudioEngine();
  const consumer = createHostAudioConsumer(engine);
  const button = document.createElement('button');
  button.textContent = 'Resume music';
  document.body.append(button);
  let trusted = false;
  button.addEventListener('pointerdown', (event) => {
    trusted = event.isTrusted;
  });
  try {
    // Device-rate decode can shorten the exact two-second WAV by one frame.
    // This gesture fixture declares a covered one-second loop; short decodes
    // remain strictly rejected by the independent native regression above.
    consumer.prepareMusic(1, { ...score(1), loopBeats: 2 });
    await expect
      .poll(() => consumer.state().music)
      .toMatchObject({ phase: 'ready' })
      .catch((error) => {
        const native = engine.musicOutput();
        console.error(
          '[music-owned-context-prepare]',
          JSON.stringify({
            nativeSampleRate: native?.context.sampleRate,
            nativeContextState: native?.context.state,
            state: consumer.state(),
          }),
        );
        throw error;
      });
    const native = engine.musicOutput();
    if (!native) throw new Error('prepared music requires the existing native Context');
    const context = native.context as AudioContext;
    consumer.consume({
      kind: 'music',
      command: {
        kind: 'mix',
        requestId: 2,
        epoch: consumer.state().music?.epoch ?? -1,
        boundary: 'bar',
        late: 'next-boundary',
        gains: [0],
      },
    });
    await context.suspend();
    engine.musicOutput(); // Rearm the existing bounded gesture listener.
    const before = consumer.state().music?.beat;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(consumer.state().music?.beat).toBe(before);
    await userEvent.click(button);
    await expect.poll(() => context.state).toBe('running');
    await expect.poll(() => consumer.state().music?.beat).toBeGreaterThan(before ?? -1);
    expect(trusted).toBe(true);
    expect(engine.musicOutput()?.context).toBe(context);
    consumer.dispose();
    await expect.poll(() => context.state).toBe('closed');
    expect(engine.musicOutput()).toBeUndefined();
    expect(consumer.state().music?.nodes).toBe(0);
  } finally {
    consumer.dispose();
    button.remove();
  }
});

it.each([
  'fractional native offset',
  'common resampling phase',
] as const)('keeps resampled offset stems aligned for 600 audio seconds (%s)', async (variant) => {
  const rate = 44100,
    bpm = 137,
    loopBeats = 4;
  const seconds = 600;
  const context = new OfflineAudioContext(1, rate * seconds, rate);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(structuredClone(intent)),
    state: () => consumer.state(),
  });
  const declared: MusicPreparation = {
    bpm,
    beatsPerBar: 4,
    loopBeats,
    stems: Array.from({ length: 4 }, (_, stem) => {
      // Different buffer extents and offsets must not become independent loop clocks.
      // 160 input samples map to 147 native samples: keep the resampler phase
      // common, so intended marker offsets cannot masquerade as start jitter.
      const offsetSeconds =
        variant === 'fractional native offset' ? (stem + 1) / 8 : ((stem + 1) * 6400) / RATE;
      const pcm = new Float32Array(
        Math.ceil((offsetSeconds + (loopBeats * 60) / bpm + 0.1 + stem / 10) * RATE),
      );
      const marker =
        Math.round(offsetSeconds * RATE) +
        128 +
        stem * (variant === 'fractional native offset' ? 128 : 160);
      pcm[marker] = (stem + 1) / 16;
      return {
        offsetSeconds,
        clip: {
          kind: 'audio',
          sourceKey: `resampled-${stem}`,
          mediaType: 'audio/wav',
          bytes: pcmWav(pcm),
        },
      };
    }),
  };
  try {
    consumer.prepareMusic(1, declared);
    await expect.poll(() => backend.getState().music?.phase).toBe('ready');
    const epoch = backend.getState().music?.epoch ?? -1;
    backend.music({
      kind: 'mix',
      requestId: 2,
      epoch,
      boundary: 'beat',
      atBeat: 0,
      late: 'reject',
      gains: [1, 1, 1, 1],
    });
    const pcm = (await context.startRendering()).getChannelData(0);
    const period = ((loopBeats * 60) / bpm) * rate;
    const nativeLoop = Math.round(period);
    const speed = nativeLoop / period;
    let maximum = 0,
      relativeMaximum = 0;
    const raw = [];
    for (let loop = 0; loop < Math.floor(((seconds - 0.03) * bpm) / (60 * loopBeats)); loop++) {
      const relative = [];
      for (let stem = 0; stem < 4; stem++) {
        const offset = declared.stems[stem]?.offsetSeconds ?? 0;
        const sourceMarker = 128 + stem * (variant === 'fractional native offset' ? 128 : 160);
        // Account for the declared native offset quantization, independently of transport state.
        const marker =
          ((sourceMarker * rate) / RATE - (Math.round(offset * rate) - offset * rate)) / speed;
        const expected = Math.round(0.02 * rate + loop * period + marker);
        let peak = expected;
        for (let sample = expected - 3; sample <= expected + 3; sample++)
          if ((pcm[sample] ?? 0) > (pcm[peak] ?? 0)) peak = sample;
        expect(pcm[peak]).toBeGreaterThan(0.001);
        maximum = Math.max(maximum, Math.abs(peak - expected));
        relative.push(peak - marker);
        raw.push({ loop, stem, expected, peak, marker, error: peak - expected });
      }
      relativeMaximum = Math.max(relativeMaximum, Math.max(...relative) - Math.min(...relative));
    }
    // biome-ignore lint/suspicious/noConsole: preserve independent native PCM oracle samples in CI evidence.
    console.log(
      '[music resampling oracle]',
      JSON.stringify({ variant, rate, bpm, seconds, maximum, relativeMaximum, raw }),
    );
    expect(relativeMaximum).toBeLessThanOrEqual(1 + 1e-7);
    expect(maximum).toBeLessThanOrEqual(1);
  } finally {
    consumer.dispose();
  }
}, 60000);

it('permits a nearer quantized mix after cancelling the first far-future request', async () => {
  const { context, consumer, backend, epoch } = await fixture(2, 1);
  try {
    backend.music({
      kind: 'mix',
      requestId: 2,
      epoch,
      boundary: 'bar',
      atBeat: 100,
      late: 'reject',
      gains: [1],
    });
    backend.music({ kind: 'cancel', requestId: 3, epoch, cancelRequestId: 2 });
    backend.music({
      kind: 'mix',
      requestId: 4,
      epoch,
      boundary: 'beat',
      atBeat: 1,
      late: 'reject',
      gains: [1],
    });
    const pcm = (await context.startRendering()).getChannelData(0);
    expect(pcm[24960]).toBeGreaterThan(0.01);
    expect(pcm[960]).toBe(0);
  } finally {
    consumer.dispose();
  }
});

it('retires every native voice after partial source creation failure', async () => {
  const { context, consumer, backend, epoch } = await fixture(2, 4);
  const original = context.createBufferSource.bind(context);
  let created = 0;
  context.createBufferSource = () => {
    if (++created === 2) throw new Error('injected native source allocation failure');
    return original();
  };
  try {
    backend.music({
      kind: 'mix',
      requestId: 2,
      epoch,
      boundary: 'beat',
      atBeat: 0,
      late: 'reject',
      gains: [1, 1, 1, 1],
    });
    const state = backend.getState().music;
    expect(state?.receipts.find((row) => row.requestId === 2)?.failure?.code).toBe('native-failed');
    expect(state?.nodes).toBe(0);
    expect(state?.pending).toBe(0);
    expect((await context.startRendering()).getChannelData(0).every((value) => value === 0)).toBe(
      true,
    );
  } finally {
    context.createBufferSource = original;
    consumer.dispose();
  }
});

it('adopts only the newest prepared score and shares the ordinary source content fence', async () => {
  const context = new OfflineAudioContext(1, RATE * 2, RATE);
  const consumer = createHostAudioConsumer(new WebAudioEngine({ context }));
  const backend = createAudioIntentBackend({
    emit: (intent) => consumer.consume(structuredClone(intent)),
    state: () => consumer.state(),
  });
  try {
    consumer.prepareMusic(1, score(4));
    const newer = score(1);
    consumer.prepareMusic(2, newer);
    await expect.poll(() => backend.getState().music?.phase).toBe('ready');
    expect(backend.getState().music?.receipts.find((row) => row.requestId === 1)?.status).toBe(
      'cancelled',
    );
    const epoch = backend.getState().music?.epoch ?? -1;
    backend.music({
      kind: 'mix',
      requestId: 3,
      epoch,
      boundary: 'beat',
      atBeat: 0,
      late: 'reject',
      gains: [1],
    });
    const replacement = {
      kind: 'audio' as const,
      sourceKey: 'impulse-0',
      mediaType: 'audio/wav' as const,
      bytes: pcmWav(new Float32Array(RATE * 2)),
    };
    backend.play(42, replacement, { loop: false, volume: 1, spatialBlend: 0, bus: 'music' });
    expect(backend.getState().music?.phase).toBe('empty');
    expect(backend.getState().music?.nodes).toBe(0);
    await expect.poll(() => backend.getState().cache?.pendingPlays).toBe(0);
    expect((await context.startRendering()).getChannelData(0).every((value) => value === 0)).toBe(
      true,
    );
  } finally {
    consumer.dispose();
  }
});
