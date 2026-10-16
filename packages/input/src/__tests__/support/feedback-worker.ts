import { createGamepadFeedback } from '../../gamepad-feedback';

const port = createGamepadFeedback();
self.onmessage = (event) => {
  if (event.data.kind === 'target') {
    port.play(event.data.target, { durationMs: 120, strongMagnitude: 1, weakMagnitude: 0 });
    port.play(event.data.target, { durationMs: 80, strongMagnitude: 0, weakMagnitude: 1 });
    port.stop(event.data.target);
    self.postMessage({ kind: 'intents', intents: port.drainIntents() });
  } else if (event.data.kind === 'results') {
    port.acceptResults(event.data.results);
    self.postMessage({ kind: 'results', results: port.readResults() });
  }
};
