import { AudioError, type AudioIntent } from '@forgeax/engine-audio';

/** One outgoing frame owns its queued copies until postMessage returns. */
export class AudioIntentQueue {
  private intents: AudioIntent[] = [];
  private bytes = 0;

  constructor(
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxIntents = 4096,
  ) {}

  push(intent: AudioIntent): void {
    if (intent.kind === 'destroy') {
      // Destruction cancels the entire outgoing frame and is always deliverable.
      this.clear();
      this.intents.push(intent);
      return;
    }
    let bytes = 0;
    // Count the packet being admitted, including every fixed older version.
    // Binary bodies are measured directly, never serialized element by element.
    const metadata = JSON.stringify(intent, (_key, value: unknown) => {
      if (value instanceof Uint8Array) {
        bytes += value.byteLength;
        return null;
      }
      return value;
    });
    bytes += metadata.length * 2;
    if (this.intents.length >= this.maxIntents || this.bytes + bytes > this.maxBytes)
      throw new AudioError({
        code: 'control-failed',
        expected: 'bounded pending audio commands and bytes',
        hint: 'reduce commands in one simulation frame or send them after the current frame completes',
        detail: {
          code: 'control-failed',
          reason: 'audio frame publication queue capacity exceeded',
        },
      });
    this.intents.push(intent);
    this.bytes += bytes;
  }

  drain(): AudioIntent[] {
    const intents = this.intents;
    this.intents = [];
    this.bytes = 0;
    return intents;
  }

  clear(): void {
    this.intents = [];
    this.bytes = 0;
  }
}
