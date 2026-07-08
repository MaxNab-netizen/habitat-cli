import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface HabitatRegistrationState {
  habitatId: string;
  habitatUuid: string;
  displayName: string;
  registeredAt: string;
}

const habitatDirectory = join(process.cwd(), ".habitat");
const registrationPath = join(habitatDirectory, "registration.json");

export async function readRegistrationState(): Promise<HabitatRegistrationState | null> {
  try {
    const contents = await readFile(registrationPath, "utf8");
    return JSON.parse(contents) as HabitatRegistrationState;
  } catch (error) {
    if (isMissingFile(error)) {
      return null;
    }

    throw error;
  }
}

export async function writeRegistrationState(state: HabitatRegistrationState): Promise<void> {
  await mkdir(habitatDirectory, { recursive: true });
  await writeFile(registrationPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

export async function deleteRegistrationState(): Promise<void> {
  await rm(registrationPath, { force: true });
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}
