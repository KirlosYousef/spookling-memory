#!/usr/bin/env node
import { main } from '../cli/src/main.js';

process.exitCode = await main();
