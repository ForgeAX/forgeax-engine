import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		environment: "node",
		name: "@forgeax/engine-pack",
		typecheck: {
			enabled: true,
			tsconfig: "./tsconfig.json",
		},
		include: [
			"__tests__/**/*.test.ts",
			"__tests__/**/*.test-d.ts",
			"src/**/__tests__/**/*.test.ts",
			"src/**/__tests__/**/*.test-d.ts",
		],
		exclude: ["**/dist/**", "**/node_modules/**"],
	},
});
