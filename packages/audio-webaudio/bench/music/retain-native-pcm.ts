export async function retain(name: string, row: unknown) {
  const save = (globalThis as unknown as { __musicRetain?: (name: string, row: unknown) => Promise<void> }).__musicRetain;
  if (save) {
    await save(name, row);
    // The native sink has persisted the complete WAV. Keep metrics and oracles,
    // but do not serialize those same bytes again with the final result.
    if (typeof row === 'object' && row !== null && 'wav' in row && Array.isArray(row.wav)) row.wav.length = 0;
  }
}

// Evidence transport only: preserve every native sample without assembling a
// second complete PCM buffer, WAV buffer or base64 string in the browser.
export async function retainNativePcm(
  name: string,
  capture: { context: { sampleRate: number }; pcm: readonly { sample: number; pcm: Float32Array }[] },
  seconds: number,
  save: (name: string, row: { wavOffset: number; wavBase64: string }) => Promise<void>,
): Promise<void> {
  const frames = Math.round(capture.context.sampleRate * seconds);
  let captured = 0;
  for (const row of capture.pcm) {
    if (row.sample !== captured) throw new Error('native PCM contains missing or overlapping chunk');
    captured += row.pcm.length;
  }
  if (captured !== frames) throw new Error('native PCM must contain every requested frame');
  const header = new Uint8Array(44);
  const view = new DataView(header.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const)
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  view.setUint32(4, 36 + frames * 4, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, capture.context.sampleRate, true);
  view.setUint32(28, capture.context.sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 32, true);
  view.setUint32(40, frames * 4, true);
  // FileReader performs native base64 conversion of at most one MiB. Awaiting
  // the sink bounds both the browser scratch bytes and protocol publication.
  let offset = 0;
  const send = async (bytes: Uint8Array<ArrayBuffer>) => {
    const wavBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => resolve(String(reader.result).split(',')[1]!);
      reader.readAsDataURL(new Blob([bytes]));
    });
    await save(name, { wavOffset: offset, wavBase64 });
    offset += bytes.length;
  };
  await send(header);
  const scratch = new Uint8Array(1024 * 1024);
  const samples = new DataView(scratch.buffer);
  let used = 0;
  for (const row of capture.pcm) {
    for (let index = 0; index < row.pcm.length; index++) {
      samples.setFloat32(used, row.pcm[index]!, true);
      used += 4;
      if (used === scratch.length) { await send(scratch); used = 0; }
    }
  }
  if (used) await send(scratch.subarray(0, used));
}
