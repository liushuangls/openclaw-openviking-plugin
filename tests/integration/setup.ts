import { execSync } from "node:child_process";

const COMPOSE_FILE = "/home/liushuang/docker/openviking/docker-compose.yml";
const BASE_URL = "http://127.0.0.1:1934";
const MAX_WAIT_MS = 30_000;

export async function startOV(): Promise<void> {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    if (res.ok) {
      return;
    }
  } catch {
    // Ignore startup probe failures and continue with docker compose.
  }

  execSync(`docker compose -f ${COMPOSE_FILE} up -d`, { stdio: "inherit" });

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        return;
      }
    } catch {
      // Ignore transient startup errors while waiting for the service.
    }
  }

  throw new Error(`OV server did not become healthy within ${MAX_WAIT_MS}ms`);
}

export async function stopOV(): Promise<void> {
  // Leave the persistent service running after the integration suite.
}

export const OV_BASE_URL = BASE_URL;
