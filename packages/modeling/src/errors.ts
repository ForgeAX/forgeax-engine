/** Closed failure vocabulary of the modeling kernel. */
export type ModelingErrorCode =
  | 'model-selection-empty'
  | 'model-selection-cardinality'
  | 'model-invalid-argument'
  | 'model-precondition'
  | 'model-degenerate'
  | 'model-op-no-effect'
  | 'model-solver-diverged'
  | 'model-work-budget'
  | 'model-capability-unavailable'
  | 'model-partial'
  | 'model-cancelled'
  | 'model-internal';

/** Where an operation was requested: the label (when authored) and operation sequence. */
export interface ModelingSite {
  readonly op: string;
  readonly opIndex: number;
  readonly label?: string;
}

export interface ModelingErrorDetail {
  readonly site?: ModelingSite;
  readonly [key: string]: unknown;
}

export const MODELING_ERROR_HINTS: Readonly<Record<ModelingErrorCode, string>> = {
  'model-selection-empty':
    'inspect the available tags and roles with m.inspect(); empty selections never mean "everything", use sel.all()',
  'model-selection-cardinality':
    'relax .one()/.exactly(n) or narrow the selector until m.count(selector) matches',
  'model-invalid-argument': 'pass every required magnitude explicitly as a finite number',
  'model-precondition':
    'repair the input geometry first; the operation leaves the mesh unchanged when a precondition fails',
  'model-degenerate':
    'reduce the magnitude or change the selection so no face collapses or inverts',
  'model-op-no-effect':
    'the call succeeded structurally but changed nothing; check the selection and magnitudes',
  'model-solver-diverged':
    'the iterative solve did not converge; check detail (method, iterations, residual), loosen tolerance or raise maxIterations',
  'model-work-budget': 'reduce the element count or raise the declared budget',
  'model-capability-unavailable':
    "install the native modeling toolchain or use compute: 'auto' to fall back to the TypeScript baseline",
  'model-partial':
    "the compute job produced a partial result; inspect detail.locations, or pass onPartial: 'accept' to keep a closed result whose faces lost their source",
  'model-cancelled': 'the build was cancelled; rerun it',
  'model-internal':
    'a kernel defect threw inside the operation; the mesh was rolled back, report detail.cause and the operation arguments',
};

export class ModelingError extends Error {
  readonly code: ModelingErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: Readonly<ModelingErrorDetail>;

  constructor(args: {
    code: ModelingErrorCode;
    expected: string;
    hint?: string;
    detail?: Readonly<ModelingErrorDetail>;
  }) {
    const hint = args.hint ?? MODELING_ERROR_HINTS[args.code];
    super(`[ModelingError ${args.code}] expected: ${args.expected}; hint: ${hint}`);
    this.name = 'ModelingError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = hint;
    if (args.detail !== undefined) this.detail = args.detail;
  }
}

export function modelingError(
  code: ModelingErrorCode,
  expected: string,
  detail?: Readonly<ModelingErrorDetail>,
  hint?: string,
): ModelingError {
  return new ModelingError({
    code,
    expected,
    ...(detail === undefined ? {} : { detail }),
    ...(hint === undefined ? {} : { hint }),
  });
}
