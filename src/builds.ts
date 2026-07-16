import { randomUUID } from "node:crypto";
import { ProductionBlueprint } from "./blueprints.js";
import { ConstructionJob, readConstructionJobs, startConstruction } from "./construction.js";
import { SupplyCacheItem, readSupplyCacheInventory, writeSupplyCacheInventory } from "./inventory.js";
import { HabitatModule, readModules } from "./modules.js";

interface BuildRequirement {
  resourceName: string;
  amount: number;
}

export interface BuildPlan {
  blueprint: ProductionBlueprint;
  facility: HabitatModule;
  requirements: BuildRequirement[];
  inventory: SupplyCacheItem[];
  missingRequirements: BuildRequirement[];
  buildTicks: number;
  powerCost: number | undefined;
}

export async function createBuildPlan(blueprint: ProductionBlueprint): Promise<BuildPlan> {
  const requirements = readRequirements(blueprint.inputs);
  const requiredFacility = readRequiredFacility(blueprint);
  const modules = await readModules();
  const facility = modules.find((module) => module.blueprintId === requiredFacility && isOperational(module));
  if (!facility) {
    throw new Error(`No operational ${requiredFacility} is available to build ${blueprint.displayName}.`);
  }
  if ((await readConstructionJobs()).some((job) => job.facilityId === facility.id)) {
    throw new Error(`${facility.displayName} already has a construction job in progress.`);
  }

  const inventory = await readSupplyCacheInventory();
  const availableByResource = new Map(inventory.map((item) => [item.resourceName, item.amount]));
  const missingRequirements = requirements
    .map((requirement) => ({ resourceName: requirement.resourceName, amount: requirement.amount - (availableByResource.get(requirement.resourceName) ?? 0) }))
    .filter((requirement) => requirement.amount > 0);

  return {
    blueprint,
    facility,
    requirements,
    inventory,
    missingRequirements,
    buildTicks: readBuildTicks(blueprint),
    powerCost: readPowerCost(blueprint),
  };
}

export async function startBuild(plan: BuildPlan): Promise<ConstructionJob> {
  if (plan.missingRequirements.length > 0) {
    throw new Error("Cannot build: insufficient resources in the supply cache.");
  }

  const output = readModuleOutput(plan.blueprint);
  const remainingInventory = plan.inventory
    .map((item) => ({
      ...item,
      amount: item.amount - (plan.requirements.find((requirement) => requirement.resourceName === item.resourceName)?.amount ?? 0),
    }))
    .filter((item) => item.amount > 0);

  await writeSupplyCacheInventory(remainingInventory);
  const job: ConstructionJob = {
    id: `construction_${randomUUID()}`,
    blueprintId: plan.blueprint.blueprintId,
    displayName: output.displayName,
    facilityId: plan.facility.id,
    totalTicks: plan.buildTicks,
    remainingTicks: plan.buildTicks,
    output: {
      blueprintId: output.moduleType,
      displayName: output.displayName,
      connectedTo: [],
      runtimeAttributes: readRuntimeAttributes(plan.blueprint),
      capabilities: readCapabilities(plan.blueprint),
    },
    reservedMaterials: plan.requirements.map((requirement) => {
      const stock = plan.inventory.find((item) => item.resourceName === requirement.resourceName);
      return { resourceName: requirement.resourceName, amount: requirement.amount, unit: stock?.unit ?? "kg" };
    }),
  };
  await startConstruction(job);
  return job;
}

export function formatBuildPlan(plan: BuildPlan, dryRun: boolean): string[] {
  const lines = [`${dryRun ? "Build dry run" : "Build plan"}: ${plan.blueprint.displayName}`, `Facility: ${plan.facility.displayName}`, `Duration: ${plan.buildTicks} ticks`];
  if (plan.powerCost !== undefined) lines.push(`Power cost: ${plan.powerCost}`);
  lines.push("Materials:");

  const availableByResource = new Map(plan.inventory.map((item) => [item.resourceName, item.amount]));
  for (const requirement of plan.requirements) {
    const available = availableByResource.get(requirement.resourceName) ?? 0;
    const result = available >= requirement.amount ? "ready" : `missing ${requirement.amount - available}`;
    lines.push(`  ${requirement.resourceName}: ${requirement.amount} required, ${available} available (${result})`);
  }

  lines.push(plan.missingRequirements.length === 0 ? "Ready to build." : "Cannot build: insufficient resources in the supply cache.");
  return lines;
}

function readRequirements(inputs: Record<string, unknown>): BuildRequirement[] {
  return Object.entries(inputs).map(([resourceName, amount]) => {
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`Blueprint input ${resourceName} has an invalid amount.`);
    }
    return { resourceName, amount };
  });
}

function readRequiredFacility(blueprint: ProductionBlueprint): string {
  const requiredFacility = blueprint.requiredFacility;
  if (!isRecord(requiredFacility) || typeof requiredFacility.moduleType !== "string" || !requiredFacility.moduleType) {
    throw new Error(`Blueprint ${blueprint.blueprintId} does not specify a required facility.`);
  }
  return requiredFacility.moduleType;
}

function isOperational(module: HabitatModule): boolean {
  const status = module.runtimeAttributes.status;
  return status === "online" || status === "active";
}

function readPowerCost(blueprint: ProductionBlueprint): number | undefined {
  const productionCost = blueprint.productionCost;
  if (!isRecord(productionCost) || typeof productionCost.power !== "number" || !Number.isFinite(productionCost.power) || productionCost.power < 0) {
    return undefined;
  }
  return productionCost.power;
}

function readBuildTicks(blueprint: ProductionBlueprint): number {
  if (!Number.isSafeInteger(blueprint.buildTicks) || blueprint.buildTicks < 1) {
    throw new Error(`Blueprint ${blueprint.blueprintId} has an invalid build duration.`);
  }
  return blueprint.buildTicks;
}

function readModuleOutput(blueprint: ProductionBlueprint): { moduleType: string; displayName: string } {
  const output = blueprint.output;
  if (!isRecord(output) || output.itemType !== "module" || typeof output.moduleType !== "string" || !output.moduleType) {
    throw new Error(`Blueprint ${blueprint.blueprintId} does not produce a module.`);
  }

  return {
    moduleType: output.moduleType,
    displayName: blueprint.displayName.replace(/ Blueprint$/, ""),
  };
}

function readRuntimeAttributes(blueprint: ProductionBlueprint): Record<string, unknown> {
  if (!isRecord(blueprint.runtimeAttributes)) {
    throw new Error(`Blueprint ${blueprint.blueprintId} has invalid runtime attributes.`);
  }
  return blueprint.runtimeAttributes;
}

function readCapabilities(blueprint: ProductionBlueprint): string[] {
  if (!Array.isArray(blueprint.capabilities) || !blueprint.capabilities.every((capability) => typeof capability === "string")) {
    throw new Error(`Blueprint ${blueprint.blueprintId} has invalid capabilities.`);
  }
  return blueprint.capabilities;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
