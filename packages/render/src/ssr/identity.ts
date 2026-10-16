/**
 * Exact source/build identity shared by the producer, RHI and SSR consumer.
 *
 * Keeping the POD in its own leaf avoids a second copy of the identity shape
 * in the owner inspection types and in the admission module.
 */
export type SsrAdmissionIdentity = Readonly<{
  readonly sourceHead: string;
  readonly sourceTree: string;
  readonly lockSha256: string;
  readonly buildSha256: string;
}>;
