/** Structural channel shared by load observers in DOM and native consumers. */
export interface LoadChannel {
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  postMessage(message: unknown): void;
  close(): void;
  /** Native Node channels must not keep their recording process alive. */
  unref?(): void;
}

type LoadChannelConstructor = new (name: string) => LoadChannel;

export const loadChannelConstructor = (): LoadChannelConstructor | undefined =>
  (globalThis as unknown as { BroadcastChannel?: LoadChannelConstructor }).BroadcastChannel;
