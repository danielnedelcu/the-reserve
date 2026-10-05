import prettier from "eslint-config-prettier";
import withNuxt from "./.nuxt/eslint.config.mjs";

export default withNuxt(
  {
    rules: {
      // TypeScript
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Vue specific
      "vue/multi-word-component-names": "off",

      // General
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // ui-thing scaffolded components: written by the CLI, re-fetched on
    // `ui-thing add`, and not edited here. They use `any` in prop types,
    // empty interfaces as slots for augmentation, v-html where the
    // component's contract is raw HTML, and their own blank-line style.
    // Linting them would mean hand-editing every file the CLI produces.
    files: ["app/components/Ui/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "vue/no-v-html": "off",
      "vue/padding-line-between-blocks": "off",
      "import/newline-after-import": "off",
    },
  },
  {
    // Verification scripts are CLIs — stdout IS their output.
    files: ["scripts/**"],
    rules: {
      "no-console": "off",
    },
  },
  // Must be last: disables all ESLint formatting rules that conflict with
  // Prettier (which owns formatting via format-on-save).
  prettier,
);
