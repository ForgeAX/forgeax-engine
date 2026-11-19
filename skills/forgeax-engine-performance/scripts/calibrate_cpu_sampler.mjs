import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { cpuSampleTimeline } from './cpu_timeline.mjs';
import { statistics } from './lib.mjs';
import { buildMetricReport, metricReportHtml, metricReportSvg } from './render_metric_report.mjs';

export async function calibrateCpuSampler(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      help: { type: 'boolean' },
      browser: { type: 'string' },
      'playwright-module': { type: 'string' },
      'expected-capture': { type: 'string' },
      'out-dir': { type: 'string' },
      'intervals-us': { type: 'string', default: '50,10,2,1,1' },
      'window-ms': { type: 'string', default: '1000' },
      'control-ms': { type: 'string', default: '400' },
    },
  });
  if (values.help) {
    process.stdout.write(
      'cpu.mjs calibrate --browser ABS_EXECUTABLE --playwright-module ABS_ESM_MODULE --out-dir NEW_DIRECTORY [--expected-capture capture-report.json] [--intervals-us 50,10,2,1,1] [--window-ms 1000] [--control-ms 400]\nUses the caller-selected browser and pinned Playwright with sandbox enabled. Writes raw profiles, calibration.json and visual report.html/report.svg. Busy-loop calibration is not game performance or game profiler overhead.\n',
    );
    return;
  }
  assert.equal(positionals.length, 0, 'Calibration accepts options only');
  for (const key of ['browser', 'playwright-module', 'out-dir'])
    assert(values[key] && isAbsolute(values[key]), key + ' must be an absolute path');
  const intervals = values['intervals-us'].split(',').map(Number);
  assert(
    intervals.length > 0 &&
      intervals.length <= 16 &&
      intervals.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 1000000),
    'Select 1..16 positive microsecond intervals',
  );
  const windowMs = Number(values['window-ms']),
    controlMs = Number(values['control-ms']);
  assert(
    Number.isSafeInteger(windowMs) && windowMs >= 100 && windowMs <= 5000,
    'window-ms must be 100..5000',
  );
  assert(
    Number.isSafeInteger(controlMs) && controlMs >= 100 && controlMs <= 2000,
    'control-ms must be 100..2000',
  );
  const { chromium } = await import(pathToFileURL(values['playwright-module']).href);
  const expected = values['expected-capture']
    ? JSON.parse(await readFile(values['expected-capture'], 'utf8')).browser
    : null;
  if (values['expected-capture'])
    assert(
      expected && typeof expected.product === 'string' && typeof expected.jsVersion === 'string',
      'Expected capture must identify browser product and jsVersion',
    );
  await mkdir(values['out-dir']);
  const result = {
    kind: 'sampler-frequency-control',
    ok: false,
    browser: null,
    expectedBrowser: expected,
    config: { intervalsUs: intervals, windowMs, controlMs },
    results: [],
    failures: [],
    interpretation:
      'Busy-loop timing calibration only. Adjacent profiler-off controls describe this synthetic workload; their throughput ratios are not game overhead. Requested intervals are not achieved resolution or per-call duration error bounds.',
  };
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: values.browser,
      headless: true,
      chromiumSandbox: true,
    });
    const page = await browser.newPage(),
      cdp = await page.context().newCDPSession(page);
    result.browser = await cdp.send('Browser.getVersion');
    if (expected)
      for (const key of ['product', 'jsVersion'])
        assert.equal(
          result.browser[key],
          expected[key],
          'Calibration browser differs from capture: ' + key,
        );
    await page.evaluate(() => {
      globalThis.samplerWork = function samplerWork(ms) {
        let checksum = 1,
          rounds = 0;
        const start = performance.now();
        while (performance.now() - start < ms) {
          for (let i = 0; i < 1000; i++)
            checksum = (Math.imul(checksum ^ i, 1664525) + 1013904223) | 0;
          rounds++;
        }
        return { rounds, ms: performance.now() - start, checksum };
      };
    });
    await page.evaluate((ms) => globalThis.samplerWork(ms), 1000);
    for (const [i, interval] of intervals.entries()) {
      const before = await page.evaluate((ms) => globalThis.samplerWork(ms), controlMs);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval });
      await cdp.send('Profiler.start');
      const profiled = await page.evaluate((ms) => globalThis.samplerWork(ms), windowMs);
      const { profile } = await cdp.send('Profiler.stop');
      await cdp.send('Profiler.disable');
      const after = await page.evaluate((ms) => globalThis.samplerWork(ms), controlMs);
      const bytes = JSON.stringify(profile),
        file = `control-${i}-${interval}.cpuprofile`;
      await writeFile(join(values['out-dir'], file), bytes, { flag: 'wx' });
      const timeline = cpuSampleTimeline(profile),
        dt = statistics(
          timeline.intervals
            .slice(1)
            .map((s) => s.delta)
            .filter((n) => n > 0),
        );
      const rate = (w) => w.rounds / w.ms;
      result.results.push({
        label: `${interval} us / run ${i + 1}`,
        requestedIntervalUs: interval,
        samples: profile.samples.length,
        durationMs: (profile.endTime - profile.startTime) / 1000,
        p50Us: dt.p50,
        p95Us: dt.p95,
        samplesPerSecond: profile.samples.length / ((profile.endTime - profile.startTime) / 1e6),
        before,
        profiled,
        after,
        throughputRatioToAdjacentOrdinary: rate(profiled) / ((rate(before) + rate(after)) / 2),
        profile: { file, sha256: createHash('sha256').update(bytes).digest('hex') },
        timelineAudit: timeline.audit,
      });
    }
    result.ok = true;
  } catch (error) {
    result.failures.push({ message: error.message });
    throw error;
  } finally {
    await browser?.close();
    const calibrationBytes = JSON.stringify(result);
    await writeFile(join(values['out-dir'], 'calibration.json'), calibrationBytes, {
      flag: 'wx',
    });
    if (result.results.length) {
      const visual = buildMetricReport(result, {
        rowsPointer: '/results',
        labelPointer: '/label',
        valuePointers: ['/p50Us', '/p95Us'],
        unit: 'us',
        title: 'Observed sampler cadence (synthetic calibration)',
      });
      visual.input = {
        path: join(values['out-dir'], 'calibration.json'),
        sha256: createHash('sha256').update(calibrationBytes).digest('hex'),
      };
      await writeFile(join(values['out-dir'], 'report.json'), JSON.stringify(visual), {
        flag: 'wx',
      });
      await writeFile(join(values['out-dir'], 'report.html'), metricReportHtml(visual), {
        flag: 'wx',
      });
      await writeFile(join(values['out-dir'], 'report.svg'), metricReportSvg(visual), {
        flag: 'wx',
      });
    }
  }
  process.stdout.write(
    JSON.stringify({
      ok: result.ok,
      directory: values['out-dir'],
      browser: result.browser,
      results: result.results.map((r) => ({
        requestedIntervalUs: r.requestedIntervalUs,
        p50Us: r.p50Us,
        p95Us: r.p95Us,
        samplesPerSecond: r.samplesPerSecond,
      })),
    }) + '\n',
  );
  return result;
}
