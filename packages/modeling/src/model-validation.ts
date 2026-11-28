import { err } from '@forgeax/engine-types';
import type { ResolvedDrawing } from './drawing';
import { checkDrawings } from './drawing-check';
import { checkEdgeFlow } from './edge-flow';
import { modelingError } from './errors';
import { checkLayout, type LayoutFit, type ResolvedLayout } from './layout';
import type { EditMesh } from './mesh';
import type { JournalEntry } from './model-helpers';
import { qualityPoint } from './model-helpers';
import type { NurbsSurface } from './nurbs';
import type { Issue } from './report';
import { measureShutLines, shutLineChecks } from './shut-lines';
import { checkSurfaceQuality, type FeatureLine, type NamedSurface } from './surface-quality';
import {
  CoverageLedger,
  mergeCoverage,
  type ValidateOptions,
  type ValidationCode,
  type ValidationReport,
  validateMesh,
} from './validate';

/** A declared patch layout, with its matched patches once `surface({ layout })` built them. */
export interface DeclaredLayout {
  resolved: ResolvedLayout;
  opIndex: number;
  built?: Map<string, NurbsSurface>;
  /** Quads of the layout's setback corners, by corner name. */
  corners?: Map<string, NurbsSurface[]>;
  fits?: Map<string, LayoutFit>;
}

export interface ValidationInputs {
  readonly mesh: EditMesh;
  readonly tolerance: number;
  readonly entries: readonly JournalEntry[];
  readonly drawings: readonly ResolvedDrawing[];
  readonly surfaces: readonly NamedSurface[];
  readonly featureLines: readonly FeatureLine[];
  readonly qualitySources: ReadonlyMap<string, number>;
  readonly layouts: readonly DeclaredLayout[];
}

function withCoverage(
  report: ValidationReport,
  fill: (ledger: CoverageLedger) => void,
): ValidationReport {
  const ledger = new CoverageLedger();
  fill(ledger);
  const coverage = mergeCoverage(report.coverage, ledger.coverage());
  return { ...report, coverage, pass: report.pass && coverage.checked.length > 0 };
}

function declared(ledger: CoverageLedger, code: ValidationCode, names: readonly string[]): void {
  if (names.length > 0) ledger.run(code, names);
  else {
    ledger.enumerated[code] = ['mesh'];
    ledger.skip(code, 'mesh', 'missing-input');
  }
}

export function validateShutLines(
  inputs: ValidationInputs,
  report: ValidationReport,
  options: ValidateOptions,
): ValidationReport {
  if (options.shutLines === undefined)
    return withCoverage(report, (ledger) => ledger.off('shut-line', 'not-requested'));
  const measured = measureShutLines(inputs.mesh, options.shutLines, inputs.drawings);
  const issues: Issue<ValidationCode>[] = measured.ok
    ? measured.value.rows.flatMap((r): Issue<ValidationCode>[] => {
        const out: Issue<ValidationCode>[] = [];
        if (r.status === 'fail' || r.status === 'unmeasured')
          out.push({ code: 'shut-line', severity: 'error', detail: { ...r } });
        if (r.status === 'excepted')
          out.push({ code: 'shut-line', severity: 'warn', detail: { check: 'excepted', ...r } });
        const unused =
          r.exception === undefined || r.status === 'unmeasured'
            ? []
            : shutLineChecks(r.exception.limits).filter(
                (c) => !r.excepted.includes(c) && !r.failures.includes(c),
              );
        if (unused.length > 0)
          out.push({
            code: 'shut-line',
            severity: 'warn',
            detail: { check: 'exception-unused', id: r.id, unused, exception: r.exception },
          });
        return out;
      })
    : [
        {
          code: 'shut-line',
          severity: 'error',
          detail: { check: 'options', error: measured.error },
        },
      ];
  const rows = options.shutLines.table.map((r) => r.id);
  return withCoverage(
    {
      ...report,
      pass: report.pass && measured.ok && measured.value.pass,
      issues: [...report.issues, ...issues],
    },
    (ledger) => {
      ledger.enumerated['shut-line'] = rows;
      if (!measured.ok) {
        for (const id of rows) ledger.skip('shut-line', id, 'missing-input');
        return;
      }
      const done = new Set<string>();
      for (const r of measured.value.rows) {
        if (r.status === 'unmeasured') ledger.skip('shut-line', r.id, 'missing-input');
        else done.add(r.id);
      }
      ledger.evaluated['shut-line'] = done;
    },
  );
}

