import type { ToolJsonSchema } from '@forgeax/engine-tool-runtime';
import { environmentOf, type ToolEnvironment } from './environment';
import type {
  CaptureReport,
  SessionSummary,
  SessionValidation,
  ValidationFinding,
} from './protocol';

/** Version tag of the `model.validate` report. */
export const MODEL_VALIDATE_REPORT = 'forgeax.model.validate/2';

export type ValidateStatus = 'pass' | 'warn' | 'fail';

export interface ModelValidateReport {
  readonly schema: typeof MODEL_VALIDATE_REPORT;
  readonly environment: ToolEnvironment;
  readonly source: string;
  readonly values: Readonly<Record<string, unknown>>;
  /** `fail`: build failed, a session is poisoned or has an error; `warn`: a confirmed warning or a warning diagnostic of an operation (info diagnostics, such as compute-job reports, do not count). */
  readonly status: ValidateStatus;
  readonly build: CaptureReport['build'];
  readonly sessions: readonly {
    readonly index: number;
    readonly output?: string;
    readonly status: ValidateStatus;
    readonly mesh: {
      readonly faces: number;
      readonly edges: number;
      readonly vertices: number;
      readonly boundaryEdges: number;
      readonly closed: boolean;
      readonly volume: number;
    };
    readonly poisoned?: SessionSummary['poisoned'];
    readonly issues: readonly ValidationFinding[];
    readonly issuesTruncated: boolean;
    readonly operations: SessionValidation['operations'];
  }[];
}

function sessionStatus(session: SessionSummary, validation: SessionValidation): ValidateStatus {
  if (session.poisoned !== undefined) return 'fail';
  const issues = validation.issues;
  if (issues.some((i) => i.severity === 'error')) return 'fail';
  if (issues.some((i) => i.severity === 'warn' && i.certainty === 'confirmed')) return 'warn';
  const warned = validation.operations.some((op) =>
    (op.diagnostics as { severity?: string }[]).some((d) => d.severity === 'warn'),
  );
  return warned ? 'warn' : 'pass';
}

const RANK: Readonly<Record<ValidateStatus, number>> = { pass: 0, warn: 1, fail: 2 };

export function validateReport(
  capture: CaptureReport,
  source: string,
  values: Readonly<Record<string, unknown>>,
): ModelValidateReport {
  const sessions = capture.sessions.map((session) => {
    const validation = session.validation;
    if (validation === undefined)
      throw new Error('validateReport needs a capture with validate set');
    return {
      index: session.index,
      ...(session.output === undefined ? {} : { output: session.output }),
      status: sessionStatus(session, validation),
      mesh: {
        faces: session.faces,
        edges: session.edges,
        vertices: session.vertices,
        boundaryEdges: validation.boundaryEdges,
        closed: validation.closed,
        volume: validation.volume,
      },
      ...(session.poisoned === undefined ? {} : { poisoned: session.poisoned }),
      issues: validation.issues,
      issuesTruncated: validation.issuesTruncated,
      operations: validation.operations,
    };
  });
  const worst = sessions.reduce<ValidateStatus>(
    (status, s) => (RANK[s.status] > RANK[status] ? s.status : status),
    'pass',
  );
  return {
    schema: MODEL_VALIDATE_REPORT,
    environment: environmentOf(),
    source,
    values,
    status: capture.build.ok ? worst : 'fail',
    build: capture.build,
    sessions,
  };
}

const site: ToolJsonSchema = {
  type: 'object',
  required: ['path', 'line', 'column'],
  properties: {
    path: { type: 'string', description: 'Project-relative when inside the project' },
    line: { type: 'integer', minimum: 1 },
    column: { type: 'integer', minimum: 1 },
  },
};
const failureSchema: ToolJsonSchema = {
  type: 'object',
  required: ['code', 'expected', 'hint'],
  properties: {
    code: { type: 'string' },
    expected: { type: 'string' },
    hint: { type: 'string' },
    source: site,
  },
};
const status: ToolJsonSchema = { enum: ['pass', 'warn', 'fail'] };

/** JSON schema of {@link ModelValidateReport} in the ToolRuntime schema vocabulary. */
export const MODEL_VALIDATE_REPORT_SCHEMA: ToolJsonSchema = {
  type: 'object',
  required: ['schema', 'source', 'values', 'status', 'build', 'sessions'],
  properties: {
    schema: { const: MODEL_VALIDATE_REPORT },
    environment: {
      type: 'object',
      required: ['kernel'],
      properties: { kernel: { type: 'string' } },
    },
    source: { type: 'string' },
    values: { type: 'object' },
    status,
    build: {
      type: 'object',
      required: ['ok', 'outputs'],
      properties: {
        ok: { type: 'boolean' },
        outputs: { type: 'array', items: { type: 'string' } },
        error: failureSchema,
      },
    },
    sessions: {
      type: 'array',
      items: {
        type: 'object',
        required: ['index', 'status', 'mesh', 'issues', 'issuesTruncated', 'operations'],
        properties: {
          index: { type: 'integer', minimum: 0 },
          output: { type: 'string' },
          status,
          mesh: {
            type: 'object',
            required: ['faces', 'edges', 'vertices', 'boundaryEdges', 'closed', 'volume'],
            properties: {
              faces: { type: 'integer', minimum: 0 },
              edges: { type: 'integer', minimum: 0 },
              vertices: { type: 'integer', minimum: 0 },
              boundaryEdges: { type: 'integer', minimum: 0 },
              closed: { type: 'boolean' },
              volume: { type: 'number' },
            },
          },
          poisoned: failureSchema,
          issues: {
            type: 'array',
            items: {
              type: 'object',
              required: ['code', 'severity', 'certainty', 'location'],
              properties: {
                code: { type: 'string' },
                severity: { enum: ['error', 'warn', 'info'] },
                certainty: { enum: ['confirmed', 'candidate'] },
                location: {
                  type: 'object',
                  properties: {
                    faces: { type: 'array', items: { type: 'integer', minimum: 0 } },
                    vertices: { type: 'array', items: { type: 'integer', minimum: 0 } },
                    point: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
                    createdBy: {
                      type: 'object',
                      required: ['label', 'role'],
                      properties: { label: { type: 'string' }, role: { type: 'string' } },
                    },
                    source: site,
                  },
                },
              },
            },
          },
          issuesTruncated: { type: 'boolean' },
          operations: {
            type: 'array',
            items: {
              type: 'object',
              required: ['opIndex', 'op', 'diagnostics'],
              properties: {
                opIndex: { type: 'integer', minimum: 0 },
                op: { type: 'string' },
                label: { type: 'string' },
                source: site,
                diagnostics: { type: 'array' },
              },
            },
          },
        },
      },
    },
  },
};
