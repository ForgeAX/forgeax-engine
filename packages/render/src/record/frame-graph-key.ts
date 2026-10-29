/** Serialize the current graph inputs with native JSON observation semantics. */
export function serializeFrameGraphKey(input: object): string {
  return JSON.stringify(input);
}
