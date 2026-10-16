/** Keep tooltip copy friendly; raw bootstrap/network errors belong in the console, not the header. */
export function sanitizeHostConnectionDetail(detail?: string): string | undefined {
  const trimmed = detail?.trim();
  if (!trimmed) return undefined;
  if (/unexpected token|<!doctype|not valid json|failed to fetch|networkerror|load failed/i.test(trimmed)) {
    return undefined;
  }
  if (trimmed.length > 120) return `${trimmed.slice(0, 117)}…`;
  return trimmed;
}
