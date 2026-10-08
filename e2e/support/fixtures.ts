import { test as base, expect } from "@playwright/test";
import { TestData } from "./data";

// Each test gets its own TestData, removed afterwards even when it fails.
// `data` lives in the seeded organisation; `org` is a whole organisation
// of the run's own, for the journeys that write ledger rows
// (docs/testing-design.md, "The money journeys").
export const test = base.extend<{ data: TestData; org: TestData }>({
  // eslint-disable-next-line no-empty-pattern
  data: async ({}, use) => {
    const data = await TestData.create();
    try {
      await use(data);
    } finally {
      await data.cleanup();
    }
  },
  // eslint-disable-next-line no-empty-pattern
  org: async ({}, use) => {
    const org = await TestData.createOrganisation();
    try {
      await use(org);
    } finally {
      await org.cleanup();
    }
  },
});
export { expect };
