// Pure projection of run.mjs reports into scenario-matrix rows and Markdown. No process or filesystem access.
export const mib = n => n === undefined || n === null ? 'n/a' : (n / 1048576).toFixed(1);
export const ms = n => n === undefined || n === null || !Number.isFinite(n) ? 'n/a' : n >= 100 ? n.toFixed(0) : n.toFixed(2);
export const kib = n => n === undefined || n === null ? 'n/a' : n >= 1048576 ? `${(n / 1048576).toFixed(1)}M` : `${(n / 1024).toFixed(1)}K`;
const median = values => values.length === 0 ? undefined : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const liveObjects = metrics => metrics?.objects === undefined ? undefined
  : Object.entries(metrics.objects.byType).filter(([key]) => ['object', 'array', 'closure'].includes(key)).reduce((n, [, value]) => n + value.count, 0);

// One matrix cell from one report. `status` is 'complete' only when the measured window finished.
export function summarize(report, meta = {}) {
  const base = { cell: meta.cell ?? report.config?.cell, scenario: report.config?.scenario ?? report.config?.phase, count: report.config?.count, dirty: report.config?.dirty,
    status: report.status, uptime: meta.uptime, rerun: meta.rerun ?? false, outDir: meta.outDir };
  if (report.status !== 'complete') return { ...base, failure: report.failure?.message ?? 'no report' };
  const frames = report.raw.length, s = report.statistics, sm = report.sourceMetrics, rm = report.renderMetrics;
  const row = key => ({ p50: s[key].p50, p95: s[key].p95, max: s[key].max });
  return { ...base, frames,
    source: row('sourceThreadCpuMs'), render: row('renderThreadCpuMs'), total: row('totalThreadCpuMs'), endToEnd: row('endToEndMs'),
    allocPerFrame: { source: sm?.allocatedHeapBytes == null ? undefined : sm.allocatedHeapBytes / frames, render: rm?.allocatedHeapBytes == null ? undefined : rm.allocatedHeapBytes / frames },
    gc: { count: (sm?.gc.count ?? 0) + (rm?.gc.count ?? 0), ms: (sm?.gc.durationMs ?? 0) + (rm?.gc.durationMs ?? 0) },
    heapUsed: { source: sm?.peakHeapUsed, render: rm?.peakHeapUsed }, rss: rm?.peakProcessRss,
    live: { source: liveObjects(sm), render: liveObjects(rm) },
    transferBytesPerFrame: median(report.raw.map(r => r.counts.transferBytes)), logicalBytesPerFrame: median(report.raw.map(r => r.counts.logicalColumnBytes)),
    startupMs: report.startupMs, rhi: report.rhiCommandsPerFrame, recovery: report.recovery, timing: report.timingQualification };
}

const rhi = (r, key) => r.rhi === undefined ? 'n/a' : r.rhi[key] >= 100 ? r.rhi[key].toFixed(0) : r.rhi[key].toFixed(1);
export const columns = [
  ['cell', r => r.cell], ['N', r => r.count], ['D', r => r.dirty],
  ['src p50', r => ms(r.source.p50)], ['src p95', r => ms(r.source.p95)], ['src max', r => ms(r.source.max)],
  ['rnd p50', r => ms(r.render.p50)], ['rnd p95', r => ms(r.render.p95)], ['rnd max', r => ms(r.render.max)],
  ['alloc src B/f', r => kib(r.allocPerFrame.source)], ['alloc rnd B/f', r => kib(r.allocPerFrame.render)],
  ['GC n/ms', r => `${r.gc.count}/${ms(r.gc.ms)}`], ['heap src/rnd MiB', r => `${mib(r.heapUsed.source)}/${mib(r.heapUsed.render)}`],
  ['live src/rnd', r => `${kib(r.live.source)}/${kib(r.live.render)}`], ['xfer B/f', r => kib(r.transferBytesPerFrame)], ['startup ms', r => ms(r.startupMs)],
  ['draws/f', r => rhi(r, 'draws')], ['submits/f', r => rhi(r, 'submits')], ['bufWr B/f', r => r.rhi === undefined ? 'n/a' : kib(r.rhi.bufferWriteBytes)],
  ['texWr B/f', r => r.rhi === undefined ? 'n/a' : kib(r.rhi.textureWriteBytes)], ['load', r => r.uptime ?? ''], ['flag', r => r.rerun ? 'rerun' : ''],
];

export function table(rows) {
  const ok = rows.filter(r => r.status === 'complete');
  let text = `| ${columns.map(c => c[0]).join(' | ')} |\n|${columns.map(() => '--:').join('|')}|\n`;
  for (const r of rows) {
    if (r.status !== 'complete') { text += `| ${r.cell} | ${r.count} | ${r.dirty} | FAILED: ${String(r.failure).replaceAll('|', '/').slice(0, 160)} |${' |'.repeat(columns.length - 4)}\n`; continue; }
    text += `| ${columns.map(c => c[1](r)).join(' | ')} |\n`;
  }
  return { text, complete: ok.length, failed: rows.length - ok.length };
}

