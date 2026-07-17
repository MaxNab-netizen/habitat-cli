import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadKeplerConfig } from "./config.js";
import { KeplerClient, SolarIrradianceReading } from "./kepler-client.js";
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
  solarIrradianceWPerM2: number;
  solarCondition: string;
  solarEnergyGeneratedKwh: number;
  solarChargingReason?: string;
}

const habitatDirectory = join(process.cwd(), ".habitat");
const simulationPath = join(habitatDirectory, "simulation.json");

export async function applyLocalTicks(count: number): Promise<TickResult> {
  validateTickCount(count);

  const modules = await readModules();
  const simulation = await readSimulationState();
  const irradiance = await createKeplerClient().getSolarIrradiance();
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
    battery.energyKwh -= drained;
    battery.module.runtimeAttributes.currentEnergyKwh = battery.energyKwh;
    remainingToDrainKwh -= drained;
  }

  const solar = applySolarCharging(modules, irradiance, count, batteries);

  await writeModules(modules);
  await writeSimulationState({ currentTick });

  return {
    appliedTicks: count,
    currentTick,
    totalPowerDrawKw,
    energyDrainedKwh,
    batteryRemainingKwh: batteries.reduce((total, battery) => total + battery.energyKwh, 0),
    unmetEnergyKwh: energyRequestedKwh - energyDrainedKwh,
    solarIrradianceWPerM2: irradiance.wPerM2,
    solarCondition: irradiance.condition,
    solarEnergyGeneratedKwh: solar.energyAddedKwh,
    ...(solar.reason ? { solarChargingReason: solar.reason } : {}),
  };
}

function createKeplerClient(): KeplerClient {
  const config = loadKeplerConfig();
  return new KeplerClient(config.baseUrl, config.token);
}

function applySolarCharging(
  modules: HabitatModule[],
  irradiance: SolarIrradianceReading,
  tickCount: number,
  batteries: BatteryState[],
): { energyAddedKwh: number; reason?: string } {
  const solarModules = modules.filter((module) => module.capabilities.includes("solar-generation"));
  const onlineSolarModules = solarModules.filter((module) => isOperational(module));
  const onlineBatteries = batteries.filter(({ module }) => isOperational(module));

  if (solarModules.length === 0) return { energyAddedKwh: 0, reason: "No solar-generation module exists." };
  if (onlineSolarModules.length === 0) return { energyAddedKwh: 0, reason: "All solar-generation modules are offline or damaged." };
  if (onlineBatteries.length === 0) return { energyAddedKwh: 0, reason: "All batteries are offline or damaged." };
  if (irradiance.wPerM2 <= 0) return { energyAddedKwh: 0, reason: "Solar irradiance is not usable." };

  const solarMultiplier = irradiance.wPerM2 / 900;
  const effectiveGenerationKw = onlineSolarModules.reduce((total, module) => {
    const powerGenerationKw = module.runtimeAttributes.powerGenerationKw;
    if (typeof powerGenerationKw !== "number" || !Number.isFinite(powerGenerationKw) || powerGenerationKw < 0) {
      throw new Error(`Solar module ${module.id} has invalid powerGenerationKw.`);
    }
    return total + powerGenerationKw * solarMultiplier * 0.5;
  }, 0);
  const generatedKwh = (effectiveGenerationKw * tickCount) / 3600;
  let remainingToAddKwh = generatedKwh;

  for (const battery of onlineBatteries) {
    const capacityKwh = battery.module.runtimeAttributes.energyStorageKwh;
    if (typeof capacityKwh !== "number" || !Number.isFinite(capacityKwh) || capacityKwh < 0) {
      throw new Error(`Power-storage module ${battery.module.id} has invalid energyStorageKwh.`);
    }
    const availableCapacityKwh = Math.max(0, capacityKwh - battery.energyKwh);
    const added = Math.min(availableCapacityKwh, remainingToAddKwh);
    battery.energyKwh += added;
    battery.module.runtimeAttributes.currentEnergyKwh = battery.energyKwh;
    remainingToAddKwh -= added;
    if (remainingToAddKwh <= 0) break;
  }

  const energyAddedKwh = generatedKwh - remainingToAddKwh;
  return energyAddedKwh > 0
    ? { energyAddedKwh }
    : { energyAddedKwh: 0, reason: "Battery is already full." };
}

function isOperational(module: HabitatModule): boolean {
  const status = module.runtimeAttributes.status;
  return status === "online" || status === "idle" || status === "active";
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
