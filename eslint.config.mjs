import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/**", "node_modules/**", ".vscode-test/**", "test/fixture/**"] },
  ...tseslint.configs.recommended,
);
