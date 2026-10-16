export type NavigationError =
  | {
      readonly code: 'navigation-projection-miss';
      readonly detail: {
        readonly position: readonly [number, number, number];
        readonly maxDistance: number;
      };
      readonly expected: string;
      readonly hint: string;
    }
  | {
      readonly code: 'navigation-projection-limit';
      readonly detail: { readonly visited: number; readonly maxPolygons: number };
      readonly expected: string;
      readonly hint: string;
    }
  | {
      readonly code: 'navigation-invalid-input';
      readonly detail: { readonly field: string; readonly value: unknown };
      readonly expected: string;
      readonly hint: string;
    }
  | {
      readonly code: 'navigation-invalid-node';
      readonly detail: { readonly node: number; readonly nodeCount: number };
      readonly expected: string;
      readonly hint: string;
    }
  | {
      readonly code: 'navigation-unreachable';
      readonly detail: { readonly start: number; readonly goal: number; readonly visited: number };
      readonly expected: string;
      readonly hint: string;
    }
  | {
      readonly code: 'navigation-query-limit';
      readonly detail: {
        readonly start: number;
        readonly goal: number;
        readonly visited: number;
        readonly maxVisited: number;
      };
      readonly expected: string;
      readonly hint: string;
    };
export type NavigationErrorCode = NavigationError['code'];

export function invalidInput(field: string, value: unknown, expected: string): NavigationError {
  return {
    code: 'navigation-invalid-input',
    detail: { field, value },
    expected,
    hint: `Correct ${field} before retrying.`,
  };
}
