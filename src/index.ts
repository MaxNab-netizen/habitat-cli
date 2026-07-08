#!/usr/bin/env bun

import { createProgram } from "./cli.js";

await createProgram().parseAsync(process.argv);
