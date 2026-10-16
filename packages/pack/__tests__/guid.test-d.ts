import { test } from "vitest";
import type { AssetGuid } from "../src/guid.js";

// w5: type-level tests ensuring AssetGuid brand is not assignable to/from plain types.

test("AssetGuid is assignable to itself", () => {
	const _: AssetGuid = {} as AssetGuid;
	void _;
});

test("Uint8Array is not assignable to AssetGuid", () => {
	// @ts-expect-error Uint8Array should not be assignable to AssetGuid (brand mismatch)
	const _: AssetGuid = new Uint8Array(16) as Uint8Array;
	void _;
});

test("string is not assignable to AssetGuid", () => {
	// @ts-expect-error string should not be assignable to AssetGuid
	const _: AssetGuid = "01957b3a-1234-7abc-89de-123456789abc";
	void _;
});
