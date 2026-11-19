import type { BrowserFrameCompleted } from '../src/browser-frame-signal';

/** This fixture counts pictures, independently of the execution queue counters. */
export class SubsurfacePictures {
  private count = 0;
  private acknowledgedAt: number | undefined;

  completed(frame: BrowserFrameCompleted): void {
    if (frame.presentation === 'ready') this.count++;
  }

  begin(): void {
    this.acknowledgedAt = undefined;
  }

  sinceAcknowledgment(acknowledgedRevision: number, requiredRevision: number): number {
    if (acknowledgedRevision !== requiredRevision) return 0;
    this.acknowledgedAt ??= this.count;
    return this.count - this.acknowledgedAt;
  }
}
