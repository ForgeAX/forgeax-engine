import type { ProfileCapture, ProfileRecord } from './generated/profile-capture.js';
import validator from './generated/schema-validator.cjs';
import type { ProfileResult } from './types.js';

export type ProfileArtifactError = {
  readonly code: 'profile-artifact-invalid' | 'profile-artifact-incompatible';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly path: string; readonly message: string };
};

function error(
  code: ProfileArtifactError['code'],
  path: string,
  message: string,
): ProfileResult<never, ProfileArtifactError> {
  return {
    ok: false,
    error: {
      code,
      expected: 'a schema-valid ProfileCapture v1 artifact',
      hint: 'Regenerate or select a compatible ProfileCapture artifact before retrying.',
      detail: { path, message },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateSemanticRules(
  value: Record<string, unknown>,
): ProfileResult<ProfileCapture, ProfileArtifactError> {
  const catalog = value.phaseCatalog as { app: string[]; render: string[] };
  const records = value.records as ProfileRecord[];
  let previousFrameId = 0;

  for (const [index, record] of records.entries()) {
    if (record.frameId < previousFrameId) {
      return error(
        'profile-artifact-invalid',
        `/records/${index}/frameId`,
        'frameId must not decrease',
      );
    }
    previousFrameId = record.frameId;
    if (!catalog[record.source].includes(record.phase)) {
      return error(
        'profile-artifact-invalid',
        `/records/${index}/phase`,
        'phase is absent from its source catalog',
      );
    }
    if (record.kind === 'phase' && record.parentPhase !== undefined) {
      const parentCatalog = catalog[record.parentSource ?? record.source];
      if (!parentCatalog.includes(record.parentPhase)) {
        return error(
          'profile-artifact-invalid',
          `/records/${index}/parentPhase`,
          'parentPhase is absent from its source catalog',
        );
      }
      if (record.parentPhase === record.phase) {
        return error(
          'profile-artifact-invalid',
          `/records/${index}/parentPhase`,
          'parentPhase must differ from phase',
        );
      }
    } else if (record.kind === 'phase' && record.parentSource !== undefined) {
      return error(
        'profile-artifact-invalid',
        `/records/${index}/parentSource`,
        'parentSource requires parentPhase',
      );
    }
    if (record.kind === 'phase') {
      if (record.endMicros < record.startMicros) {
        return error(
          'profile-artifact-invalid',
          `/records/${index}/endMicros`,
          'endMicros must not precede startMicros',
        );
      }
      if (record.durationMicros !== record.endMicros - record.startMicros) {
        return error(
          'profile-artifact-invalid',
          `/records/${index}/durationMicros`,
          'durationMicros must equal endMicros - startMicros',
        );
      }
    }
  }

  const completeness = value.completeness as ProfileCapture['completeness'];
  if (completeness.retainedEventCount !== records.length) {
    return error(
      'profile-artifact-invalid',
      '/completeness/retainedEventCount',
      'retainedEventCount must equal records.length',
    );
  }
  if (completeness.status === 'complete') {
    if (completeness.incompleteReason !== undefined || completeness.droppedEventCount !== 0) {
      return error(
        'profile-artifact-invalid',
        '/completeness',
        'complete captures cannot contain incomplete evidence',
      );
    }
  }
  if (completeness.status === 'partial' && completeness.incompleteReason === undefined) {
    return error(
      'profile-artifact-invalid',
      '/completeness/incompleteReason',
      'partial captures require incompleteReason',
    );
  }
  if (completeness.status === 'overflow') {
    if (completeness.droppedEventCount === 0) {
      return error(
        'profile-artifact-invalid',
        '/completeness/droppedEventCount',
        'overflow captures require dropped events',
      );
    }
    if (
      completeness.firstAffectedFrameId === undefined ||
      completeness.lastAffectedFrameId === undefined
    ) {
      return error(
        'profile-artifact-invalid',
        '/completeness',
        'overflow captures require affected frame bounds',
      );
    }
  }
  return { ok: true, value: value as unknown as ProfileCapture };
}

export function validateProfileCapture(
  value: unknown,
): ProfileResult<ProfileCapture, ProfileArtifactError> {
  if (!isRecord(value)) return error('profile-artifact-invalid', '', 'artifact must be an object');
  if (value.schemaVersion !== '1.0') {
    return error(
      'profile-artifact-incompatible',
      '/schemaVersion',
      'reader supports schema version 1.0 only',
    );
  }
  if (!validator(value)) {
    const issue = validator.errors?.[0];
    return error(
      'profile-artifact-invalid',
      issue?.instancePath ?? '',
      issue?.message ?? 'schema validation failed',
    );
  }
  return validateSemanticRules(value);
}
