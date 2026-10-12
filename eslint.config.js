import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig({ ignores: ["node_modules/", "site/", "protocol/types.ts"] }, js.configs.recommended, {
  files: ["**/*.ts"],
  extends: [tseslint.configs.recommendedTypeChecked],
  languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
  rules: { "@typescript-eslint/switch-exhaustiveness-check": "error" },
});
