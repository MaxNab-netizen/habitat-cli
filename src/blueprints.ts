import { KeplerClient } from "./kepler-client.js";

export interface ProductionBlueprint {
  [key: string]: unknown;
  id: string;
  blueprintId: string;
  displayName: string;
  description: string;
  status: string;
  output: Record<string, unknown>;
  inputs: Record<string, unknown>;
  buildTicks: number;
  repeatable: boolean;
}

export interface BlueprintCatalog {
  catalogVersion: string;
  blueprints: ProductionBlueprint[];
}

export async function readOfficialBlueprintCatalog(client: KeplerClient): Promise<BlueprintCatalog> {
  return parseBlueprintCatalog(await client.listOfficialBlueprints());
}

export async function readOfficialBlueprint(client: KeplerClient, blueprintId: string): Promise<ProductionBlueprint> {
  const response = await client.getOfficialBlueprint(blueprintId);
  if (!isRecord(response) || !isRecord(response.blueprint)) {
    throw new Error("Kepler returned an invalid blueprint response.");
  }

  return parseBlueprint(response.blueprint, `blueprint ${blueprintId}`);
}

function parseBlueprintCatalog(value: unknown): BlueprintCatalog {
  if (!isRecord(value) || typeof value.catalogVersion !== "string" || !Array.isArray(value.blueprints)) {
    throw new Error("Kepler returned an invalid blueprint catalog.");
  }

  return {
    catalogVersion: value.catalogVersion,
    blueprints: value.blueprints.map((blueprint, index) => parseBlueprint(blueprint, `blueprint at index ${index}`)),
  };
}

function parseBlueprint(value: unknown, label: string): ProductionBlueprint {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.blueprintId !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.description !== "string" ||
    typeof value.status !== "string" ||
    !isRecord(value.output) ||
    !isRecord(value.inputs) ||
    typeof value.buildTicks !== "number" ||
    typeof value.repeatable !== "boolean"
  ) {
    throw new Error(`Kepler returned an invalid ${label}.`);
  }

  return value as ProductionBlueprint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
