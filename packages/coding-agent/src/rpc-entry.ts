#!/usr/bin/env node
import "./legacy-env.ts";
import { APP_NAME } from "./config.ts";
import { configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { main } from "./main.ts";

process.title = `${APP_NAME}-rpc`;
process.env.RUNKILN_CODING_AGENT = "true";
process.emitWarning = (() => {}) as typeof process.emitWarning;

await configureHttpDispatcher();

main(["--mode", "rpc", ...process.argv.slice(2)]);
