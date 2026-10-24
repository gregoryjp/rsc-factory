#!/usr/bin/env node
import { loadConfig } from "../config/env.js";
import { EXIT_USAGE, runCli } from "./program.js";

const main = async (): Promise<number> => {
	const config = loadConfig();
	if (!config.ok) {
		console.error(`error [${config.error.code}]: ${config.error.message}`);
		return EXIT_USAGE;
	}
	return runCli(process.argv.slice(2), config.value, {
		out: (line) => console.log(line),
		error: (line) => console.error(line),
	});
};

process.exitCode = await main();
