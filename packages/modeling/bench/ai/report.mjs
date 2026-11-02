import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

// Aggregates runs, collection and blind review into reports/ai-benchmark.{json,md}, a short
// summary JSON and side-by-side evidence sheets (tools left, control right).

const here = import.meta.dirname;
const modelingRoot = resolve(here, '../..');
const engineRoot = resolve(modelingRoot, '../..');
const { PNG } = createRequire(join(engineRoot, 'package.json'))('pngjs');
const protocol = JSON.parse(readFileSync(join(here, 'protocol.json'), 'utf8'));
const briefSet = JSON.parse(readFileSync(join(here, 'briefs.json'), 'utf8'));

const { values: args } = parseArgs({
  options: {
    root: { type: 'string', default: '/tmp/m5-runs' },
    out: { type: 'string', default: join(modelingRoot, 'reports') },
    evidence: { type: 'string' },
    summary: { type: 'string', default: '/tmp/m5-summary.json' },
    engineCommit: { type: 'string', default: 'unknown' },
    modelingCommit: { type: 'string', default: 'unknown' },
  },
});

const mean = (values) => {
  const finite = values.filter((v) => typeof v === 'number' && Number.isFinite(v));
  return finite.length === 0 ? null : finite.reduce((s, v) => s + v, 0) / finite.length;
};
const round = (value, digits = 2) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits;

function runRecords(review) {
  return readdirSync(args.root)
    .filter((name) => existsSync(join(args.root, name, 'collect.json')))
    .sort()
    .map((name) => {
      const run = JSON.parse(readFileSync(join(args.root, name, 'run.json'), 'utf8'));
      const collect = JSON.parse(readFileSync(join(args.root, name, 'collect.json'), 'utf8'));
      const passes = review.passes.map((p) => p.scores[name]).filter(Boolean);
      const full = mean(passes.map((p) => mean(Object.values(p.scores))));
      const subset = mean(
        passes.map((p) => mean(protocol.rubric.geometrySubset.map((id) => p.scores[id]))),
      );
      const facts = collect.measure.facts;
      return {
        run: name,
        brief: run.brief,
        condition: run.condition,
        completed: collect.completed,
        failedChecks: (collect.measure.checks ?? [])
          .filter((c) => !c.pass)
          .map((c) => (c.kind === 'size' ? `size-${c.axis}` : c.kind)),
        buildError: collect.measure.build.ok ? null : collect.measure.build.error,
        closedValid: collect.measure.closedValid ?? false,
        validateStatus: collect.validate?.status ?? null,
        validateIssues: collect.validate?.issues ?? {},
        violations: collect.violations,
        triangles: facts?.triangles ?? null,
        components: facts?.components ?? null,
        genus: facts?.genus ?? null,
        zeroAreaTriangles: facts?.zeroAreaTriangles ?? null,
        completedMeasureOnly:
          collect.measure.build.ok &&
          collect.measure.closedValid === true &&
          collect.measure.checksPass === true &&
          collect.violations.length === 0,
        commands: {
          forgeaxModel: run.bashCommands.filter((c) => c.includes('forgeax model')).length,
          forgeaxModelRender: run.bashCommands.filter((c) =>
            /forgeax model (render|replay)/.test(c),
          ).length,
          check: run.bashCommands.filter((c) => c.includes('check.mjs')).length,
        },
        agentProtocol: run.protocol,
        size: facts?.size ?? null,
        turns: run.turns,
        wallSeconds: round(run.wallSeconds, 0),
        terminalReason: run.terminalReason,
        timedOut: run.timedOut,
        costUsd: round(run.costUsd, 2),
        tokens: run.tokens,
        humanInterventions: run.humanInterventions,
        rubric: {
          full: round(full),
          geometrySubset: round(subset),
          briefFidelity: round(mean(passes.map((p) => p.briefFidelity))),
          imputed: passes.some((p) => p.imputed === true),
          passes: passes.map((p) => ({
            anonymousId: p.anonymousId,
            scores: p.scores,
            briefFidelity: p.briefFidelity,
            note: p.note,
          })),
        },
      };
    });
}

