import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { readOfficialBlueprint, readOfficialBlueprintCatalog } from "./blueprints.js";
import { createBuildPlan, formatBuildPlan, startBuild } from "./builds.js";
import { loadKeplerConfig } from "./config.js";
import { advanceConstruction, cancelConstruction, clearConstructionJobs, readConstructionJobs } from "./construction.js";
import { addToSupplyCache, readSupplyCacheInventory } from "./inventory.js";
import { KeplerApiError, KeplerClient } from "./kepler-client.js";
import { HabitatModule, HabitatModuleState, createModule, deleteModule, readModules, setModuleStatus, updateModule, writeModules } from "./modules.js";
import { filterMaterialResources, readOfficialResourceCatalog } from "./resources.js";
import { applyLocalTicks } from "./simulation.js";
import {
  deleteRegistrationState,
  readRegistrationState,
  writeRegistrationState,
} from "./state.js";

export function createProgram(): Command {
  const program = new Command();

  program
    .name("habitat")
    .description("Register this habitat with Kepler.")
    .version("0.1.0")
    .showHelpAfterError();

  program
    .command("register")
    .description("Register this habitat with Kepler.")
    .requiredOption("--name <habitat name>", "Habitat display name")
    .action(async (options: { name: string }) => {
      await registerHabitat(options.name);
    });

  const build = program
    .command("build [blueprint-id]")
    .description("Build a module, or show local construction status.")
    .option("--dry-run", "Validate the build without changing local state")
    .action(async (blueprintId: string | undefined, options: { dryRun?: boolean }) => {
      if (blueprintId === "status") {
        await showBuildStatus();
        return;
      }
      if (!blueprintId) {
        throw new Error("Specify a blueprint ID, or use: habitat build status");
      }

      const plan = await createBuildPlan(await readOfficialBlueprint(createClient(), blueprintId));
      console.log(formatBuildPlan(plan, options.dryRun === true).join("\n"));
      if (options.dryRun || plan.missingRequirements.length > 0) return;

      const job = await startBuild(plan);
      console.log(`Started ${job.displayName}; it will complete in ${job.remainingTicks} ticks.`);
    });
  build.command("status").description("Show pending local construction jobs.").action(async () => {
    await showBuildStatus();
  });
  build.command("cancel <reference>").description("Cancel a pending construction job.").action(async (reference: string) => {
    const result = await cancelConstruction(reference);
    console.log(`Cancelled ${result.job.displayName}.`);
    console.log(result.materialsReturned ? "Reserved materials returned to the supply cache." : "No reserved material record was available to return.");
  });

  program
    .command("status")
    .description("Show whether this habitat is registered.")
    .action(async () => {
      await showStatus();
    });

  program
    .command("unregister")
    .description("Remove this habitat from Kepler.")
    .action(async () => {
      await unregisterHabitat();
    });

  program
    .command("tick <count>")
    .description("Advance the local power simulation by a number of seconds.")
    .action(async (count: string) => {
      const result = await applyLocalTicks(parseTickCount(count));
      console.log(`Applied ${result.appliedTicks} local tick${result.appliedTicks === 1 ? "" : "s"}.`);
      console.log(`Current tick: ${result.currentTick}`);
      console.log(`Energy drained: ${formatEnergy(result.energyDrainedKwh)} kWh`);
      console.log(`Battery remaining: ${formatEnergy(result.batteryRemainingKwh)} kWh`);
      console.log(`Solar irradiance: ${result.solarIrradianceWPerM2} W/m² (${result.solarCondition})`);
      console.log(`Solar energy generated: ${formatEnergy(result.solarEnergyGeneratedKwh)} kWh`);
      if (result.solarChargingReason) console.log(`Solar charging: ${result.solarChargingReason}`);
      if (result.unmetEnergyKwh > 0) {
        console.log(`Unmet energy: ${formatEnergy(result.unmetEnergyKwh)} kWh`);
      }
      const completed = await advanceConstruction(result.appliedTicks);
      for (const job of completed) {
        console.log(`Construction complete: ${job.displayName}.`);
      }
    });

  const blueprints = program.command("blueprint").description("Inspect official Kepler blueprints.");
  blueprints.command("list").description("List official Kepler blueprints.").action(async () => {
    const catalog = await readOfficialBlueprintCatalog(createClient());
    for (const blueprint of catalog.blueprints) {
      console.log(`${blueprint.blueprintId}  ${blueprint.displayName}`);
    }
  });
  blueprints.command("show <blueprint-id>").description("Show one official Kepler blueprint.").action(async (blueprintId: string) => {
    console.log(JSON.stringify(await readOfficialBlueprint(createClient(), blueprintId), null, 2));
  });

  const resources = program.command("resource").description("Inspect official Kepler resource types.");
  resources.command("list").description("List official Kepler resource types.").action(async () => {
    const catalog = await readOfficialResourceCatalog(createClient());
    console.log(`Catalog version: ${catalog.catalogVersion}`);
    console.log("Resource type  Name  Kind  Unit");
    for (const resource of filterMaterialResources(catalog.resources)) {
      console.log(`${resource.resourceType}  ${resource.displayName}  ${resource.kind}  ${resource.unit ?? "-"}`);
    }
  });

  const world = program.command("world").description("Inspect the current Kepler world state.");
  world
    .command("solar-irradiance")
    .description("Query the current solar irradiance from Kepler.")
    .action(async () => {
      const reading = await createClient().getSolarIrradiance();
      console.log(`Solar irradiance: ${reading.wPerM2} W/m²`);
      console.log(`Condition: ${reading.condition}`);
    });

  const solar = program.command("solar").description("Inspect solar power conditions.");
  solar.command("status").description("Show current Kepler solar irradiance.").action(async () => {
    const reading = await createClient().getSolarIrradiance();
    console.log(`Solar irradiance: ${reading.wPerM2} W/m²`);
    console.log(`Condition: ${reading.condition}`);
  });

  const inventory = program.command("inventory").description("Inspect resources stored in the local supply cache.");
  inventory.command("list").description("List resources and quantities in the supply cache.").action(async () => {
    const items = await readSupplyCacheInventory();
    if (items.length === 0) {
      console.log("The supply cache is empty.");
      return;
    }

    const resourceWidth = Math.max("Resource".length, ...items.map((item) => item.resourceName.length));
    const amountWidth = Math.max("Amount".length, ...items.map((item) => formatInventoryAmount(item.amount).length));
    console.log(`${"Resource".padEnd(resourceWidth)}  ${"Amount".padStart(amountWidth)}  Unit`);
    console.log(`${"-".repeat(resourceWidth)}  ${"-".repeat(amountWidth)}  ----`);
    for (const item of items) {
      console.log(`${item.resourceName.padEnd(resourceWidth)}  ${formatInventoryAmount(item.amount).padStart(amountWidth)}  ${item.unit}`);
    }
  });
  inventory
    .command("add <resource-name> <amount>")
    .description("Add a resource quantity to the supply cache.")
    .option("--unit <unit>", "Unit for the resource amount", "kg")
    .action(async (resourceName: string, amount: string, options: { unit: string }) => {
      const item = await addToSupplyCache(resourceName, parseInventoryAmount(amount), options.unit);
      console.log(`Supply cache now has ${formatInventoryAmount(item.amount)} ${item.unit} of ${item.resourceName}.`);
    });

  const modules = program.command("module").description("Manage local Habitat modules.");
  modules.command("list").description("List local Habitat modules.").action(async () => {
    const allModules = await readModules();
    for (const [index, module] of allModules.entries()) {
      console.log(`${getReadableModuleId(module, index, allModules)}  ${module.displayName}  ${module.blueprintId}`);
    }
  });
  modules.command("show <id>").description("Show one local module.").action(async (id: string) => {
    const allModules = await readModules();
    const module = findModuleByReference(allModules, id);
    if (!module) throw new Error(`Module not found: ${id}`);
    console.log(JSON.stringify({ shortId: getReadableModuleId(module, allModules.indexOf(module), allModules), ...module }, null, 2));
  });
  modules.command("status").description("Show module states and current power draw.").action(async () => {
    await showModulePowerStatus();
  });
  modules
    .command("set-status <module-id> <status>")
    .description("Set one local module's runtime state.")
    .action(async (moduleId: string, status: string) => {
      const modulesBeforeUpdate = await readModules();
      const module = findModuleByReference(modulesBeforeUpdate, moduleId);
      if (!module) throw new Error(`Module not found: ${moduleId}`);

      const nextStatus = parseModuleState(status);
      const result = await setModuleStatus(module.id, nextStatus);
      console.log(`Set ${moduleId} to ${nextStatus}. Current power draw: ${result.powerDrawKw.toFixed(3)} kW.`);
    });
  modules
    .command("create")
    .description("Create a local Habitat module.")
    .requiredOption("--blueprint-id <id>", "Blueprint identifier")
    .requiredOption("--name <display name>", "Module display name")
    .option("--runtime-attributes <json>", "Runtime attributes as JSON", "{}")
    .option("--capability <capability...>", "Module capabilities")
    .action(async (options: { blueprintId: string; name: string; runtimeAttributes: string; capability?: string[] }) => {
      const module = await createModule({
        blueprintId: options.blueprintId,
        displayName: options.name,
        connectedTo: [],
        runtimeAttributes: parseJsonObject(options.runtimeAttributes, "runtime attributes"),
        capabilities: options.capability ?? [],
      });
      console.log(JSON.stringify(module, null, 2));
    });
  modules
    .command("update <id>")
    .description("Update a local Habitat module.")
    .option("--name <display name>", "Module display name")
    .option("--blueprint-id <id>", "Blueprint identifier")
    .option("--runtime-attributes <json>", "Runtime attributes as JSON")
    .option("--capability <capability...>", "Module capabilities")
    .action(async (id: string, options: { name?: string; blueprintId?: string; runtimeAttributes?: string; capability?: string[] }) => {
      const allModules = await readModules();
      const module = findModuleByReference(allModules, id);
      if (!module) throw new Error(`Module not found: ${id}`);
      const changes: Partial<Omit<HabitatModule, "id">> = {};
      if (options.name !== undefined) changes.displayName = options.name;
      if (options.blueprintId !== undefined) changes.blueprintId = options.blueprintId;
      if (options.runtimeAttributes !== undefined) changes.runtimeAttributes = parseJsonObject(options.runtimeAttributes, "runtime attributes");
      if (options.capability !== undefined) changes.capabilities = options.capability;
      console.log(JSON.stringify(await updateModule(module.id, changes), null, 2));
    });
  modules.command("delete <id>").description("Delete a local Habitat module.").action(async (id: string) => {
    const module = findModuleByReference(await readModules(), id);
    if (!module) throw new Error(`Module not found: ${id}`);
    await deleteModule(module.id);
    console.log(`Deleted module ${id}.`);
  });

  program.addHelpText(
    "after",
    `

Examples:
  habitat register --name "Artemis Ridge"
  habitat status
  habitat blueprint list
  habitat blueprint show basic-battery
  habitat resource list
  habitat solar status
  habitat inventory list
  habitat inventory add ferrite 55
  habitat build basic-battery --dry-run
  habitat build status
  habitat tick 10
  habitat unregister
`,
  );

  return program;
}

