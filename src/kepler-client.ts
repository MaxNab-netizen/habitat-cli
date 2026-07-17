export interface HabitatRegistrationInput {
  displayName: string;
  habitatUuid: string;
}

export interface SolarIrradianceReading {
  wPerM2: number;
  condition: string;
}

export class KeplerApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "KeplerApiError";
  }
}

export class KeplerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  async registerHabitat(input: HabitatRegistrationInput): Promise<unknown> {
    const response = await this.request("/habitats/register", {
      method: "POST",
      body: JSON.stringify(input),
    });

    return response.json();
  }

  async getHabitatRegistration(habitatId: string): Promise<unknown> {
    const response = await this.request(`/habitats/${encodeURIComponent(habitatId)}/registration`, {
      method: "GET",
    });

    return response.json();
  }

  async listOfficialBlueprints(): Promise<unknown> {
    const response = await this.request("/catalog/blueprints", {
      method: "GET",
    });

    return response.json();
  }

  async getOfficialBlueprint(blueprintId: string): Promise<unknown> {
    const response = await this.request(`/catalog/blueprints/${encodeURIComponent(blueprintId)}`, {
      method: "GET",
    });

    return response.json();
  }

  async listOfficialResources(): Promise<unknown> {
    const response = await this.request("/catalog/resources", {
      method: "GET",
    });

    return response.json();
  }

  async getSolarIrradiance(): Promise<SolarIrradianceReading> {
    const response = await this.request("/world/solar-irradiance", {
      method: "GET",
    });

    const body = await response.json() as unknown;
    if (!isRecord(body) || !isRecord(body.solarIrradiance)) {
      throw new Error("Kepler returned an invalid solar irradiance response.");
    }

    const reading = body.solarIrradiance;
    if (typeof reading.wPerM2 !== "number" || !Number.isFinite(reading.wPerM2) || reading.wPerM2 < 0 || typeof reading.condition !== "string" || !reading.condition.trim()) {
      throw new Error("Kepler returned an invalid solar irradiance reading.");
    }

    return {
      wPerM2: reading.wPerM2,
      condition: reading.condition,
    };
  }

  async unregisterHabitat(habitatId: string): Promise<void> {
    await this.request(`/habitats/${encodeURIComponent(habitatId)}`, {
      method: "DELETE",
    });
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new KeplerApiError(response.status, await readErrorMessage(response));
    }

    return response;
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    try {
      const body = JSON.parse(text) as Record<string, unknown>;

      const message = readString(body, "message") ?? readString(body, "error") ?? readString(body, "detail");
      if (message) {
        return message;
      }
    } catch {
      // Fall back to plain text below.
    }
  }

  return text.trim() || response.statusText || "Request failed";
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
