import { describe, expect, it } from "vitest";

import { HealthController } from "../src/modules/health/health.controller";

/**
 * Tiny smoke test for the liveness probe.
 * Real integration tests against the readiness probe (which hits the DB)
 * land in Phase 1 once the test database container is wired into CI.
 */
describe("HealthController", () => {
  it("liveness returns ok", () => {
    const controller = new HealthController(
      // The liveness handler doesn't touch these dependencies, so casting is safe in this unit test.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    const result = controller.liveness();
    expect(result.status).toBe("ok");
    expect(result.service).toBe("nimi-api");
    expect(typeof result.time).toBe("string");
  });
});
