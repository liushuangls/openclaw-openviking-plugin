// Integration test health check — network only, no environment variable access.
import { OV_BASE_URL } from "./config.js";

export { OV_BASE_URL };

const HEALTHCHECK_TIMEOUT_MS = 5_000;

export async function isOVReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${OV_BASE_URL}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
