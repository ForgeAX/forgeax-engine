import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// The table preserves raw totals. Scaling is not an A/B speedup; O(N) scene
// base scene storage is separate from the required O(change) CPU work.
const [output, ...inputs] = process.argv.slice(2);
assert(output && inputs.length, 'table.mjs OUTPUT.md REPORT.json...');
const reports = await Promise.all(inputs.map(async input => ({ input: resolve(input), report: JSON.parse(await readFile(input, 'utf8')) })));
const group = r => `${r.config.workload ?? 'mixed'}/${r.config.phase}/${r.backend}`;
const rows = reports.sort((a, b) => group(a.report).localeCompare(group(b.report)) || a.report.config.count - b.report.config.count);
const number = n => Number.isFinite(n) ? n.toFixed(2) : 'unavailable';
const mib = n => number(n / 1048576);
const median = numbers => [...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)];
const objects = metrics => metrics?.objects === undefined ? undefined : Object.entries(metrics.objects.byType).filter(([key]) => ['object', 'array', 'closure'].includes(key)).reduce((n, [, value]) => n + value.count, 0);
const cells = report => {
  if (report.status !== 'complete') return undefined;
  return [report.statistics.sourceThreadCpuMs.p50, report.statistics.renderThreadCpuMs.p50,
    report.statistics.totalThreadCpuMs.p50, report.statistics.endToEndMs.p50,
    median(report.raw.map(row => row.counts.transferBytes)), report.sourceMetrics?.peakHeapUsed,
    report.renderMetrics?.peakHeapUsed, report.renderMetrics?.peakProcessRss,
    objects(report.sourceMetrics), objects(report.renderMetrics),
    (report.sourceMetrics?.gc.count ?? 0) + (report.renderMetrics?.gc.count ?? 0),
    (report.sourceMetrics?.gc.durationMs ?? 0) + (report.renderMetrics?.gc.durationMs ?? 0),
    report.sourceMetrics?.allocatedHeapBytes == null ? undefined : report.sourceMetrics.allocatedHeapBytes / report.raw.length,
    report.renderMetrics?.allocatedHeapBytes == null ? undefined : report.renderMetrics.allocatedHeapBytes / report.raw.length,
    median(report.raw.map(row => row.counts.logicalColumnBytes))];
};
let text = '# Change propagation stress scaling\n\n';
text += '> [!IMPORTANT]\n> Diagnostic evidence, not hardware performance acceptance. WebGPU stub preserves the selected WebGPU CPU path without GPU execution or validation; Null is a structural target with different caps/branches. Summed thread CPU is work, not frame latency. Heap censuses run after the timing window and force GC. Missing measurements remain unavailable. Frontline D names editable chunk slots, K is unused, and its fixed shooter/pose roster defines change complexity.\n\n';
text += '| Workload / phase / backend | N | D / editable slots | K (mixed only) | Frames | Source CPU p50 ms | Render CPU p50 ms | Total CPU p50 ms | End-to-end p50 ms | Transferred capacity B/frame | Source peak heap MiB | Render peak heap MiB | Process peak RSS MiB | Source live objects/arrays/closures | Render live objects/arrays/closures | GC count | GC ms | Source allocated heap B/frame | Render allocated heap B/frame | Logical column B/frame |\n';
text += '|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n';
for (const { report: r } of rows) {
  const c = cells(r);
  const prefix = `| ${group(r)} | ${r.config.count} | ${r.config.dirty} | ${r.config.workload === 'frontline' ? 'unused' : r.config.users} |`;
  text += c ? `${prefix} ${r.raw.length} | ${c.slice(0, 4).map(number).join(' | ')} | ${c[4]} | ${c.slice(5, 8).map(mib).join(' | ')} | ${c[8] ?? 'unavailable'} | ${c[9] ?? 'unavailable'} | ${c[10]} | ${number(c[11])} | ${c.slice(12).map(number).join(' | ')} |\n` : `${prefix} failed | ${r.failure?.message?.replaceAll('|', '/') ?? 'unavailable'} |\n`;
}
text += '\n## Adjacent scale multipliers\n\n| Phase | N ratio | Source CPU | Render CPU | Total CPU | End-to-end | Transfer capacity | Source heap | Render heap | RSS | Source live objects | Render live objects | GC count | GC time | Source allocation/frame | Render allocation/frame | Logical column bytes/frame |\n|:--|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|\n';
for (let i = 1; i < rows.length; i++) {
  const a = rows[i - 1].report, b = rows[i].report;
  if (group(a) !== group(b) || a.config.dirty !== b.config.dirty || a.config.users !== b.config.users || a.raw.length !== b.raw.length) continue;
  const ac = cells(a), bc = cells(b); if (!ac || !bc) continue;
  text += `| ${group(b)} | ${number(b.config.count / a.config.count)} | ${bc.map((value, index) => ac[index] > 0 && value !== undefined ? number(value / ac[index]) : 'unavailable').join(' | ')} |\n`;
}
text += '\n## Expected growth and evidence boundary\n\n| Metric | Fixed D and K, increasing N | Interpretation |\n|:--|:--|:--|\n| Incremental maintenance visits / temporary allocation | O(D), bounded when D is fixed | Packet size or cache misses alone do not prove downstream locality; missing visit/allocation counters remain unverified. |\n| Transfer payload | O(D + changed resource bytes) | Buffer capacity may retain a baseline high-water mark; distinguish allocated capacity from logical rows. |\n| Live scene objects / retained heap | O(N), plus bounded pending frames and resources | 10x N permits roughly 10x scene storage; fixed shader/runtime overhead can reduce the observed ratio. This is not allocation churn. |\n| Peak memory | O(N + live changes + bounded backlog) | RSS is process-wide and appears once; source/render heap peaks are separately sampled and must not be summed as simultaneous peak RSS. |\n| GC count / duration | No universal exact ratio | Use the same completed frames; growing temporary allocation at fixed D is suspect, but heap sizes, GC thresholds and contention also affect collection. |\n| Complete CPU chain / final completion time | CPU work follows change complexity, independent of unrelated N | Query, preparation, encoding and submission are included; camera changes and cache hits cannot excuse a full CPU walk. GPU completion wait is reported separately. Before/after gain requires matched paired runs. |\n';
text += '\n## Inputs\n\n';
for (const { input, report } of rows) text += `- [${report.config.phase}, N=${report.config.count}](${input}): ${report.sourceHead}, delta ${report.sourceDeltaSha256}, ${report.backend}, ${report.timingQualification}.\n`;
await writeFile(output, text, { flag: 'wx' });
console.log(output);
