export interface KeplerConfig {
  baseUrl: string;
  token: string;
}

export function loadKeplerConfig(): KeplerConfig {
  const baseUrl = readRequiredEnv(process.env.KEPLER_BASE_URL, "KEPLER_BASE_URL");
  const token = readRequiredEnv(process.env.KEPLER_PLANET_TOKEN, "KEPLER_PLANET_TOKEN");

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    token,
  };
}

function readRequiredEnv(value: string | undefined, name: string): string {
  const trimmed = value?.trim();

  if (!trimmed) {
    throw new Error(`Missing ${name} in .env.`);
  }

  return trimmed;
}

function normalizeBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}
