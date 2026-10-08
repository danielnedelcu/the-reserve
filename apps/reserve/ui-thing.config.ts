export default {
  theme: "stone",
  tailwindCSSLocation: "app/assets/css/main.css",
  componentsLocation: "app/components/Ui",
  composablesLocation: "app/composables",
  pluginsLocation: "app/plugins",
  utilsLocation: "app/utils",
  // false: the CLI's `add` refuses to overwrite a component that exists,
  // which is what protects the local additions in Ui/Command (always-visible
  // items) and Ui/TanStackTable (server-side props). Re-add deliberately.
  force: false,
  useDefaultFilename: true,
  packageManager: "npm",
};
