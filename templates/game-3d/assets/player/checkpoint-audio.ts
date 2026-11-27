/** Locally generated PCM. Each note starts and ends at zero to avoid clicks. */
function tone(notes: readonly number[], seconds: number): Uint8Array {
  const sampleRate = 22050;
  const noteFrames = Math.round(sampleRate * seconds);
  const frames = noteFrames * notes.length;
  const wav = new Uint8Array(44 + frames * 2);
  const view = new DataView(wav.buffer);
  const tag = (offset: number, text: string) => wav.set(new TextEncoder().encode(text), offset);
  tag(0, 'RIFF');
  view.setUint32(4, wav.length - 8, true);
  tag(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, frames * 2, true);
  notes.forEach((hz, index) => {
    for (let frame = 0; frame < noteFrames; frame++) {
      const time = frame / sampleRate;
      const envelope = Math.min(1, time / 0.025, (noteFrames - 1 - frame) / (sampleRate * 0.08));
      const sample = Math.sin(2 * Math.PI * time * hz) * envelope * 8192;
      view.setInt16(44 + 2 * (index * noteFrames + frame), sample, true);
    }
  });
  return wav;
}

export const makeCheckpointChime = () => tone([392, 523.25, 659.25], 0.14);
export const makeAmbientLoop = () => tone([130.81, 164.81, 196, 164.81], 0.9);
