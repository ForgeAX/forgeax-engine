// Search windows on the turnaround sheet (image pixels, [x0, y0, x1, y1] inclusive).
// A window only says where to look and which color classes belong to a part; every
// reported number is measured from the pixels inside it.

const CLOTH = ['navy', 'hair', 'white', 'other', 'dark'];
const HAIR = ['hair', 'light'];
const SHOE = ['navy', 'dark', 'gold', 'hair'];
const TAIL = ['navy', 'hair', 'white', 'other'];

/** Character's right is -X: in front it is the image left, in back the image right. */
export const VIEWS = {
  front: {
    columns: [60, 480],
    parts: {
      ahoge: { rect: [195, 25, 265, 70], classes: HAIR },
      headdress: { rect: [120, 40, 370, 125], classes: ['white', 'other'] },
      'hair-total': { rect: [82, 60, 425, 475], classes: HAIR },
      face: { rect: [150, 150, 330, 262], classes: ['skin'] },
      'eye-r': { rect: [155, 185, 228, 236], classes: ['dark'] },
      'eye-l': { rect: [235, 185, 312, 236], classes: ['dark'] },
      'fin-r': { rect: [80, 140, 142, 215], classes: ['navy', 'white', 'other', 'hair'] },
      'fin-l': { rect: [318, 140, 398, 215], classes: ['navy', 'white', 'other', 'hair'] },
      'ribbon-l': { rect: [308, 125, 362, 192], classes: ['light'] },
      'ribbon-r': { rect: [108, 125, 142, 175], classes: ['light'] },
      collar: { rect: [180, 262, 282, 300], classes: ['white', 'other'] },
      bowtie: { rect: [186, 272, 266, 332], classes: ['navy', 'dark'] },
      brooch: { rect: [208, 278, 238, 304], classes: ['gem', 'gold', 'light'] },
      apron: { rect: [138, 285, 300, 510], classes: ['white', 'other'] },
      waistband: { rect: [170, 355, 290, 386], classes: ['white'] },
      'apron-emblem': { rect: [212, 425, 268, 472], classes: ['navy', 'dark'] },
      'cuff-r': { rect: [90, 390, 140, 436], classes: ['white', 'other'] },
      'cuff-l': { rect: [305, 395, 366, 442], classes: ['white', 'other'] },
      'hand-r': { rect: [90, 418, 136, 462], classes: ['skin'] },
      'hand-l': { rect: [322, 428, 372, 468], classes: ['skin'] },
      'skirt-hem': { rect: [92, 478, 372, 546], classes: ['white', 'other'] },
      skirt: { rect: [92, 380, 372, 546], classes: CLOTH },
      'leg-r': { rect: [150, 522, 226, 575], classes: ['skin'] },
      'leg-l': { rect: [232, 522, 312, 575], classes: ['skin'] },
      'sock-r': { rect: [150, 556, 226, 600], classes: ['white', 'other'] },
      'sock-l': { rect: [232, 556, 312, 600], classes: ['white', 'other'] },
      'shoe-r': { rect: [130, 576, 228, 642], classes: SHOE },
      'shoe-l': { rect: [232, 576, 330, 642], classes: SHOE },
      tail: { rect: [330, 440, 462, 590], classes: TAIL },
      fluke: { rect: [384, 445, 462, 590], classes: TAIL },
    },
  },
  right: {
    columns: [490, 880],
    parts: {
      ahoge: { rect: [548, 25, 632, 95], classes: HAIR },
      headdress: { rect: [585, 40, 652, 140], classes: ['white', 'other'] },
      'hair-total': { rect: [518, 60, 812, 485], classes: HAIR },
      face: { rect: [528, 180, 622, 262], classes: ['skin'] },
      'eye-l': { rect: [545, 180, 600, 240], classes: ['dark'] },
      'ribbon-l': { rect: [614, 128, 662, 192], classes: ['light'] },
      'fin-l': { rect: [640, 152, 706, 226], classes: ['navy', 'white', 'other'] },
      sleeve: { rect: [592, 280, 662, 412], classes: ['navy', 'hair', 'dark'] },
      'cuff-l': { rect: [594, 405, 662, 442], classes: ['white', 'other'] },
      'hand-l': { rect: [598, 428, 652, 478], classes: ['skin'] },
      apron: { rect: [506, 285, 600, 500], classes: ['white', 'other'] },
      waistband: { rect: [548, 355, 622, 386], classes: ['white'] },
      'skirt-hem': { rect: [506, 498, 722, 552], classes: ['white', 'other'] },
      skirt: { rect: [506, 380, 722, 552], classes: CLOTH },
      'back-bow': { rect: [640, 355, 712, 475], classes: ['white', 'other'] },
      legs: { rect: [568, 536, 662, 576], classes: ['skin'] },
      socks: { rect: [568, 556, 662, 606], classes: ['white', 'other'] },
      shoes: { rect: [544, 578, 666, 646], classes: SHOE },
      tail: { rect: [640, 440, 866, 602], classes: TAIL },
      fluke: { rect: [780, 455, 866, 602], classes: TAIL },
    },
  },
  back: {
    columns: [885, 1260],
    parts: {
      ahoge: { rect: [1018, 25, 1092, 72], classes: HAIR },
      headdress: { rect: [938, 45, 1172, 172], classes: ['white', 'other'] },
      'hair-total': { rect: [900, 70, 1212, 462], classes: HAIR },
      'fin-l': { rect: [900, 140, 962, 215], classes: ['navy', 'white', 'other'] },
      'fin-r': { rect: [1148, 140, 1208, 215], classes: ['navy', 'white', 'other'] },
      'back-bow': { rect: [1000, 385, 1132, 500], classes: ['white', 'other'] },
      'cuff-l': { rect: [912, 402, 966, 442], classes: ['white', 'other'] },
      'cuff-r': { rect: [1148, 402, 1198, 442], classes: ['white', 'other'] },
      'hand-l': { rect: [910, 420, 962, 462], classes: ['skin'] },
      'hand-r': { rect: [1152, 420, 1202, 462], classes: ['skin'] },
      'skirt-hem': { rect: [918, 478, 1192, 548], classes: ['white', 'other'] },
      'leg-l': { rect: [960, 536, 1036, 580], classes: ['skin'] },
      'sock-l': { rect: [960, 562, 1036, 606], classes: ['white', 'other'] },
      'shoe-l': { rect: [960, 584, 1040, 642], classes: SHOE },
      'shoe-r': { rect: [1044, 584, 1126, 642], classes: SHOE },
      tail: { rect: [1030, 470, 1244, 642], classes: TAIL },
      fluke: { rect: [1160, 505, 1244, 642], classes: TAIL },
    },
  },
};