function conditionSummary(runs) {
  const n = runs.length;
  const completed = runs.filter((r) => r.completed).length;
  return {
    runs: n,
    completed,
    completionRate: n === 0 ? null : round(completed / n),
    completedMeasureOnly: runs.filter((r) => r.completedMeasureOnly).length,
    meanTurns: round(mean(runs.map((r) => r.turns)), 1),
    meanWallSeconds: round(mean(runs.map((r) => r.wallSeconds)), 0),
    totalCostUsd: round(runs.reduce((s, r) => s + (r.costUsd ?? 0), 0)),
    outputTokens: runs.reduce((s, r) => s + (r.tokens.output ?? 0), 0),
    humanInterventions: runs.reduce((s, r) => s + r.humanInterventions, 0),
    rubricFull: round(mean(runs.map((r) => r.rubric.full))),
    rubricGeometrySubset: round(mean(runs.map((r) => r.rubric.geometrySubset))),
    briefFidelity: round(mean(runs.map((r) => r.rubric.briefFidelity))),
  };
}

function judgeAgreement(runs) {
  const pairs = runs
    .filter((r) => !r.rubric.imputed && r.rubric.passes.length >= 2)
    .map((r) => [r.rubric.passes[0], r.rubric.passes[1]]);
  const items = pairs.flatMap(([a, b]) =>
    protocol.rubric.items.map((item) => Math.abs(a.scores[item.id] - b.scores[item.id])),
  );
  return {
    scoredRuns: pairs.length,
    meanAbsItemDifference: round(mean(items)),
    exactItemAgreement:
      items.length === 0 ? null : round(items.filter((d) => d === 0).length / items.length),
    meanAbsRunMeanDifference: round(
      mean(
        pairs.map(([a, b]) =>
          Math.abs(mean(Object.values(a.scores)) - mean(Object.values(b.scores))),
        ),
      ),
    ),
  };
}

function verdict(tools, control) {
  const notWorse =
    tools.completionRate >= control.completionRate && tools.rubricFull >= control.rubricFull - 0.25;
  const direction = notWorse ? 'tools-not-worse' : 'tools-worse';
  const enough = Math.min(tools.runs, control.runs) >= protocol.verdict.minRunsPerCondition;
  return {
    verdict: enough ? (notWorse ? 'pass' : 'fail') : 'inconclusive',
    direction,
    reason: enough
      ? protocol.verdict.rule
      : `${Math.min(tools.runs, control.runs)} runs per condition is below the ${protocol.verdict.minRunsPerCondition} the protocol requires for a verdict; only the direction is reported`,
  };
}

function sideBySide(left, right, path) {
  const a = PNG.sync.read(readFileSync(left));
  const b = PNG.sync.read(readFileSync(right));
  const gap = 16;
  const out = new PNG({ width: a.width + gap + b.width, height: Math.max(a.height, b.height) });
  out.data.fill(255);
  PNG.bitblt(a, out, 0, 0, a.width, a.height, 0, 0);
  PNG.bitblt(b, out, 0, 0, b.width, b.height, a.width + gap, 0);
  writeFileSync(path, PNG.sync.write(out));
}

function writeEvidence(runs) {
  const dir = args.evidence;
  mkdirSync(dir, { recursive: true });
  const index = [];
  for (const brief of briefSet.briefs) {
    const pair = {};
    for (const condition of ['tools', 'control']) {
      const run = runs.find((r) => r.brief === brief.id && r.condition === condition);
      if (run === undefined) continue;
      const sheet = join(args.root, run.run, '.bench/render/sheet.png');
      if (existsSync(sheet)) {
        const file = `${brief.id}--${condition}.png`;
        copyFileSync(sheet, join(dir, file));
        pair[condition] = file;
      }
    }
    let combined = null;
    if (pair.tools !== undefined && pair.control !== undefined) {
      combined = `${brief.id}--tools-left-control-right.png`;
      sideBySide(join(dir, pair.tools), join(dir, pair.control), join(dir, combined));
    }
    index.push({ brief: brief.id, ...pair, sideBySide: combined });
  }
  writeFileSync(
    join(dir, 'index.json'),
    `${JSON.stringify(
      {
        schema: 'forgeax.ai-benchmark.evidence/1',
        note: 'M5 pilot renders: forgeax model render sheets (front, right, top, iso) of each delivered mesh lifted into one neutral slot; side-by-side files put the tools run left and the control run right. Report: forgeax-modeling reports/ai-benchmark.md.',
        briefSet: briefSet.version,
        protocol: protocol.version,
        entries: index,
      },
      null,
      2,
    )}\n`,
  );
}

