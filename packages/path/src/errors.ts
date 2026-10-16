export type PathError = {
  readonly expected: string;
  readonly hint: string;
} & (
  | { readonly code: 'path-invalid-input'; readonly detail: { readonly field: string } }
  | {
      readonly code: 'path-binding-invalid';
      readonly detail: { readonly entity: number; readonly path: number };
    }
  | { readonly code: 'path-motion-conflict'; readonly detail: { readonly entity: number } }
  | { readonly code: 'path-parent-frame-unsupported'; readonly detail: { readonly entity: number } }
);
export type PathErrorCode = PathError['code'];
export function invalidPath(field: string, expected: string): PathError {
  return {
    code: 'path-invalid-input',
    detail: { field },
    expected,
    hint: `Correct ${field} in the authored Scene or runtime write and retry.`,
  };
}
