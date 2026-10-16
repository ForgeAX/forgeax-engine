import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

const output = process.argv.find((argument) => argument.startsWith('--output='))?.slice(9);
const configuredHostModule = process.env.FORGEAX_GPU_PASS_TIMING_HOST_MODULE;
const hostModule =
  configuredHostModule === undefined || isAbsolute(configuredHostModule)
    ? configuredHostModule
    : resolve(process.cwd(), configuredHostModule);

function blockedReport(
  reason,
  evidence,
  hint = 'set FORGEAX_GPU_PASS_TIMING_HOST_MODULE to a real WebGPU benchmark host module',
) {
  return {
    schemaVersion: '1.0',
    benchmark: 'render-gpu-pass-timing',
    verdict: 'blocked',
    reason,
    hint,
    ...(evidence === undefined ? {} : { evidence }),
  };
}

function nearestRankP95(values) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function formatNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : 'n/a';
}

function printReportSummary(report) {
  const evidence = report.verdict === 'blocked' ? report.evidence : report;
  const lines = [
    'GPU pass timing report summary:',
    `verdict: ${report.verdict ?? 'unknown'}`,
    `reason: ${report.reason ?? 'n/a'}`,
  ];
  if (evidence === undefined) {
    console.error(lines.join('\n'));
    return;
  }
  const sourceHead = evidence.source?.sourceHead;
  const backend = evidence.backend;
  const workload = evidence.workload;
  if (sourceHead !== undefined) lines.push(`sourceHead: ${sourceHead}`);
  if (backend !== undefined) {
    lines.push(
      `backend: ${backend.kind ?? 'n/a'} / ${backend.adapter ?? 'n/a'} / ${backend.driver ?? 'n/a'}`,
    );
  }
  if (workload !== undefined) {
    lines.push(
      `workload: ${workload.resolution?.width ?? 'n/a'}x${workload.resolution?.height ?? 'n/a'} / ${workload.scene ?? 'n/a'} / ${workload.pipeline ?? 'n/a'}`,
    );
  }
  const completeness = evidence.timingCompleteness;
  if (completeness !== undefined) {
    const side = (value) =>
      `${value?.completeFrames ?? 'n/a'} complete, ${value?.partialFrames ?? 'n/a'} partial, ${value?.failedFrames ?? 'n/a'} failed`;
    lines.push(
      `timingCompleteness: ${completeness.status ?? 'n/a'}; off=${side(completeness.off)}; on=${side(completeness.on)}`,
    );
  }
  const overhead = evidence.pairedOverhead ?? evidence.overhead;
  const rawGroups = Array.isArray(evidence.windows) ? evidence.windows : evidence.windows?.groups;
  const pairedGroups = overhead?.pairedGroups;
  if (Array.isArray(rawGroups) || Array.isArray(pairedGroups)) {
    const groupCount = Math.max(rawGroups?.length ?? 0, pairedGroups?.length ?? 0);
    for (let group = 0; group < groupCount; group += 1) {
      const raw = rawGroups?.[group];
      const paired = pairedGroups?.[group];
      const offP95 =
        paired?.offP95FrameDurationMicroseconds ??
        raw?.off?.p95FrameDurationMicroseconds ??
        nearestRankP95(raw?.off?.frameDurationsMicroseconds);
      const onP95 =
        paired?.onP95FrameDurationMicroseconds ??
        raw?.on?.p95FrameDurationMicroseconds ??
        nearestRankP95(raw?.on?.frameDurationsMicroseconds);
      const overheadPercent = paired?.overheadPercent ?? overhead?.groupOverheadPercent?.[group];
      lines.push(
        `group ${group}: off p95=${formatNumber(offP95)} us, on p95=${formatNumber(onP95)} us, overhead=${formatNumber(overheadPercent)}%`,
      );
    }
  }
  const reportedOverheadPercent = overhead?.reportedOverheadPercent;
  if (reportedOverheadPercent !== undefined) {
    lines.push(
      `reported paired overhead (median of groups): ${formatNumber(reportedOverheadPercent)}%`,
    );
  }
  const cpuOverheadPercent = evidence.cpuOverheadPercent ?? evidence.cpu?.overheadPercent;
  if (cpuOverheadPercent !== undefined) {
    lines.push(`CPU overhead: ${formatNumber(cpuOverheadPercent)}%`);
  }
  console.error(lines.join('\n'));
}

async function main() {
  let report;
  let host;
  try {
    if (hostModule === undefined) {
      report = blockedReport('no real WebGPU benchmark host was provided');
    } else {
      const [{ runGpuPassTimingBenchmark }, hostFactory] = await Promise.all([
        import('../../packages/render/bench/gpu-pass-timing/runner.ts'),
        import(hostModule),
      ]);
      const createHost = hostFactory.createGpuPassTimingBenchHost ?? hostFactory.default;
      if (typeof createHost !== 'function') {
        throw new Error('benchmark host module does not export createGpuPassTimingBenchHost');
      }
      host = await createHost();
      const result = await runGpuPassTimingBenchmark(host);
      if (result.ok) {
        report = result.value;
      } else {
        const detail = result.error.detail;
        report = blockedReport(
          detail.cause,
          detail.frameFacts === undefined && detail.windows === undefined
            ? undefined
            : {
                source: host.source,
                runner: host.runner,
                backend: host.backend,
                workload: host.workload,
                ...(detail.frameFacts === undefined ? {} : { frameFacts: detail.frameFacts }),
                ...(detail.windows === undefined ? {} : { windows: detail.windows }),
                ...(detail.pairedOverhead === undefined
                  ? {}
                  : { pairedOverhead: detail.pairedOverhead }),
                ...(detail.cpuOverheadPercent === undefined
                  ? {}
                  : { cpuOverheadPercent: detail.cpuOverheadPercent }),
                ...(detail.timingCompleteness === undefined
                  ? {}
                  : { timingCompleteness: detail.timingCompleteness }),
              },
          result.error.hint,
        );
      }
    }
  } catch (error) {
    report = blockedReport(error instanceof Error ? error.message : String(error));
  }
  if (host !== undefined && typeof host.dispose === 'function') {
    try {
      await host.dispose();
    } catch (error) {
      report = blockedReport(
        `benchmark host disposal failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (report.verdict === 'blocked') {
    if (output !== undefined) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    printReportSummary(report);
    process.exit(2);
  }
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output !== undefined) await writeFile(output, serialized);
  else process.stdout.write(serialized);
  printReportSummary(report);
}

await main();
