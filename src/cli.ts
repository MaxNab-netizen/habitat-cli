import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { loadKeplerConfig } from "./config.js";
import { KeplerApiError, KeplerClient } from "./kepler-client.js";
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
  } catch (error) {
    if (isNotFound(error)) {
      await deleteRegistrationState();
      console.log("This habitat is not registered with Kepler.");
      return;
    }

    throw error;
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