function parseTickCount(value: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error("Tick count must be a positive integer.");
  }

  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Tick count must be a positive integer.");
  }

  return count;
}

function formatEnergy(value: number): string {
  return value.toFixed(6);
}

function formatInventoryAmount(value: number): string {
  return String(value);
}

function parseInventoryAmount(value: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Amount must be greater than zero.");
  }
  return amount;
}

async function showBuildStatus(): Promise<void> {
  const jobs = await readConstructionJobs();
  if (jobs.length === 0) {
    console.log("No construction is in progress.");
    return;
  }

  console.log("Construction in progress:");
  for (const job of jobs) {
    console.log(`${job.id}  ${job.displayName}: ${job.remainingTicks} of ${job.totalTicks} ticks remaining`);
  }
}

function findModuleByReference(modules: HabitatModule[], reference: string): HabitatModule | undefined {
  return modules.find((module, index) => module.id === reference || getReadableModuleId(module, index, modules) === reference);
}

function getReadableModuleId(module: HabitatModule, index: number, modules: HabitatModule[]): string {
  const normalizedBlueprintId = module.blueprintId.replace(/-/g, "_");
  const serverIdMatch = module.id.match(new RegExp(`_${normalizedBlueprintId}_(\\d+)$`));
  if (serverIdMatch) {
    return `${module.blueprintId}-${serverIdMatch[1]}`;
  }

  const sameBlueprintIndex = modules
    .slice(0, index + 1)
    .filter((candidate) => candidate.blueprintId === module.blueprintId).length;
  return `${module.blueprintId}-${sameBlueprintIndex}`;
}

