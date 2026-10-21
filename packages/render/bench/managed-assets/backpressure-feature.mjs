import { ok } from '@forgeax/engine-types';

export function backpressureFeature(read = () => undefined, acknowledge = () => {}) {
  return {
    identity: 'managed-assets.backpressure',
    extract() { return ok(read()); },
    plan(frame) { return ok({ work: [{ scope: 'frame', resources: [], passes: [] }], sourceFeedback: frame }); },
    onSourceFrameSubmitted(frame, feedback) {
      if (frame.step !== feedback.step || frame.state.handle !== feedback.state.handle || frame.state.version !== feedback.state.version)
        throw new Error('Backpressure source identity/version acknowledgment mismatch');
      acknowledge(feedback);
    },
  };
}
