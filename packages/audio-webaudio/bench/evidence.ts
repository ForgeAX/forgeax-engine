import { WebAudioEngine } from '../src/web-audio-engine';
import { toneBuffer, magnitude, pcmWav, rms } from '../src/__tests__/support-tone';

const options = { loop: true, volume: 0.001, spatialBlend: 0, bus: 'music' as const };
const percentile = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * p)]!;
const lowpass = (context: BaseAudioContext) => {
  const filter = context.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 1000;
  filter.Q.value = 20 * Math.log10(Math.SQRT1_2);
  const gain = context.createGain();
  gain.gain.value = 0.5;
  return [filter, gain];
};

async function render(rate: number, filtered: boolean, sourceCount = 1) {
  const context = new OfflineAudioContext(1, 48000, 48000);
  const engine = new WebAudioEngine({ context });
  const buffer = toneBuffer(context, filtered ? [440, 8000] : [440]);
  for (let i = 0; i < sourceCount; i++) {
    engine.play(i, buffer, { ...options, volume: 1 / sourceCount, playbackRate: rate });
    if (filtered) engine.setFilters(i, lowpass).unwrap();
  }
  const start = performance.now();
  const output = (await context.startRendering()).getChannelData(0);
  const durationMs = performance.now() - start;
  engine.destroy();
  return { output, durationMs };
}

function drawWave(id: string, lines: { data: Float32Array; color: string; label: string }[]) {
  const canvas = document.querySelector<HTMLCanvasElement>(`#${id}`)!;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, 560, 210);
  ctx.strokeStyle = '#33475f';
  ctx.beginPath();
  ctx.moveTo(0, 110);
  ctx.lineTo(560, 110);
  ctx.stroke();
  for (const [index, line] of lines.entries()) {
    ctx.strokeStyle = line.color;
    ctx.beginPath();
    for (let i = 0; i < 480; i++) {
      const x = (i / 480) * 560,
        y = 110 - line.data[i + 9600]! * 150;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = line.color;
    ctx.fillText(line.label, 12 + index * 260, 20);
  }
  ctx.fillStyle = '#9eb2c9';
  ctx.fillText('10 ms of rendered samples', 12, 200);
}

