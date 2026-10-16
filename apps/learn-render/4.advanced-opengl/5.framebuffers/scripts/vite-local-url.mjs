const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/**
 * Extract Vite's local URL from output that may contain ANSI styling around
 * both the `Local` label and the port digits.
 */
export function extractViteLocalUrl(output) {
  const normalized = String(output).replace(ANSI_ESCAPE_PATTERN, '');
  return normalized.match(/Local:\s+(https?:\/\/[^\s]+)/)?.[1];
}
