export function createCleanupEvidenceWriter(write: (evidence: string) => Promise<unknown>) {
  let settled = Promise.resolve();
  return (evidence: string): Promise<void> => {
    const written = settled.then(() => write(evidence)).then(() => undefined);
    settled = written.catch(() => undefined);
    return written;
  };
}
