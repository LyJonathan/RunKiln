#!/usr/bin/env node
import "./legacy-env.ts";
import { setupCli } from "./cli/setup.ts";
import { main } from "./main.ts";

setupCli();
main(process.argv.slice(2));