const fmt = (v) => (v === null || v === undefined ? '-' : String(v));

function markdown(report) {
  const { tools, control } = report.conditions;
  const lines = [
    '# M5 AI benchmark: pilot',
    '',
    '> [!WARNING]',
    `> Pilot only: ${tools.runs} run(s) per condition, one run per brief. The verdict is **${report.verdict.verdict}** by protocol; the numbers show what happened in these runs, not a measured difference between the conditions.`,
    '',
    `Brief set \`${report.briefSet}\`, protocol \`${report.protocol}\` (agent runs used \`${[...new Set(report.runs.map((r) => r.agentProtocol))].join(', ')}\`; amendments: ${(protocol.amendments ?? []).map((m) => m.version).join(', ') || 'none'}), model \`${protocol.agent.model}\` (effort ${protocol.agent.effort}), caps ${protocol.agent.maxTurns} turns / ${protocol.agent.wallClockSeconds / 60} min / $${protocol.agent.maxBudgetUsd} per run. Engine \`${report.versions.engine}\`, modeling \`${report.versions.modeling}\`. Generated by \`bench/ai/report.mjs\`; protocol in \`bench/ai/README.md\`.`,
    '',
    '## Conditions',
    '',
    '| | Tools (modeling kernel + `forgeax model`) | Control (`createMeshBuilder` by hand) |',
    '|:--|--:|--:|',
    `| Completed | ${tools.completed}/${tools.runs} | ${control.completed}/${control.runs} |`,
    `| Completed without the lifted-validate term (sensitivity) | ${tools.completedMeasureOnly}/${tools.runs} | ${control.completedMeasureOnly}/${control.runs} |`,
    `| Mean turns | ${fmt(tools.meanTurns)} | ${fmt(control.meanTurns)} |`,
    `| Mean wall time (s) | ${fmt(tools.meanWallSeconds)} | ${fmt(control.meanWallSeconds)} |`,
    `| Cost (USD, total) | ${fmt(tools.totalCostUsd)} | ${fmt(control.totalCostUsd)} |`,
    `| Output tokens (total) | ${fmt(tools.outputTokens)} | ${fmt(control.outputTokens)} |`,
    `| Human interventions | ${tools.humanInterventions} | ${control.humanInterventions} |`,
    `| RUBRIC mean, 8 items (LLM judge) | ${fmt(tools.rubricFull)} | ${fmt(control.rubricFull)} |`,
    `| RUBRIC geometry subset (readability, richness, craft) | ${fmt(tools.rubricGeometrySubset)} | ${fmt(control.rubricGeometrySubset)} |`,
    `| Brief fidelity (judge, supplementary) | ${fmt(tools.briefFidelity)} | ${fmt(control.briefFidelity)} |`,
    '',
    `Verdict: **${report.verdict.verdict}** (direction: ${report.verdict.direction}). ${report.verdict.reason}.`,
    '',
    '## Runs',
    '',
    '| Brief | Condition | Done | Failed checks | Validate | Tris | Zero-area | Parts | Genus | Turns | `model` calls (render) | Time (s) | End | RUBRIC | Geometry | Fidelity |',
    '|:--|:--|:-:|:--|:--|--:|--:|--:|--:|--:|--:|--:|:--|--:|--:|--:|',
    ...report.runs.map(
      (r) =>
        `| ${r.brief} | ${r.condition} | ${r.completed ? 'yes' : 'no'} | ${
          r.buildError !== null ? 'build failed' : r.failedChecks.join(', ') || '-'
        }${r.closedValid || r.buildError !== null ? '' : ' (not closed/manifold)'}${
          r.violations.length > 0 ? ' (protocol violation)' : ''
        } | ${fmt(r.validateStatus)} | ${fmt(r.triangles)} | ${fmt(r.zeroAreaTriangles)} | ${fmt(r.components)} | ${fmt(r.genus)} | ${r.turns} | ${r.commands.forgeaxModel} (${r.commands.forgeaxModelRender}) | ${r.wallSeconds} | ${fmt(r.terminalReason)} | ${fmt(r.rubric.full)} | ${fmt(r.rubric.geometrySubset)} | ${fmt(r.rubric.briefFidelity)} |`,
    ),
    '',
    `Judge consistency over ${report.judgeAgreement.scoredRuns} rendered runs and two shuffled passes: mean absolute item difference ${fmt(report.judgeAgreement.meanAbsItemDifference)}, exact item agreement ${fmt(report.judgeAgreement.exactItemAgreement)}, mean absolute difference of a run's mean ${fmt(report.judgeAgreement.meanAbsRunMeanDifference)}.`,
    '',
    '## What this shows and what it does not',
    '',
    ...report.limits.map((limit) => `- ${limit}`),
    '',
  ];
  return lines.join('\n');
}

