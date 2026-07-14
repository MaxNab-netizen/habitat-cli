import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { loadKeplerConfig } from "./config.js";
import { KeplerApiError, KeplerClient } from "./kepler-client.js";
import { HabitatModule, createModule, deleteModule, readModules, updateModule, writeModules } from "./modules.js";
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

  const modules = program.command("module").description("Manage local Habitat modules.");
  modules.command("list").description("List local Habitat modules.").action(async () => {
    for (const module of await readModules()) {
      console.log(`${module.displayName}  ${module.blueprintId}`);
    }
  });
  modules.command("show <id>").description("Show one local module.").action(async (id: string) => {
    const module = (await readModules()).find((item) => item.id === id);
    if (!module) throw new Error(`Module not found: ${id}`);
    console.log(JSON.stringify(module, null, 2));
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
      const changes: Partial<Omit<HabitatModule, "id">> = {};
      if (options.name !== undefined) changes.displayName = options.name;
      if (options.blueprintId !== undefined) changes.blueprintId = options.blueprintId;
      if (options.runtimeAttributes !== undefined) changes.runtimeAttributes = parseJsonObject(options.runtimeAttributes, "runtime attributes");
      if (options.capability !== undefined) changes.capabilities = options.capability;
      console.log(JSON.stringify(await updateModule(id, changes), null, 2));
    });
  modules.command("delete <id>").description("Delete a local Habitat module.").action(async (id: string) => {
    await deleteModule(id);
    console.log(`Deleted module ${id}.`);
  });

  program.addHelpText(
    "after",
    `

Examples:
  habitat register --name "Artemis Ridge"
  habitat status
  habitat unregister
`,
  );

  return program;
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
