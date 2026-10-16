declare module 'css-tree/dist/csstree.esm' {
  /** Structural AST fields; consumers narrow type and optional fields before use. */
  export interface CssNode {
    type: string;
    kind?: string;
    name?: string;
    property?: string;
    important?: boolean | string;
    value?: string | CssNode;
    children?: Iterable<CssNode>;
    prelude?: CssNode | null;
    block?: CssNode | null;
    left?: CssNode;
    middle?: CssNode;
    right?: CssNode;
    loc?: { start: { offset: number }; end: { offset: number } };
  }
  export interface CssSyntaxError extends Error {
    offset: number;
  }
  export function parse(
    source: string,
    options?: {
      readonly positions?: boolean;
      readonly parseCustomProperty?: boolean;
      readonly context?:
        | 'stylesheet'
        | 'declarationList'
        | 'declaration'
        | 'value'
        | 'selectorList';
      readonly onParseError?: (error: CssSyntaxError) => void;
      readonly onComment?: (value: string, loc: NonNullable<CssNode['loc']>) => void;
    },
  ): CssNode;
  export function walk(
    node: CssNode,
    callback:
      | ((node: CssNode) => void)
      | { enter(node: CssNode): void; leave(node: CssNode): void },
  ): void;
  export function generate(node: CssNode): string;
  interface MatchResult {
    error: (Error & { offset?: number; rawMessage?: string }) | null;
  }
  export const lexer: {
    getProperty(name: string): unknown;
    matchProperty(name: string, value: CssNode): MatchResult;
    matchAtruleDescriptor(atrule: string, name: string, value: CssNode): MatchResult;
    matchAtrulePrelude(name: string, value: CssNode | null): MatchResult;
  };
}
