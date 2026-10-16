// Negative fixture (w7 case c): runtime re-implements decoding through a
// custom decoder class. The Path (a) gate must FAIL on the
// forbidden-implementation-symbol clause matching `class .+Decoder`.

export class CustomDecoder {
  decode(_bytes: Uint8Array): Uint8Array {
    throw new Error('not implemented');
  }
}
