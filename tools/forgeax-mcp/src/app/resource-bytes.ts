/** Decode the broker's exact resource reference in every document and Worker. */
export async function readResourceBytes(ref: any, invoke: any) {
  const decode = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const output = ref.base64 ? decode(ref.base64) : new Uint8Array(ref.bytes);
  if (!ref.base64 && output.length > 0) {
    // The sender owns its bounded byte window. Derive the stride from the first
    // result so document, Worker and Node readers never duplicate that policy.
    const read = async (offset: number) => decode((await invoke({ action: 'chunk', resourceId: ref.resourceId, offset })).base64);
    const first = await read(0);
    const stride = first.length;
    if (stride === 0 || stride > output.length) throw new Error('Invalid resource chunk length');
    output.set(first);
    for (let base = stride; base < output.length; base += stride * 4) {
      await Promise.all(Array.from({ length: Math.min(4, Math.ceil((output.length - base) / stride)) }, async (_, index) => {
        const offset = base + index * stride;
        const part = await read(offset);
        if (part.length !== Math.min(stride, output.length - offset)) throw new Error('Invalid resource chunk length');
        output.set(part, offset);
      }));
    }
  }
  if (ref.encoding === 'gzip') {
    const stream = new DecompressionStream('gzip');
    const [decoded] = await Promise.all([
      new Response(stream.readable).arrayBuffer(),
      (async () => {
        const writer = stream.writable.getWriter();
        await writer.write(output);
        await writer.close();
      })(),
    ]);
    return new Uint8Array(decoded);
  }
  return output;
}
