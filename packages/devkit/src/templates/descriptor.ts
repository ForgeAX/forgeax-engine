export interface TemplateDescriptor {
  readonly id: string;
  readonly purpose: string;
  readonly defaultIdentity: {
    readonly name: string;
    readonly packageName: string;
  };
  readonly journeys: readonly string[];
}

export type TemplateDescriptorError = {
  readonly code: 'template-invalid' | 'template-journey-missing';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly id?: string };
};

export type TemplateValidation =
  | { readonly ok: true; readonly value: TemplateDescriptor }
  | { readonly ok: false; readonly error: TemplateDescriptorError };

export function validateTemplateDescriptor(value: unknown): TemplateValidation {
  if (typeof value !== 'object' || value === null) {
    return {
      ok: false,
      error: {
        code: 'template-invalid',
        expected: 'a template descriptor object',
        hint: 'declare the template identity and purpose in template.json',
        detail: {},
      },
    };
  }
  const candidate = value as Record<string, unknown>;
  const identity = candidate.defaultIdentity;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.purpose !== 'string' ||
    typeof identity !== 'object' ||
    identity === null ||
    typeof (identity as Record<string, unknown>).name !== 'string' ||
    typeof (identity as Record<string, unknown>).packageName !== 'string' ||
    !Array.isArray(candidate.journeys)
  ) {
    return {
      ok: false,
      error: {
        code: 'template-invalid',
        expected: 'id, purpose, defaultIdentity, and journeys',
        hint: 'complete template.json before discovering the template',
        detail: { ...(typeof candidate.id === 'string' ? { id: candidate.id } : {}) },
      },
    };
  }
  const defaultIdentity = identity as { readonly name: string; readonly packageName: string };
  const invalidJourneys =
    candidate.journeys.length === 0 ||
    candidate.journeys.some(
      (journey) => typeof journey !== 'string' || journey.trim().length === 0,
    );
  const invalidIdentity =
    candidate.id.trim().length === 0 ||
    candidate.id.includes('/') ||
    candidate.id.includes('\\') ||
    candidate.purpose.trim().length === 0 ||
    defaultIdentity.name.trim().length === 0 ||
    defaultIdentity.packageName.trim().length === 0;
  if (invalidIdentity || invalidJourneys) {
    return {
      ok: false,
      error: {
        code: invalidJourneys ? 'template-journey-missing' : 'template-invalid',
        expected: invalidJourneys
          ? 'at least one named verification journey'
          : 'non-empty path-safe template identity and purpose',
        hint: invalidJourneys
          ? 'add the exact validation journey to template.json'
          : 'repair the template identity and purpose in template.json',
        detail: { id: candidate.id },
      },
    };
  }
  return {
    ok: true,
    value: {
      id: candidate.id,
      purpose: candidate.purpose,
      defaultIdentity,
      journeys: candidate.journeys,
    },
  };
}
