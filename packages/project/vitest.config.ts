import { defineProject } from "vitest/config";

export default defineProject({
	test: {
		environment: "node",
		name: "@forgeax/engine-project",
		typecheck: {
			enabled: true,
			tsconfig: "./tsconfig.json",
		},
		include: [
			"src/**/__tests__/**/*.test.ts",
		],
		exclude: ["**/dist/**", "**/node_modules/**"],
	},
});