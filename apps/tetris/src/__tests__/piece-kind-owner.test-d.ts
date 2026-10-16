import type { Cell, PIECE_KINDS, PIECES, PieceKind, PieceSpec } from '../pieces';

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? (<T>() => T extends Right ? 1 : 2) extends <T>() => T extends Left ? 1 : 2
      ? true
      : false
    : false;

type Expect<T extends true> = T;

type ExpectedKinds = readonly ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
type ExpectedPieceKind = ExpectedKinds[number];

type PieceKindsTupleIsTheOrderOwner = Expect<Equal<typeof PIECE_KINDS, ExpectedKinds>>;
type PieceKindIsDerivedFromTheTuple = Expect<Equal<PieceKind, (typeof PIECE_KINDS)[number]>>;
type PieceKindHasExactMembership = Expect<Equal<PieceKind, ExpectedPieceKind>>;
type PieceKeysCoverTheKindUnion = Expect<Equal<keyof typeof PIECES, PieceKind>>;
type PieceValuesRetainTheirKeyKinds = Expect<
  Equal<{ [K in PieceKind]: (typeof PIECES)[K]['kind'] }[PieceKind], PieceKind>
>;
type PieceSpecsRetainTheirShape = Expect<Equal<(typeof PIECES)[PieceKind], PieceSpec>>;
type RotationsRetainTheirCellShape = Expect<
  Equal<PieceSpec['rotations'], ReadonlyArray<readonly Cell[]>>
>;
type ColorsRetainTheirRgbShape = Expect<
  Equal<PieceSpec['color'], readonly [number, number, number]>
>;

void (0 as unknown as [
  PieceKindsTupleIsTheOrderOwner,
  PieceKindIsDerivedFromTheTuple,
  PieceKindHasExactMembership,
  PieceKeysCoverTheKindUnion,
  PieceValuesRetainTheirKeyKinds,
  PieceSpecsRetainTheirShape,
  RotationsRetainTheirCellShape,
  ColorsRetainTheirRgbShape,
]);