async function registerHabitat(displayName: string): Promise<void> {
  const client = createClient();
  const currentState = await readRegistrationState();
  const habitatUuid = currentState?.habitatUuid ?? randomUUID();
  const response = await client.registerHabitat({
    displayName,
    habitatUuid,
  });
  const habitatId = extractString(response, ["habitatId", "id", "habitat.id", "habitat.habitatId"]);

  if (!habitatId) {
    throw new Error("Kepler did not return a habitatId for this registration.");
  }

  await writeModules(extractStarterModules(response));

  await writeRegistrationState({
    habitatId,
    habitatUuid,
    displayName,
    registeredAt: new Date().toISOString(),
  });

  console.log(`Registered "${displayName}" with Kepler.`);
}

async function showStatus(): Promise<void> {
  const currentState = await readRegistrationState();

  if (!currentState) {
    console.log("This habitat is not registered with Kepler.");
    return;
  }

  const client = createClient();

  try {
    const response = await client.getHabitatRegistration(currentState.habitatId);
    const displayName = extractString(response, ["displayName", "name"]) ?? currentState.displayName;
    const habitatUuid = extractString(response, ["habitatUuid"]) ?? currentState.habitatUuid;

    console.log("This habitat is registered with Kepler.");
    console.log(`Name: ${displayName}`);
    console.log(`Habitat ID: ${currentState.habitatId}`);
    console.log(`Habitat UUID: ${habitatUuid}`);
    console.log(`Modules: ${(await readModules()).length}`);
  } catch (error) {
    if (isNotFound(error)) {
      await deleteRegistrationState();
      console.log("This habitat is not registered with Kepler.");
      return;
    }

    throw error;
  }
}

