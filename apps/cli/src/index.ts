#!/usr/bin/env node
import { runCli } from './program.js';

runCli(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = 1;
  },
);
