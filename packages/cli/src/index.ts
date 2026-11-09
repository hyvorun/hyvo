#!/usr/bin/env node
// The `hyvo` binary. Read-only: it reads Robinhood Chain and Hyvo's public API, and never signs or sends anything.
import { main } from "./cli.js";
import { nodeContext } from "./context.js";

process.exitCode = await main(process.argv.slice(2), nodeContext());
