// Progress and result lines for the hero-asset scripts (repo convention: stdout writes, not console.log).
export function say(...parts: unknown[]): void {
  process.stdout.write(
    `${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`,
  );
}
