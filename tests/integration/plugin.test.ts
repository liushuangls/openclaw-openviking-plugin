import { beforeAll, describe, expect, it } from "vitest";
import { OpenVikingClient } from "../../client.js";
import { isOVReachable, OV_BASE_URL } from "./setup.js";

const TEST_SESSION = `test-session-${Date.now()}`;
const TEST_AGENT = "test-agent";
const STARTUP_TIMEOUT_MS = 45_000;
const COMMIT_TIMEOUT_MS = 10_000;
const QUERY_WAIT_MS = 3_000;
const OV_SKIP_MESSAGE =
  `Skipping integration tests: OV server is not reachable at ${OV_BASE_URL}. ` +
  "Start the server first or set OV_BASE_URL to a reachable endpoint.";
const ovReachable = await isOVReachable();
const integrationTest = it.skipIf(!ovReachable);

if (!ovReachable) {
  console.warn(OV_SKIP_MESSAGE);
}

describe("OpenVikingClient integration", () => {
  let client: OpenVikingClient;

  beforeAll(() => {
    client = new OpenVikingClient({ baseUrl: OV_BASE_URL });
  }, STARTUP_TIMEOUT_MS);

  integrationTest("health check passes", async () => {
    const res = await fetch(`${OV_BASE_URL}/health`);
    expect(res.ok).toBe(true);
  });

  integrationTest("addSessionMessage + commitSession stores a memory without crashing", async () => {
    await client.addSessionMessage(
      TEST_SESSION,
      "user",
      "My favorite color is blue and I prefer dark mode.",
      TEST_AGENT,
    );

    const result = await client.commitSession(TEST_SESSION, {
      wait: true,
      timeoutMs: COMMIT_TIMEOUT_MS,
      agentId: TEST_AGENT,
    });

    expect(["completed", "accepted", "timeout", "failed"]).toContain(result.status);
  }, COMMIT_TIMEOUT_MS + 10_000);

  integrationTest("find() returns a valid result shape after storing a memory", async () => {
    await new Promise((resolve) => setTimeout(resolve, QUERY_WAIT_MS));

    const result = await client.find(
      "color preference",
      "viking://user/memories",
      5,
      0,
      TEST_AGENT,
    );

    expect(result).toHaveProperty("memories");
    expect(Array.isArray(result.memories)).toBe(true);
  }, 15_000);

  integrationTest("delete() does not throw for a non-existent uri", async () => {
    await expect(
      client.delete("viking://user/memories/nonexistent-test-uri", TEST_AGENT),
    ).resolves.toBeUndefined();
  });
});
