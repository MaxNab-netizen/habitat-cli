import { KeplerClient } from "./kepler-client.js";

export interface IndustryResource {
  [key: string]: unknown;
  id: string;
  resourceType: string;
  displayName: string;
  kind: string;
  rarity: string;
  description?: string;
  unit?: string;
  surfaceQuantityMinKg?: number | null;
  surfaceQuantityMaxKg?: number | null;
}

export interface ResourceCatalog {
  catalogVersion: string;
  resources: IndustryResource[];
}

export function filterMaterialResources(resources: IndustryResource[]): IndustryResource[] {
  return resources.filter((resource) => resource.kind === "material");
}

export async function readOfficialResourceCatalog(client: KeplerClient): Promise<ResourceCatalog> {
  const value = await client.listOfficialResources();
  if (!isRecord(value) || typeof value.catalogVersion !== "string" || !Array.isArray(value.resources)) {
    throw new Error("Kepler returned an invalid resource catalog.");
  }

  return {
    catalogVersion: value.catalogVersion,
    resources: value.resources.map((resource, index) => parseResource(resource, index)),
  };
}

function parseResource(value: unknown, index: number): IndustryResource {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.resourceType !== "string" ||
    typeof value.displayName !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.rarity !== "string"
  ) {
    throw new Error(`Kepler returned an invalid resource at index ${index}.`);
  }

  return value as IndustryResource;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
