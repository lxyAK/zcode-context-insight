import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e 需要拉起子进程，放宽默认超时
    testTimeout: 30000,
  },
});
