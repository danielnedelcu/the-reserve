import prettier from "eslint-config-prettier";
import withNuxt from "./.nuxt/eslint.config.mjs";

export default withNuxt({
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
}, {
  // ui-thing scaffolded components intentionally use `any` in prop types
  files: ["app/components/Ui/**"],
  rules: {
    "@typescript-eslint/no-explicit-any": "off",
  },
}, {
  // Verification scripts are CLIs — stdout IS their output.
  files: ["scripts/**"],
  rules: {
    "no-console": "off",
  },
},
// Must be last: disables all ESLint formatting rules that conflict with
// Prettier (which owns formatting via format-on-save).
prettier);
