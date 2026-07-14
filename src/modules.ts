import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HabitatModule {
  id: string;
  blueprintId: string;
  displayName: string;
  connectedTo: string[];
  runtimeAttributes: Record<string, unknown>;
  capabilities: string[];
}

export type HabitatModuleState = "offline" | "idle" | "online" | "active" | "damaged";

const habitatDirectory = join(process.cwd(), ".habitat");
const modulesPath = join(habitatDirectory, "modules.json");

export async function readModules(): Promise<HabitatModule[]> {
  try {
    const contents = await readFile(modulesPath, "utf8");
    return JSON.parse(contents) as HabitatModule[];
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
}

export async function writeModules(modules: HabitatModule[]): Promise<void> {
  await mkdir(habitatDirectory, { recursive: true });
  await writeFile(modulesPath, `${JSON.stringify(modules, null, 2)}\n`, "utf8");
}

export async function createModule(input: Omit<HabitatModule, "id">): Promise<HabitatModule> {
  const module: HabitatModule = { id: `module_${randomUUID()}`, ...input };
  await writeModules([...(await readModules()), module]);
  return module;
}

export async function updateModule(id: string, changes: Partial<Omit<HabitatModule, "id">>): Promise<HabitatModule> {
  const modules = await readModules();
  const index = modules.findIndex((module) => module.id === id);
  if (index < 0) {
    throw new Error(`Module not found: ${id}`);
  }

  const updated = { ...modules[index], ...changes };
  modules[index] = updated;
  await writeModules(modules);
  return updated;
}

export async function setModuleStatus(id: string, status: HabitatModuleState): Promise<{ module: HabitatModule; powerDrawKw: number }> {
  const modules = await readModules();
  const index = modules.findIndex((module) => module.id === id);
  if (index < 0) {
    throw new Error(`Module not found: ${id}`);
  }

  const module = modules[index];
  const powerDrawKw = module.runtimeAttributes.powerDrawKw;
  if (!isRecord(powerDrawKw)) {
    throw new Error(`Module ${module.id} is missing a powerDrawKw map.`);
  }

  const draw = powerDrawKw[status];
  if (typeof draw !== "number" || !Number.isFinite(draw) || draw < 0) {
    throw new Error(`Module ${module.id} has no valid power draw for state "${status}".`);
  }

  const updated: HabitatModule = {
    ...module,
    runtimeAttributes: {
      ...module.runtimeAttributes,
      status,
    },
  };
  modules[index] = updated;
  await writeModules(modules);
  return { module: updated, powerDrawKw: draw };
}

export async function deleteModule(id: string): Promise<void> {
  const modules = await readModules();
  const remaining = modules.filter((module) => module.id !== id);
  if (remaining.length === modules.length) {
    throw new Error(`Module not found: ${id}`);
  }

  await writeModules(remaining);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
