import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface SupplyCacheItem {
  resourceName: string;
  amount: number;
  unit: string;
}

const inventoryPath = join(process.cwd(), ".habitat", "inventory.json");
const habitatDirectory = join(process.cwd(), ".habitat");

export async function readSupplyCacheInventory(): Promise<SupplyCacheItem[]> {
  try {
    const contents = await readFile(inventoryPath, "utf8");
    const value = JSON.parse(contents) as unknown;

    if (!Array.isArray(value)) {
      throw new Error("Supply cache inventory must be an array.");
    }

    return value.map(parseSupplyCacheItem);
  } catch (error) {
    if (isMissingFile(error)) {
      return [];
    }

    throw error;
  }
}

export async function writeSupplyCacheInventory(items: SupplyCacheItem[]): Promise<void> {
  await mkdir(habitatDirectory, { recursive: true });
  await writeFile(inventoryPath, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

export async function addToSupplyCache(resourceName: string, amount: number, unit: string): Promise<SupplyCacheItem> {
  const normalizedResourceName = resourceName.trim();
  const normalizedUnit = unit.trim();
  if (!normalizedResourceName) {
    throw new Error("Resource name cannot be empty.");
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be greater than zero.");
  }
  if (!normalizedUnit) {
    throw new Error("Unit cannot be empty.");
  }

  const inventory = await readSupplyCacheInventory();
  const existing = inventory.find((item) => item.resourceName === normalizedResourceName);
  if (existing) {
    if (existing.unit !== normalizedUnit) {
      throw new Error(`${normalizedResourceName} is already stored in ${existing.unit}; cannot add ${normalizedUnit}.`);
    }
    existing.amount += amount;
    await writeSupplyCacheInventory(inventory);
    return existing;
  }

  const item = { resourceName: normalizedResourceName, amount, unit: normalizedUnit };
  await writeSupplyCacheInventory([...inventory, item]);
  return item;
}

export async function restoreToSupplyCache(itemsToRestore: SupplyCacheItem[]): Promise<void> {
  const inventory = await readSupplyCacheInventory();
  for (const item of itemsToRestore) {
    const existing = inventory.find((candidate) => candidate.resourceName === item.resourceName);
    if (existing) {
      if (existing.unit !== item.unit) throw new Error(`${item.resourceName} is already stored in ${existing.unit}; cannot restore ${item.unit}.`);
      existing.amount += item.amount;
    } else {
      inventory.push({ ...item });
    }
  }
  await writeSupplyCacheInventory(inventory);
}

function parseSupplyCacheItem(value: unknown, index: number): SupplyCacheItem {
  if (!isRecord(value) || typeof value.resourceName !== "string" || !value.resourceName.trim() || typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount < 0 || typeof value.unit !== "string" || !value.unit.trim()) {
    throw new Error(`Invalid supply cache inventory item at index ${index}.`);
  }

  return {
    resourceName: value.resourceName.trim(),
    amount: value.amount,
    unit: value.unit.trim(),
  };
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
