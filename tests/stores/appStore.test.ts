import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";

import { useAppStore } from "~/stores/appStore";

describe("appStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it("exposes the app name", () => {
    const store = useAppStore();
    expect(store.appName).toBe("The Reserve");
  });
});
