export interface ChaosControlBase {
  readonly attempted: number;
  readonly applied: number;
  readonly delivered: number;
}

export interface ChaosWebSocketProxySnapshot {
  readonly schemaVersion: 1;
  readonly targetUrl: string;
  readonly mode: string;
  readonly sabotage: string;
  readonly delayMs: number;
  readonly controls: {
    readonly disconnect: ChaosControlBase;
    readonly duplicate: ChaosControlBase & { readonly copies: number };
    readonly 'out-of-order': ChaosControlBase & {
      readonly captured: number;
      readonly staleReplayed: number;
      readonly sabotageReordered: number;
    };
    readonly 'delayed-delivery': ChaosControlBase & {
      readonly delayedFrames: number;
      readonly maxDelayMs: number;
    };
    readonly 'late-join': ChaosControlBase & { readonly marked: number; readonly observed: number };
  };
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly resources: Readonly<Record<string, number | boolean>>;
}

export interface ChaosWebSocketProxy {
  readonly url: string;
  /** The same proxy instance's control channel for the paired host. */
  readonly hostUrl?: string;
  disconnectSession(sessionId: number): boolean;
  markLateJoin(): void;
  snapshot(): ChaosWebSocketProxySnapshot;
  close(): Promise<void>;
}

export function startChaosWebSocketProxy(options: {
  readonly targetUrl: string;
  readonly targetHostUrl?: string;
  readonly mode?: string;
  readonly sabotage?: string;
  readonly delayMs?: number;
}): Promise<ChaosWebSocketProxy>;
