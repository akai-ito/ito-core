import js from "@eslint/js";
import functional from "eslint-plugin-functional";
import unicorn from "eslint-plugin-unicorn";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const shapeRules = [
  { selector: "FunctionDeclaration[generator=false]", message: "Use an arrow function." },
  { selector: "FunctionExpression[generator=false]", message: "Use an arrow function." },
  {
    selector: "ForStatement, ForInStatement, WhileStatement, DoWhileStatement",
    message: "Use map, filter or reduce, or for…of for effects that must run in order.",
  },
];

export default defineConfig(
  { ignores: ["node_modules/", "site/", "protocol/types.ts", "src/engine/codex/bindings/"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked, unicorn.configs.recommended],
    plugins: { functional },
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "@typescript-eslint/switch-exhaustiveness-check": ["error", { considerDefaultExhaustiveForUnions: false }],
      "functional/no-let": "error",
      "functional/no-classes": "error",
      "functional/no-class-inheritance": "error",
      "functional/immutable-data": ["error", { ignoreAccessorPattern: ["process.exitCode"] }],
      "prefer-arrow-callback": "error",
      "no-restricted-syntax": [
        "error",
        ...shapeRules,
        { selector: "ExportDefaultDeclaration", message: "Use a named export." },
      ],
      "no-restricted-imports": ["error", { patterns: [{ group: ["../*"], message: "Import through a # subpath." }] }],
      "unicorn/no-array-reduce": "off",
      "unicorn/no-array-callback-reference": "off",
      "unicorn/no-nested-ternary": "off",
      "unicorn/no-null": "off",
      "unicorn/consistent-boolean-name": "off",
      "unicorn/prefer-smaller-scope": "off",
    },
  },
  { files: ["src/cell.ts"], rules: { "functional/immutable-data": "off" } },
  {
    files: ["test/support/capabilities/*.ts"],
    rules: { "functional/immutable-data": "off", "unicorn/no-process-exit": "off" },
  },
  { files: ["*.config.ts"], rules: { "no-restricted-syntax": ["error", ...shapeRules] } },
);
