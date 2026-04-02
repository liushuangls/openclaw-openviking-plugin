const DEFAULT_OV_BASE_URL = "http://127.0.0.1:1934";
const HEALTHCHECK_TIMEOUT_MS = 5_000;

export const OV_BASE_URL = (process.env.OV_BASE_URL ?? DEFAULT_OV_BASE_URL).replace(
  /\/+$/,
  "",
);

export async function isOVReachable(): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), HEALTHCHECK_TIMEOUT_MS);

  try {
    const res = await fetch(`${OV_BASE_URL}/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}
