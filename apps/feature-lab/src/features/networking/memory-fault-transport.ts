import type { PeerId } from '@forgeax/engine/net';
import { createMemoryEndpointPairWithController } from '@forgeax/engine/net';
import { defineFeature } from '../../lab/feature';

export default defineFeature({
  title: 'Memory fault transport',
  catalog: 'Memory fault transport',
  kind: 'headless',
  summary:
    'createMemoryEndpointPairWithController() returns a memory endpoint pair plus a deterministic fault controller: delay, duplicate or malform the next delivery (first -> second endpoint), or force a disconnect.',
  expect:
    'All checks pass: a delayed message appears one poll later, a duplicated message arrives twice, a malformed message differs from the sent bytes, and disconnectPeer surfaces peer-disconnected.',
  run(checks) {
    const { endpoints, controller } = createMemoryEndpointPairWithController();
    const [sender, receiver] = endpoints;
    const peer =
      sender.poll().find((event) => event.kind === 'peer-connected')?.peerId ?? (0 as PeerId);
    receiver.poll();
    const messages = () =>
      receiver
        .poll()
        .flatMap((event) => (event.kind === 'message' ? [Array.from(event.data)] : []));

    checks.ok('baseline send', sender.send(peer, Uint8Array.of(1)).ok);
    checks.equal('undisturbed delivery', messages(), [[1]]);

    controller.delayNextDelivery(50);
    sender.send(peer, Uint8Array.of(2));
    checks.equal('delayed message is absent on the first poll', messages(), []);
    checks.equal('delayed message arrives on the next poll', messages(), [[2]]);

    controller.duplicateNextDelivery();
    sender.send(peer, Uint8Array.of(3));
    checks.equal('duplicated message arrives twice', messages(), [[3], [3]]);

    controller.malformNextDelivery();
    sender.send(peer, Uint8Array.of(4, 5));
    const malformed = messages();
    checks.ok(
      'malformed message bytes differ from the sent bytes',
      malformed.length === 1 && JSON.stringify(malformed[0]) !== '[4,5]',
      JSON.stringify(malformed),
    );

    sender.send(peer, Uint8Array.of(6));
    checks.equal('faults are one-shot', messages(), [[6]]);

    controller.disconnectPeer(receiver);
    const events = [...sender.poll(), ...receiver.poll()];
    checks.ok(
      'disconnectPeer surfaces peer-disconnected',
      events.some((event) => event.kind === 'peer-disconnected'),
      JSON.stringify(events.map((e) => e.kind)),
    );
  },
});