async function showModulePowerStatus(): Promise<void> {
  const modules = await readModules();
  const rows = modules.map((module, index) => {
    const state = readModuleState(module);
    const powerDrawKw = readPowerDraw(module);
    return {
      name: module.displayName,
      id: getReadableModuleId(module, index, modules),
      state,
      powerDrawKw,
    };
  });

  const nameWidth = Math.max("Module".length, ...rows.map((row) => row.name.length));
  const idWidth = Math.max("ID".length, ...rows.map((row) => row.id.length));
  const stateWidth = Math.max("State".length, ...rows.map((row) => row.state.length));
  const powerHeader = "Power (kW)";
  const separator = `${"-".repeat(nameWidth)}  ${"-".repeat(idWidth)}  ${"-".repeat(stateWidth)}  ${"-".repeat(powerHeader.length)}`;

  console.log(`${"Module".padEnd(nameWidth)}  ${"ID".padEnd(idWidth)}  ${"State".padEnd(stateWidth)}  ${powerHeader}`);
  console.log(separator);
  for (const row of rows) {
    console.log(`${row.name.padEnd(nameWidth)}  ${row.id.padEnd(idWidth)}  ${row.state.padEnd(stateWidth)}  ${row.powerDrawKw.toFixed(3).padStart(powerHeader.length)}`);
  }

  const totalPowerDrawKw = rows.reduce((total, row) => total + row.powerDrawKw, 0);
  console.log(`\nTotal current power draw: ${totalPowerDrawKw.toFixed(3)} kW`);
  console.log(`Energy cost for one tick: ${(totalPowerDrawKw / 3600).toFixed(6)} kWh`);
}