// Growth of render+source CPU and render allocation between adjacent N of one cell (same D rule).
export function growth(rows) {
  const byCell = new Map();
  for (const r of rows) if (r.status === 'complete') (byCell.get(r.cell) ?? byCell.set(r.cell, []).get(r.cell)).push(r);
  const out = [];
  for (const [cell, list] of byCell) {
    list.sort((a, b) => a.count - b.count);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const cpu = (b.total.p50 + 1e-9) / (a.total.p50 + 1e-9);
      const alloc = ((b.allocPerFrame.render ?? 0) + (b.allocPerFrame.source ?? 0)) / (((a.allocPerFrame.render ?? 0) + (a.allocPerFrame.source ?? 0)) || 1);
      out.push({ cell, from: a.count, to: b.count, nRatio: b.count / a.count, cpuRatio: cpu, allocRatio: alloc,
        // Fixed-D cells should stay near 1; a CPU ratio above 1.5 at fixed D is a scaling suspect.
        fixedD: a.dirty === b.dirty, cpuAbs: b.total.p50 });
    }
  }
  return out;
}

// Worst cells: cost grows with N at fixed D (>1.5x CPU for >=10x N and >0.5 ms absolute), or allocation/GC is large at small N.
export function worstCells(rows, { smallN = 1000, allocBytes = 8 * 1048576 } = {}) {
  const findings = [];
  for (const g of growth(rows)) if (g.fixedD && g.nRatio >= 10 && g.cpuRatio > 1.5 && g.cpuAbs > 0.5) findings.push({ kind: 'cpu-grows-with-N', score: g.cpuRatio, ...g });
  for (const r of rows) if (r.status === 'complete' && r.count <= smallN) {
    const alloc = (r.allocPerFrame.render ?? 0) + (r.allocPerFrame.source ?? 0);
    if (alloc > allocBytes) findings.push({ kind: 'alloc-at-small-N', score: alloc / allocBytes, cell: r.cell, from: r.count, to: r.count, alloc, gcMs: r.gc.ms });
  }
  return findings.sort((a, b) => b.score - a.score);
}

export function markdown(rows, { title, notes = [] } = {}) {
  const { text } = table(rows);
  let md = `# ${title ?? 'Scenario matrix'}\n\n${notes.map(n => `> ${n}`).join('\n')}\n\n`;
  md += 'CPU columns are per-thread CPU ms (p50/p95/max over measured frames); alloc is V8 allocated heap bytes per frame; live is the post-window heap census of object+array+closure nodes; xfer is transferred buffer capacity per frame to the render thread; draws/submits/bufWr/texWr are stub-backend command counts and upload bytes per frame.\n\n';
  md += text;
  const g = growth(rows).filter(x => x.nRatio >= 5);
  if (g.length) {
    md += '\n## Growth between adjacent sizes\n\n| cell | N from | N to | total CPU p50 x | alloc x |\n|--|--:|--:|--:|--:|\n';
    for (const x of g) md += `| ${x.cell} | ${x.from} | ${x.to} | ${x.cpuRatio.toFixed(2)} | ${x.allocRatio.toFixed(2)} |\n`;
  }
  const recovered = rows.filter(r => r.status === 'complete' && r.recovery !== undefined);
  if (recovered.length) {
    md += '\n## Device-loss recovery\n\n| cell | N | recover() ms | pending frames | first ready frame ms | state after |\n|--|--:|--:|--:|--:|--|\n';
    for (const r of recovered) md += `| ${r.cell} | ${r.count} | ${ms(r.recovery.recoverMs)} | ${r.recovery.pendingFrames} | ${ms(r.recovery.firstReadyFrame?.ms)} | ${r.recovery.stateAfter} |\n`;
  }
  const worst = worstCells(rows);
  if (worst.length) {
    md += '\n## Worst cells\n';
    md += '\nThresholds: CPU grows more than 1.5x (and above 0.5 ms) for 10x N at fixed D; allocation above 8 MiB/frame at N <= 1000 (every cell allocates a 3 to 5 MiB/frame floor even at N=10 static).\n\n| kind | cell | N | score | detail |\n|--|--|--:|--:|--|\n';
    for (const w of worst.slice(0, 30)) md += `| ${w.kind} | ${w.cell} | ${w.from}${w.to === w.from ? '' : `->${w.to}`} | ${w.score.toFixed(2)} | ${w.kind === 'cpu-grows-with-N' ? `CPU x${w.cpuRatio.toFixed(2)} for N x${w.nRatio}` : `${kib(w.alloc)} B/frame, GC ${ms(w.gcMs)} ms`} |\n`;
  }
  return md;
}
