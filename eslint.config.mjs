import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "coverage/", "dist/", "**/*.mjs"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "separate-type-imports" },
      ],
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Nest modules are classes used only as decorator targets.
      "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
    },
  },
  {
    files: ["src/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@nestjs/*"], message: "O domínio não pode depender do NestJS." },
            { group: ["@mikro-orm/*"], message: "O domínio não pode depender do MikroORM." },
          ],
        },
      ],
    },
  },
  {
    files: ["src/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@nestjs/*"], message: "A aplicação não pode depender do NestJS." },
            { group: ["@mikro-orm/*"], message: "A aplicação não pode depender do MikroORM." },
            { group: ["**/infrastructure/**"], message: "A aplicação depende só de portas." },
          ],
        },
      ],
    },
  },
  prettier,
);