function main() {
  const review = JSON.parse(readFileSync(join(args.root, 'review.json'), 'utf8'));
  const runs = runRecords(review);
  const tools = conditionSummary(runs.filter((r) => r.condition === 'tools'));
  const control = conditionSummary(runs.filter((r) => r.condition === 'control'));
  const report = {
    schema: 'forgeax.ai-benchmark.report/1',
    generated: new Date().toISOString().slice(0, 10),
    kind: 'pilot',
    briefSet: briefSet.version,
    protocol: protocol.version,
    versions: { engine: args.engineCommit, modeling: args.modelingCommit },
    agent: protocol.agent,
    review: {
      judge: protocol.review.judge,
      passes: review.passes.map((p) => ({
        pass: p.pass,
        seed: p.seed,
        judgeTurns: p.judgeTurns,
        judgeCostUsd: round(p.judgeCostUsd),
        judgeSeconds: round(p.judgeSeconds, 0),
      })),
      proxyNote: protocol.review.proxyNote,
      rubricNote: protocol.rubric.note,
    },
    conditions: { tools, control },
    verdict: verdict(tools, control),
    judgeAgreement: judgeAgreement(runs),
    runs,
    limits: [
      `n is tiny: ${tools.runs} run(s) per condition, one per brief, one seed. Run-to-run variance of the same agent on the same brief is unmeasured, so no difference here is statistically meaningful.`,
      "The blind review is an LLM judge (same model family as the agents), a proxy for the human blind review that design section 15 asks for; it may share the agents' biases. Two shuffled passes measure only its self-consistency.",
      'The RUBRIC was written for game shots. Camera, lights and the single neutral material are fixed by the harness, so composition, lighting, material and effects mostly score the harness; the geometry subset (readability, richness, craft) is the part the agent controls.',
      'The conditions differ in more than the kernel: the tools group also has rendered feedback (`forgeax model render`), a skill and worked examples (several close to the briefs, for example the bracket and door-hinge cases), while the control group sees only numeric `node check.mjs` output. The result measures the whole toolchain package against hand-written triangles, as the design defines the control.',
      'Completion uses topological and dimensional checks (closed, manifold, oriented, part count, genus, bounding box) plus `forgeax model validate` on the lifted mesh; it does not prove that every described feature (gussets, countersinks, lips) is present. Brief fidelity from the judge is a supplementary signal only.',
      'Protocol amendment 1.1 (collection only, agent inputs unchanged) renders review images through a wrapper that drops zero-area triangles, after the control housing (4 collinear triangles) failed the strict lift and would otherwise have been scored 1 on every RUBRIC item without an image. Its completion still fails by the frozen rule; the sensitivity row shows completion without the lifted-validate term, which the control could not run itself.',
      'Both conditions saw the measurable checks and the `node check.mjs` measurement, so completion partly measures how well each path reaches stated numbers under the caps.',
    ],
  };
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'ai-benchmark.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(args.out, 'ai-benchmark.md'), markdown(report));
  if (args.evidence !== undefined) writeEvidence(runs);
  const summary = {
    schema: 'forgeax.ai-benchmark.summary/1',
    kind: 'pilot',
    completion: {
      tools: `${tools.completed}/${tools.runs}`,
      control: `${control.completed}/${control.runs}`,
    },
    meanRubric: { tools: tools.rubricFull, control: control.rubricFull },
    meanRubricGeometrySubset: {
      tools: tools.rubricGeometrySubset,
      control: control.rubricGeometrySubset,
    },
    meanTurns: { tools: tools.meanTurns, control: control.meanTurns },
    verdict: report.verdict.verdict,
    direction: report.verdict.direction,
  };
  writeFileSync(args.summary, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
