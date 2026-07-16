import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HabitatModule, createModule, readModules, setModuleStatus } from "./modules.js";
import { SupplyCacheItem, restoreToSupplyCache } from "./inventory.js";

export interface ConstructionJob {
  id: string;
  blueprintId: string;
  displayName: string;
  facilityId: string;
  totalTicks: number;
  remainingTicks: number;
  output: Omit<HabitatModule, "id">;
  reservedMaterials?: SupplyCacheItem[];
}

const habitatDirectory = join(process.cwd(), ".habitat");
const constructionPath = join(habitatDirectory, "construction.json");

export async function readConstructionJobs(): Promise<ConstructionJob[]> {
  try {
    const contents = await readFile(constructionPath, "utf8");
    const value = JSON.parse(contents) as unknown;
    if (!Array.isArray(value)) throw new Error("Construction state must be an array.");
    return value.map(parseConstructionJob);
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

export async function writeConstructionJobs(jobs: ConstructionJob[]): Promise<void> {
  await mkdir(habitatDirectory, { recursive: true });
  await writeFile(constructionPath, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
}

export async function startConstruction(job: ConstructionJob): Promise<void> {
  const jobs = await readConstructionJobs();
  if (jobs.some((existing) => existing.facilityId === job.facilityId)) {
    throw new Error("That facility already has a construction job in progress.");
  }
  await writeConstructionJobs([...jobs, job]);
  await setModuleStatus(job.facilityId, "active");
}

export async function advanceConstruction(ticks: number): Promise<ConstructionJob[]> {
  const jobs = await readConstructionJobs();
  const completed: ConstructionJob[] = [];
  const remaining: ConstructionJob[] = [];

  for (const job of jobs) {
    const remainingTicks = Math.max(0, job.remainingTicks - ticks);
    if (remainingTicks === 0) {
      completed.push(job);
    } else {
      remaining.push({ ...job, remainingTicks });
    }
  }

  await writeConstructionJobs(remaining);
  for (const job of completed) {
    await createModule(job.output);
    await setModuleStatus(job.facilityId, "online");
  }

  return completed;
}

export async function cancelConstruction(reference: string): Promise<{ job: ConstructionJob; materialsReturned: boolean }> {
  const jobs = await readConstructionJobs();
  const modules = await readModules();
  const index = jobs.findIndex((job) => matchesJobReference(job, reference, modules));
  if (index < 0) throw new Error(`Construction job not found: ${reference}`);

  const [job] = jobs.splice(index, 1);
  await writeConstructionJobs(jobs);
  const reservedMaterials = job.reservedMaterials ?? [];
  if (reservedMaterials.length > 0) await restoreToSupplyCache(reservedMaterials);
  await setModuleStatus(job.facilityId, "online");
  return { job, materialsReturned: reservedMaterials.length > 0 };
}

export async function clearConstructionJobs(): Promise<void> {
  await rm(constructionPath, { force: true });
}

function parseConstructionJob(value: unknown, index: number): ConstructionJob {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.blueprintId !== "string" || typeof value.displayName !== "string" || typeof value.facilityId !== "string" || !isTickCount(value.totalTicks) || !isTickCount(value.remainingTicks) || !isModuleDraft(value.output) || (value.reservedMaterials !== undefined && !isSupplyCacheItems(value.reservedMaterials))) {
    throw new Error(`Invalid construction job at index ${index}.`);
  }
  return value as unknown as ConstructionJob;
}

function matchesJobReference(job: ConstructionJob, reference: string, modules: HabitatModule[]): boolean {
  if (job.id === reference || job.facilityId === reference || job.displayName === reference) return true;
  const facility = modules.find((module) => module.id === job.facilityId);
  if (!facility) return false;
  const serverIdMatch = facility.id.match(new RegExp(`_${facility.blueprintId.replace(/-/g, "_")}_(\\d+)$`));
  if (serverIdMatch) return `${facility.blueprintId}-${serverIdMatch[1]}` === reference;
  const index = modules.indexOf(facility);
  const sameBlueprintIndex = modules.slice(0, index + 1).filter((module) => module.blueprintId === facility.blueprintId).length;
  return `${facility.blueprintId}-${sameBlueprintIndex}` === reference;
}

function isSupplyCacheItems(value: unknown): value is SupplyCacheItem[] {
  return Array.isArray(value) && value.every((item) => isRecord(item) && typeof item.resourceName === "string" && typeof item.amount === "number" && typeof item.unit === "string");
}

function isModuleDraft(value: unknown): value is Omit<HabitatModule, "id"> {
  return isRecord(value) && typeof value.blueprintId === "string" && typeof value.displayName === "string" && Array.isArray(value.connectedTo) && isRecord(value.runtimeAttributes) && Array.isArray(value.capabilities);
}

function isTickCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
