import globals from "globals";
import { defineConfig } from "eslint/config";
import js from "@eslint/js";
import ts from "typescript-eslint";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";

export default defineConfig(
	{
		ignores: ["dist/", "docs/", "src-tauri/gen/", "src-tauri/target/"],
	},
	js.configs.recommended,
	ts.configs.recommended,
	prettier,
	{
		languageOptions: { globals: globals.node },
		rules: {
			"no-undef": "off",
			// Debt, not breakage. Left visible, but not at the severity that
			// says something is wrong right now - otherwise the couple of
			// findings that do mean that are buried under a few hundred that
			// do not.
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/no-unused-vars": "warn",
			"@typescript-eslint/no-unused-expressions": "warn",
			"no-empty": "warn",
		},
	},
	{
		files: ["**/*.{ts,tsx}"],
		plugins: { "react-hooks": reactHooks },
		rules: {
			// Just the two long-standing rules. The plugin's recommended preset
			// adds fifteen more React Compiler checks, most of them at error;
			// those stay off until someone decides to work through them.
			"react-hooks/rules-of-hooks": "error",
			"react-hooks/exhaustive-deps": "warn",
		},
	},
);
