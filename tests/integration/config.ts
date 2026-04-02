// Test configuration — reads environment variables only, no network calls.
const DEFAULT_OV_BASE_URL = "http://127.0.0.1:1934";
export const OV_BASE_URL = (process.env.OV_BASE_URL ?? DEFAULT_OV_BASE_URL).replace(/\/+$/, "");
