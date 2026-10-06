import { test as base, expect } from "@playwright/test";
import { TestData } from "./data";

// Each test gets its own TestData, removed afterwards even when it fails.
export const test = base.extend<{ data: TestData }>({
  // eslint-disable-next-line no-empty-pattern
  data: async ({}, use) => {
    const data = await TestData.create();
    try {
      await use(data);
    } finally {
      await data.cleanup();
    }
  },
});
export { expect };
