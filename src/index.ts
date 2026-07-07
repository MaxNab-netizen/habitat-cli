#!/usr/bin/env bun

import { Command, CommanderError } from "commander";

const program = new Command();

program
  .name("habitat")
  .description("Habitat CLI")
  .version("0.1.0")
  .showHelpAfterError("Run `habitat --help` for usage.");

program.configureOutput({
  writeErr: () => {},
});

program.exitOverride();

function run(): void {
  try {
    program.parse(process.argv);
  } catch (error) {
    const commandName = process.argv.slice(2).find((arg) => !arg.startsWith("-"));

    if (
      error instanceof CommanderError &&
      (error.code === "commander.unknownCommand" || error.code === "commander.excessArguments")
    ) {
      console.error(`Unknown command: ${commandName ?? "unknown"}`);
      console.error('Run `habitat --help` to see the available commands.');
      process.exitCode = 1;
      return;
    }

    if (error instanceof CommanderError && error.code === "commander.version") {
      process.exitCode = 0;
      return;
    }

    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") {
      process.exitCode = 0;
      return;
    }

    if (error instanceof CommanderError) {
      console.error(error.message);
      process.exitCode = error.exitCode || 1;
      return;
    }

    throw error;
  }
}

run();