const DRESS = ['navy', 'white', 'other', 'dark', 'gold', 'gem'];
const LIMB = ['navy', 'white', 'other', 'skin', 'dark'];
const terms = (classes, ...rects) => rects.map((rect) => ({ rect, classes }));

/**
 * Part outlines for the blockout: the outer boundary of the union of `{ rect, classes }`
 * terms (largest connected piece). Where parts overlap on the sheet (tail over the
 * skirt, hair over the back), the rects decide which part owns the pixels.
 */
export const OUTLINES = {
  front: {
    hair: { terms: terms(['hair', 'light'], [82, 60, 425, 475]), close: 8 },
    face: terms(['skin'], [150, 150, 330, 262]),
    dress: terms(DRESS, [168, 262, 292, 392], [140, 380, 320, 446], [92, 446, 372, 548]),
    'arm-r': terms(LIMB, [88, 276, 172, 466]),
    'arm-l': terms(LIMB, [290, 280, 375, 470]),
    'leg-r': terms(['skin', 'white', 'other'], [150, 522, 226, 600]),
    'leg-l': terms(['skin', 'white', 'other'], [232, 522, 312, 600]),
    'shoe-r': terms(SHOE, [130, 576, 228, 642]),
    'shoe-l': terms(SHOE, [232, 576, 330, 642]),
    tail: terms(TAIL, [352, 440, 462, 590]),
  },
  right: {
    hair: { terms: [...terms(['hair', 'light', 'navy', 'dark'], [518, 60, 812, 280]), ...terms(['hair', 'light'], [640, 280, 812, 485])], close: 4 },
    face: terms(['skin'], [528, 180, 622, 262]),
    dress: terms(DRESS, [548, 262, 660, 392], [506, 380, 722, 552]),
    legs: terms(['skin', 'white', 'other'], [568, 522, 662, 606]),
    shoes: terms(SHOE, [544, 578, 666, 646]),
    tail: terms(TAIL, [700, 430, 866, 602]),
  },
  back: {
    // The back hides the face, so its hair outline spans the full head width.
    hair: { terms: [...terms(['hair', 'light'], [900, 70, 1212, 462]), ...terms(['navy', 'dark'], [956, 70, 1150, 330])], close: 6 },
    tail: terms(TAIL, [1040, 470, 1244, 642]),
  },
};