export function validateDrawings(
  inputs: ValidationInputs,
  report: ValidationReport,
  options: ValidateOptions,
): ValidationReport {
  if (options.drawing === undefined || options.drawing === false)
    return withCoverage(report, (ledger) => ledger.off('drawing', 'not-requested'));
  const findings = checkDrawings(
    inputs.mesh,
    inputs.tolerance,
    inputs.drawings,
    inputs.featureLines,
    options.drawing === true ? {} : options.drawing,
  );
  const issues: Issue<ValidationCode>[] = findings.map((f) => ({
    code: 'drawing',
    severity: 'warn',
    detail: { ...f },
  }));
  return withCoverage({ ...report, issues: [...report.issues, ...issues] }, (ledger) =>
    declared(
      ledger,
      'drawing',
      inputs.drawings.map((d) => d.name),
    ),
  );
}

export function validateShellClearance(
  inputs: ValidationInputs,
  report: ValidationReport,
): ValidationReport {
  const issues: Issue<ValidationCode>[] = inputs.entries.flatMap((entry) =>
    (entry.diagnostics ?? []).flatMap((d) =>
      d.detail?.nearWalls === undefined
        ? []
        : [
            {
              code: 'thin-wall' as const,
              severity: 'warn' as const,
              detail: {
                check: 'shell-clearance',
                opIndex: entry.opIndex,
                thickness: d.detail.thickness,
                clearance: d.detail.clearance,
                relieved: d.detail.relieved,
                count: d.detail.nearCount,
                walls: d.detail.nearWalls,
                point: d.detail.point,
              },
            },
          ],
    ),
  );
  const shells = inputs.entries
    .filter((entry) => entry.op === 'shell' && entry.status === 'ok')
    .map((entry) => `op${entry.opIndex}`);
  return withCoverage(
    issues.length === 0 ? report : { ...report, issues: [...report.issues, ...issues] },
    (ledger) => {
      if (shells.length > 0) ledger.run('thin-wall', shells);
    },
  );
}

export function validateLayouts(
  inputs: ValidationInputs,
  report: ValidationReport,
  options: ValidateOptions,
): ValidationReport {
  if (options.layout === undefined || options.layout === false)
    return withCoverage(report, (ledger) => ledger.off('patch-layout', 'not-requested'));
  const layoutOptions = options.layout === true ? {} : options.layout;
  const issues: Issue<ValidationCode>[] = inputs.layouts.flatMap((l) =>
    checkLayout(l.resolved, inputs.featureLines, layoutOptions, {
      ...(l.built === undefined ? {} : { built: l.built }),
      ...(l.corners === undefined ? {} : { corners: l.corners }),
      ...(l.fits === undefined ? {} : { fits: l.fits }),
    }).map((issue) => ({
      code: 'patch-layout' as const,
      severity: 'warn' as const,
      detail: {
        check: issue.code,
        layout: l.resolved.name,
        opIndex: l.opIndex,
        ...issue.detail,
      },
    })),
  );
  return withCoverage({ ...report, issues: [...report.issues, ...issues] }, (ledger) =>
    declared(
      ledger,
      'patch-layout',
      inputs.layouts.map((l) => l.resolved.name),
    ),
  );
}