async function controls(sourceCount: number) {
  const context = new AudioContext();
  await context.resume();
  const engine = new WebAudioEngine({ context });
  const buffer = toneBuffer(context, [1000]);
  let createdSources = 0,
    createdAnalysers = 0;
  const createSource = context.createBufferSource.bind(context),
    createAnalyser = context.createAnalyser.bind(context);
  context.createBufferSource = () => {
    createdSources++;
    return createSource();
  };
  context.createAnalyser = () => {
    createdAnalysers++;
    return createAnalyser();
  };
  const taps: { node: AnalyserNode; data: Float32Array<ArrayBuffer> }[] = [];
  for (let i = 0; i < sourceCount; i++) {
    engine.play(i, buffer, options);
    engine.setFilters(i, lowpass).unwrap();
    const node = engine.createAnalyser(i, 2048).unwrap();
    node.smoothingTimeConstant = 0;
    taps.push({ node, data: new Float32Array(node.frequencyBinCount) });
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  const startNodes = createdSources,
    times: number[] = [],
    pauseTimes: number[] = [];
  // Warmup is outside the measured 120 batches. Reuse every FFT output array.
  for (let batch = -20; batch < 120; batch++) {
    const start = performance.now();
    for (let i = 0; i < sourceCount; i++) {
      engine.setPlaybackRate(i, batch % 2 === 0 ? 1 : 2);
      engine.readFrequencyData(i, taps[i]!.data).unwrap();
    }
    engine.getState();
    if (batch >= 0) times.push(performance.now() - start);
    if (batch % 20 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const steadyNodeCreations = createdSources - startNodes;
  for (let batch = 0; batch < 20; batch++) {
    const start = performance.now();
    for (let i = 0; i < sourceCount; i++) {
      engine.setPaused(i, true);
      engine.setPaused(i, false);
    }
    pauseTimes.push(performance.now() - start);
  }
  const peakData = taps[0]!.data;
  let peak = 0;
  for (let i = 1; i < peakData.length; i++) if (peakData[i]! > peakData[peak]!) peak = i;
  const peakHz = (peak * context.sampleRate) / taps[0]!.node.fftSize;
  for (let i = 0; i < sourceCount; i++) engine.stop(i);
  const cleanup = {
    active: engine.getActiveSourceCount(),
    retained: Array.from({ length: sourceCount }, (_, i) => engine.getPlaybackPosition(i)).filter(
      (value) => value !== undefined,
    ).length,
  };
  engine.destroy();
  await context.close();
  if (steadyNodeCreations !== 0 || cleanup.active !== 0 || cleanup.retained !== 0)
    throw new Error('audio lifecycle falsifier failed');
  return {
    sourceCount,
    batches: 120,
    fftSize: 2048,
    cpuMs: {
      p50: percentile(times, 0.5),
      p95: percentile(times, 0.95),
      p99: percentile(times, 0.99),
    },
    pauseResumeMs: { p50: percentile(pauseTimes, 0.5), p95: percentile(pauseTimes, 0.95) },
    steadyNodeCreations,
    createdAnalysers,
    fftOutputArrays: taps.length,
    peakHz,
    cleanup,
  };
}

async function pausedDelay() {
  const context = new OfflineAudioContext(1, 60000, 48000);
  const engine = new WebAudioEngine({ context });
  engine.play(1, toneBuffer(context, [440]), { ...options, volume: 1 });
  engine
    .setFilters(1, (ctx) => {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = 0.2;
      return [delay];
    })
    .unwrap();
  const pause = context.suspend(0.25),
    volume = context.suspend(0.65),
    resume = context.suspend(0.75);
  const rendering = context.startRendering();
  await pause;
  engine.setPaused(1, true);
  const position = engine.getPlaybackPosition(1);
  await context.resume();
  await volume;
  engine.setVolume(1, 0.25);
  await context.resume();
  await resume;
  const frozenPosition = engine.getPlaybackPosition(1);
  engine.setPaused(1, false);
  await context.resume();
  const output = (await rendering).getChannelData(0);
  const pausedRms = rms(output, 16800, 28800),
    resumedRms = rms(output, 48000, 57600);
  if (
    position !== frozenPosition ||
    pausedRms > 1e-6 ||
    Math.abs(resumedRms - 0.125 / Math.SQRT2) > 0.001
  )
    throw new Error('native retained pause falsifier failed');
  engine.destroy();
  const canvas = document.querySelector<HTMLCanvasElement>('#pause')!;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#203246';
  ctx.fillRect(canvas.width * 0.2, 30, canvas.width * 0.4, 170);
  ctx.strokeStyle = '#71e4b7';
  ctx.beginPath();
  for (let x = 0; x < canvas.width; x++) {
    const from = Math.floor((x * output.length) / canvas.width),
      to = Math.floor(((x + 1) * output.length) / canvas.width);
    let peak = 0;
    for (let i = from; i < to; i++) peak = Math.max(peak, Math.abs(output[i] ?? 0));
    ctx.moveTo(x, 110 - peak * 150);
    ctx.lineTo(x, 110 + peak * 150);
  }
  ctx.stroke();
  ctx.fillStyle = '#9eb2c9';
  ctx.fillText('0 s', 4, 205);
  ctx.fillText('Pause 0.25–0.75 s', 160, 25);
  ctx.fillText('1.25 s', canvas.width - 50, 205);
  document.querySelector('#pause-summary')!.textContent =
    `Delay 200 ms · paused RMS ${pausedRms.toFixed(6)} · resumed RMS ${resumedRms.toFixed(6)} · restored volume 0.25`;
  return {
    output,
    pausedRms,
    resumedRms,
    expectedResumedRms: 0.125 / Math.SQRT2,
    position,
    frozenPosition,
    delaySeconds: 0.2,
    resumeVolume: 0.25,
  };
}

async function run() {
  const normal = await render(1, false),
    fast = await render(2, false);
  const dryContext = new OfflineAudioContext(1, 48000, 48000),
    dryEngine = new WebAudioEngine({ context: dryContext });
  dryEngine.play(1, toneBuffer(dryContext, [440, 8000]), { ...options, volume: 1 });
  const dry = (await dryContext.startRendering()).getChannelData(0);
  dryEngine.destroy();
  const wet = await render(1, true);
  const bands = [440, 8000].map((frequency) => ({
    frequency,
    dry: magnitude(dry, 48000, frequency),
    wet: magnitude(wet.output, 48000, frequency),
    attenuationDb:
      20 * Math.log10(magnitude(wet.output, 48000, frequency) / magnitude(dry, 48000, frequency)),
  }));
  const rates = [normal.output, fast.output].map((data) => {
    let n = 0;
    for (let i = 2408; i < 26407; i++) if (data[i - 1]! <= 0 && data[i]! > 0) n++;
    return n * 2;
  });
  if (
    Math.abs(rates[0]! - 440) > 4 ||
    Math.abs(rates[1]! - 880) > 4 ||
    bands[1]!.attenuationDb > -40
  )
    throw new Error('native signal falsifier failed');
  drawWave('rate', [
    { data: normal.output, color: '#71e4b7', label: `1× · ${rates[0]} Hz` },
    { data: fast.output, color: '#f7ba6b', label: `2× · ${rates[1]} Hz` },
  ]);
  drawWave('filter', [
    { data: dry, color: '#f7ba6b', label: 'Dry: 440 Hz + 8 kHz' },
    {
      data: wet.output,
      color: '#71e4b7',
      label: `Wet: 8 kHz ${bands[1]!.attenuationDb.toFixed(2)} dB`,
    },
  ]);
  const delay = await pausedDelay();
  const rows = [];
  for (const count of [1, 32, 128, 256]) rows.push(await controls(count));
  const offline = [];
  for (const count of [1, 32, 128])
    for (const filtered of [false, true]) {
      const durations = [];
      for (let repeat = 0; repeat < 5; repeat++)
        durations.push((await render(1, filtered, count)).durationMs);
      offline.push({
        sourceCount: count,
        filtered,
        renderedSeconds: 1,
        repeats: 5,
        wallMsP50: percentile(durations, 0.5),
        wallMsP95: percentile(durations, 0.95),
      });
    }
  document.querySelector('#performance')!.innerHTML =
    '<tr><th>Sources</th><th>Control+FFT p50</th><th>p95</th><th>p99</th><th>Pause/resume p95</th><th>New steady nodes</th></tr>' +
    rows
      .map(
        (row) =>
          `<tr><td>${row.sourceCount}</td><td>${row.cpuMs.p50.toFixed(3)} ms</td><td>${row.cpuMs.p95.toFixed(3)} ms</td><td>${row.cpuMs.p99.toFixed(3)} ms</td><td>${row.pauseResumeMs.p95.toFixed(3)} ms</td><td>${row.steadyNodeCreations}</td></tr>`,
      )
      .join('');
  document.querySelector('#cleanup')!.textContent =
    'PASS · every workload stops with 0 active and 0 retained sources · one FFT output array per source';
  document.querySelector('#cleanup')!.className = 'pass';
  document.querySelector('#summary')!.textContent =
    `${navigator.userAgent} · ${new Date().toISOString()}`;
  return {
    audioFiles: {
      'rate-1x.wav': Array.from(pcmWav(normal.output)),
      'rate-2x.wav': Array.from(pcmWav(fast.output)),
      'filter-dry.wav': Array.from(pcmWav(dry)),
      'filter-wet.wav': Array.from(pcmWav(wet.output)),
      'pause-delay.wav': Array.from(pcmWav(delay.output)),
    },
    status: 'pass',
    crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    userAgent: navigator.userAgent,
    sampleRate: 48000,
    rates,
    bands,
    pause: { ...delay, output: undefined },
    rows,
    offline,
  };
}
Object.assign(globalThis, { __audioEvidence: { run } });
