import { checkInvariants as checkPackage } from '@forgeax/engine-modeling';
import { checkInvariants } from '../invariants';

// Design 15: every operation in every test re-checks the half-edge invariants, both
// for sources imported directly and for examples that import the built package.
checkInvariants(true);
checkPackage(true);