export function validateEdgeFlow(
  inputs: ValidationInputs,
  report: ValidationReport,
  options: ValidateOptions,
): ValidationReport {
  if (options.edgeFlow === undefined || options.edgeFlow === false)
    return withCoverage(report, (ledger) => ledger.off('edge-flow', 'not-requested'));
  const { lines: extra = [], ...flowOptions } = options.edgeFlow === true ? {} : options.edgeFlow;
  const named = new Set(inputs.featureLines.map((l) => l.name));
  const clash = extra.find(
    (l, i) => named.has(l.name) || extra.findIndex((o) => o.name === l.name) !== i,
  );
  const lines = [...inputs.featureLines, ...extra];
  const flow =
    clash === undefined
      ? checkEdgeFlow(inputs.mesh, lines, flowOptions)
      : err(
          modelingError('model-invalid-argument', 'edgeFlow line names are unique', {
            line: clash.name,
          }),
        );
  const issues: Issue<ValidationCode>[] = flow.ok
    ? flow.value.issues.map((issue) => ({
        code: 'edge-flow',
        severity: issue.severity,
        detail: {
          check: issue.code,
          ...issue.detail,
          ...(issue.code === 'feature-loop'
            ? { opIndex: inputs.qualitySources.get(issue.detail.line as string) }
            : {}),
        },
      }))
    : [{ code: 'edge-flow', severity: 'error', detail: { check: 'options', error: flow.error } }];
  return withCoverage(
    { ...report, pass: report.pass && flow.ok, issues: [...report.issues, ...issues] },
    (ledger) => {
      const subjects = ['mesh', ...lines.map((l) => l.name)];
      if (flow.ok) ledger.run('edge-flow', subjects);
      else {
        ledger.enumerated['edge-flow'] = subjects;
        for (const subject of subjects) ledger.skip('edge-flow', subject, 'missing-input');
      }
    },
  );
}

export function finishSurfaceQualityValidation(
  inputs: ValidationInputs,
  report: ValidationReport,
  options: ValidateOptions,
): ValidationReport {
  if (options.surfaceQuality === undefined || options.surfaceQuality === false)
    return withCoverage(report, (ledger) => ledger.off('surface-quality', 'not-requested'));
  const quality = checkSurfaceQuality(
    { surfaces: inputs.surfaces, curves: inputs.featureLines },
    options.surfaceQuality === true ? {} : options.surfaceQuality,
  );
  const issues: Issue<ValidationCode>[] = quality.ok
    ? quality.value.issues.map((issue) => {
        const owner = (issue.detail.subject as string).split(':')[0] as string;
        const opIndex = inputs.qualitySources.get(owner);
        const point = qualityPoint(issue, inputs.surfaces);
        return {
          code: 'surface-quality',
          severity: 'warn',
          detail: {
            check: issue.code,
            ...(point === undefined ? {} : { point }),
            ...(opIndex === undefined ? {} : { opIndex }),
            ...issue.detail,
          },
        };
      })
    : [
        {
          code: 'surface-quality',
          severity: 'error',
          detail: { check: 'options', error: quality.error },
        },
      ];
  return withCoverage(
    { ...report, pass: report.pass && quality.ok, issues: [...report.issues, ...issues] },
    (ledger) => {
      const subjects = [...inputs.surfaces, ...inputs.featureLines].map((x) => x.name);
      if (quality.ok) ledger.run('surface-quality', subjects.length === 0 ? ['mesh'] : subjects);
      else {
        ledger.enumerated['surface-quality'] = ['mesh'];
        ledger.skip('surface-quality', 'mesh', 'missing-input');
      }
    },
  );
}

/** Run every validation check requested on the session's current mesh and annotations. */
export function runValidationChecks(
  inputs: ValidationInputs,
  options: ValidateOptions,
): ValidationReport {
  const report = validateShellClearance(
    inputs,
    validateDrawings(
      inputs,
      validateShutLines(
        inputs,
        validateLayouts(
          inputs,
          validateEdgeFlow(inputs, validateMesh(inputs.mesh, inputs.tolerance, options), options),
          options,
        ),
        options,
      ),
      options,
    ),
  );
  return finishSurfaceQualityValidation(inputs, report, options);
}