function readPowerDraw(module: HabitatModule): number {
  const state = readModuleState(module);
  const powerDrawKw = module.runtimeAttributes.powerDrawKw;
  if (!isRecord(powerDrawKw)) {
    throw new Error(`Module ${module.id} is missing a powerDrawKw map.`);
  }

  const draw = powerDrawKw[state];
  if (typeof draw !== "number" || !Number.isFinite(draw) || draw < 0) {
    throw new Error(`Module ${module.id} has no valid power draw for state "${state}".`);
  }

  return draw;
}

function readModuleState(module: HabitatModule): HabitatModuleState {
  const state = module.runtimeAttributes.status;
  if (!isAllowedModuleState(state)) {
    throw new Error(`Module ${module.id} has invalid state; expected online, offline, idle, active, or damaged.`);
  }
  return state;
}

function isAllowedModuleState(value: unknown): value is HabitatModuleState {
  return value === "online" || value === "offline" || value === "idle" || value === "active" || value === "damaged";
}

function parseModuleState(value: string): HabitatModuleState {
  if (!isAllowedModuleState(value)) {
    throw new Error("Status must be one of: offline, idle, online, active, damaged.");
  }
  return value;
}

function extractStarterModules(value: unknown): HabitatModule[] {
  const starterModules = extractPath(value, ["starterModules"]);
  if (!Array.isArray(starterModules)) {
    throw new Error("Kepler did not return starterModules for this registration.");
  }

  return starterModules.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Invalid starter module at index ${index}.`);
    const id = extractString(item, ["id"]);
    const blueprintId = extractString(item, ["blueprintId"]);
    const displayName = extractString(item, ["displayName"]);
    if (!id || !blueprintId || !displayName || !Array.isArray(item.connectedTo) || !isRecord(item.runtimeAttributes) || !Array.isArray(item.capabilities)) {
      throw new Error(`Invalid starter module at index ${index}.`);
    }
    return { id, blueprintId, displayName, connectedTo: item.connectedTo.filter((id): id is string => typeof id === "string"), runtimeAttributes: item.runtimeAttributes, capabilities: item.capabilities.filter((capability): capability is string => typeof capability === "string") };
  });
}

function parseJsonObject(value: string, label: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new Error(`Invalid ${label}; expected a JSON object.`);
  }
}

async function unregisterHabitat(): Promise<void> {
  const currentState = await readRegistrationState();

  if (!currentState) {
    console.log("This habitat is not registered with Kepler.");
    return;
  }

  const client = createClient();

  try {
    await client.unregisterHabitat(currentState.habitatId);
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }

  await deleteRegistrationState();
  await clearConstructionJobs();
  await writeModules([]);
  console.log("Unregistered this habitat from Kepler.");
}

function createClient(): KeplerClient {
  const config = loadKeplerConfig();
  return new KeplerClient(config.baseUrl, config.token);
}

function isNotFound(error: unknown): error is KeplerApiError {
  return error instanceof KeplerApiError && error.status === 404;
}

function extractString(value: unknown, paths: string[]): string | undefined {
  for (const path of paths) {
    const extracted = extractPath(value, path.split("."));
    if (typeof extracted === "string" && extracted.trim()) {
      return extracted.trim();
    }
  }

  return undefined;
}

function extractPath(value: unknown, path: string[]): unknown {
  let current = value;

  for (const segment of path) {
    if (!isRecord(current)) {
      return undefined;
    }

    current = current[segment];
  }

  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
