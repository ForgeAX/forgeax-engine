export const DDC_ERROR_CODES = [
  'ddc-project-root-required',
  'ddc-object-conflict',
  'ddc-head-conflict',
  'ddc-generation-conflict',
  'ddc-scope-mismatch',
  'ddc-lease-expired',
] as const;

export type DdcContractErrorCode = (typeof DDC_ERROR_CODES)[number];
export type DdcEntryErrorCode = 'ddc-entry-incomplete' | 'ddc-entry-invalid' | 'ddc-entry-conflict';
export type DdcErrorCode = DdcContractErrorCode | DdcEntryErrorCode;

export type DdcErrorRootKind = 'build-cache' | 'project-ddc' | 'runtime';

export interface DdcRecoveryAction {
  readonly kind:
    | 'inspect'
    | 'allocate-generation'
    | 'retry'
    | 'cold-rebuild'
    | 'prune'
    | 'release-lease';
  readonly executable: boolean;
  readonly exactTarget?: string;
  readonly reason?: string;
}

export interface DdcStoreErrorInit {
  readonly code: DdcErrorCode;
  readonly detail: string;
  readonly hint?: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly owner?: string;
  readonly rootKind?: DdcErrorRootKind;
  readonly scope?: string;
  readonly generation?: number;
  readonly lease?: string;
  readonly revision?: number;
  readonly recoveryActions?: readonly DdcRecoveryAction[];
  readonly hostPath?: string;
}

export interface DdcBrowserError {
  readonly code: DdcErrorCode;
  readonly hint: string;
  readonly expected: unknown;
  readonly actual?: unknown;
  readonly owner?: string;
  readonly rootKind?: DdcErrorRootKind;
  readonly scope?: string;
  readonly generation?: number;
  readonly lease?: string;
  readonly revision?: number;
  readonly recoveryActions: readonly Omit<DdcRecoveryAction, 'exactTarget'>[];
}

const defaultHints: Record<DdcErrorCode, string> = {
  'ddc-project-root-required': 'inject the canonical projectDdcRoot before serving or publishing',
  'ddc-object-conflict': 'keep the verified object and reject the competing publication',
  'ddc-head-conflict': 'inspect the current head and retry with a fresh revision',
  'ddc-generation-conflict': 'allocate a new persistent generation; do not edit the counter',
  'ddc-scope-mismatch': 'reinspect the canonical root and allocate a new scope',
  'ddc-lease-expired': 'discard the stale commit and acquire a new lease',
  'ddc-entry-incomplete': 'discard the partial entry and cold-cook from author authority',
  'ddc-entry-invalid': 'preserve last-known-good, inspect the entry, then cold-cook',
  'ddc-entry-conflict': 'keep the verified entry and reject the competing publication',
};

function defaultExpected(code: DdcErrorCode): unknown {
  if (code === 'ddc-project-root-required') return 'projectDdcRoot';
  if (code === 'ddc-entry-incomplete' || code === 'ddc-entry-invalid') {
    return 'a complete DDC entry whose receipt and integrity digests validate';
  }
  return 'a valid DDC owner, scope, generation, revision, and lease';
}

function defaultActions(code: DdcErrorCode): readonly DdcRecoveryAction[] {
  switch (code) {
    case 'ddc-project-root-required':
    case 'ddc-scope-mismatch':
      return [
        { kind: 'inspect', executable: true },
        { kind: 'retry', executable: true },
      ];
    case 'ddc-generation-conflict':
      return [{ kind: 'allocate-generation', executable: true }];
    case 'ddc-lease-expired':
      return [
        { kind: 'release-lease', executable: true },
        { kind: 'retry', executable: true },
      ];
    case 'ddc-object-conflict':
    case 'ddc-head-conflict':
      return [
        { kind: 'inspect', executable: true },
        { kind: 'retry', executable: true },
      ];
    case 'ddc-entry-incomplete':
    case 'ddc-entry-invalid':
      return [{ kind: 'cold-rebuild', executable: true }];
    case 'ddc-entry-conflict':
      return [{ kind: 'inspect', executable: true }];
  }
}

export class DdcStoreError extends Error {
  public readonly code: DdcErrorCode;
  public readonly detail: string;
  public readonly hint: string;
  public readonly expected: unknown;
  public readonly actual: unknown;
  public readonly owner: string | undefined;
  public readonly rootKind: DdcErrorRootKind | undefined;
  public readonly scope: string | undefined;
  public readonly generation: number | undefined;
  public readonly lease: string | undefined;
  public readonly revision: number | undefined;
  public readonly recoveryActions: readonly DdcRecoveryAction[];
  public readonly hostPath: string | undefined;

  public constructor(code: DdcErrorCode, detail: string);
  public constructor(input: DdcStoreErrorInit);
  public constructor(inputOrCode: DdcStoreErrorInit | DdcErrorCode, legacyDetail?: string) {
    const input: DdcStoreErrorInit =
      typeof inputOrCode === 'string'
        ? { code: inputOrCode, detail: legacyDetail ?? inputOrCode }
        : inputOrCode;
    super(input.detail);
    this.name = 'DdcStoreError';
    this.code = input.code;
    this.detail = input.detail;
    this.hint = input.hint ?? defaultHints[input.code];
    this.expected = input.expected ?? defaultExpected(input.code);
    this.actual = input.actual;
    this.owner = input.owner;
    this.rootKind = input.rootKind;
    this.scope = input.scope;
    this.generation = input.generation;
    this.lease = input.lease;
    this.revision = input.revision;
    this.recoveryActions = input.recoveryActions ?? defaultActions(input.code);
    this.hostPath = input.hostPath;
  }

  public toBrowserProjection(): DdcBrowserError {
    return {
      code: this.code,
      hint: this.hint,
      expected: this.expected,
      ...(this.actual === undefined ? {} : { actual: this.actual }),
      ...(this.owner === undefined ? {} : { owner: this.owner }),
      ...(this.rootKind === undefined ? {} : { rootKind: this.rootKind }),
      ...(this.scope === undefined ? {} : { scope: this.scope }),
      ...(this.generation === undefined ? {} : { generation: this.generation }),
      ...(this.lease === undefined ? {} : { lease: this.lease }),
      ...(this.revision === undefined ? {} : { revision: this.revision }),
      recoveryActions: this.recoveryActions.map(
        ({ exactTarget: _exactTarget, ...action }) => action,
      ),
    };
  }
}
