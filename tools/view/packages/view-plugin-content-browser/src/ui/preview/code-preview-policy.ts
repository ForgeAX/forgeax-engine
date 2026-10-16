import { resolveLanguage } from './ext-language';

export const MAX_HIGHLIGHT_BYTES = 200 * 1024;
export const MAX_HIGHLIGHT_LINES = 5_000;

export type HighlightDecision =
  | { readonly highlight: true; readonly lang: string; readonly label: string }
  | { readonly highlight: false; readonly reason: 'no-content' | 'unknown-language' | 'too-large' };

export interface HighlightPolicyInput {
  readonly ext: string;
  readonly size: number;
  readonly content?: string;
}

function countLines(text: string): number {
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

export function decideHighlight(input: HighlightPolicyInput): HighlightDecision {
  const { ext, size, content } = input;
  if (content == null) return { highlight: false, reason: 'no-content' };
  const resolved = resolveLanguage(ext);
  if (!resolved) return { highlight: false, reason: 'unknown-language' };
  const byteSize = Math.max(size, content.length);
  if (byteSize > MAX_HIGHLIGHT_BYTES || countLines(content) > MAX_HIGHLIGHT_LINES) {
    return { highlight: false, reason: 'too-large' };
  }
  return { highlight: true, lang: resolved.lang, label: resolved.label };
}
