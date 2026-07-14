import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HabitatModule, readModules, writeModules } from "./modules.js";

export interface HabitatSimulationState {
  currentTick: number;
}

export interface TickResult {
  appliedTicks: number;
  currentTick: number;
  totalPowerDrawKw: number;
  energyDrainedKwh: number;
  batteryRemainingKwh: number;
  unmetEnergyKwh: number;
}

const habitatDirectory = join(process.cwd(), ".habitat");
const simulationPath = join(habitatDirectory, "simulation.json");

export async function applyLocalTicks(count: number): Promise<TickResult> {
  validateTickCount(count);

  const modules = await readModules();
  const simulation = await readSimulationState();
  const batteries = findBatteries(modules);
  const totalPowerDrawKw = calculatePowerDraw(modules);
  const energyRequestedKwh = (totalPowerDrawKw * count) / 3600;
  const batteryRemainingBeforeKwh = batteries.reduce(
    (total, battery) => total + battery.energyKwh,
    0,
  );
  const energyDrainedKwh = Math.min(energyRequestedKwh, batteryRemainingBeforeKwh);
  let remainingToDrainKwh = energyDrainedKwh;
  const currentTick = simulation.currentTick + count;
  if (!Number.isSafeInteger(currentTick)) {
    throw new Error("Tick count would exceed the maximum supported simulation tick.");
  }

  for (const battery of batteries) {
    const drained = Math.min(battery.energyKwh, remainingToDrainKwh);
    battery.module.runtimeAttributes.currentEnergyKwh = battery.energyKwh - drained;
    remainingToDrainKwh -= drained;
  }

  await writeModules(modules);
  await writeSimulationState({ currentTick });

  return {
    appliedTicks: count,
    currentTick,
    totalPowerDrawKw,
    energyDrainedKwh,
    batteryRemainingKwh: batteryRemainingBeforeKwh - energyDrainedKwh,
    unmetEnergyKwh: energyRequestedKwh - energyDrainedKwh,
  };
}

async function readSimulationState(): Promise<HabitatSimulationState> {
  try {
    const contents = await readFile(simulationPath, "utf8");
    const parsed = JSON.parse(contents) as Partial<HabitatSimulationState>;
    const currentTick = parsed.currentTick;
    if (typeof currentTick !== "number" || !Number.isSafeInteger(currentTick) || currentTick < 0) {
      throw new Error("Invalid .habitat/simulation.json: currentTick must be a non-negative integer.");
    }
    return { currentTick };
  } catch (error) {
    if (isMissingFile(error)) {
      return { currentTick: 0 };
    }
    throw error;
  }
}

async function writeSimulationState(state: HabitatSimulationState): Promise<void> {
  await mkdir(habitatDirectory, { recursive: true });
  await writeFile(simulationPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function calculatePowerDraw(modules: HabitatModule[]): number {
  return modules.reduce((total, module) => {
    const attributes = module.runtimeAttributes;
    const status = attributes.status;
    const powerDraw = attributes.powerDrawKw;

    if (typeof status !== "string" || !isRecord(powerDraw)) {
      throw new Error(`Module ${module.id} is missing a valid powerDrawKw map for its status.`);
    }

    const draw = powerDraw[status];
    if (typeof draw !== "number" || !Number.isFinite(draw) || draw < 0) {
      throw new Error(`Module ${module.id} has no valid power draw for status "${status}".`);
    }

    return total + draw;
  }, 0);
}

function findBatteries(modules: HabitatModule[]): BatteryState[] {
  const batteries = modules
    .filter((module) => module.capabilities.includes("power-storage"))
    .map((module) => {
      const currentEnergyKwh = module.runtimeAttributes.currentEnergyKwh;
      if (typeof currentEnergyKwh !== "number" || !Number.isFinite(currentEnergyKwh) || currentEnergyKwh < 0) {
        throw new Error(`Power-storage module ${module.id} has invalid currentEnergyKwh.`);
      }
      return { module, energyKwh: currentEnergyKwh };
    });

  if (batteries.length === 0) {
    throw new Error("No power-storage module found; cannot apply a local tick.");
  }

  return batteries;
}

function validateTickCount(count: number): void {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error("Tick count must be a positive integer.");
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface BatteryState {
  module: HabitatModule;
  energyKwh: number;
}
