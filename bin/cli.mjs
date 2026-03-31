#!/usr/bin/env node

import { wrap } from '../lib/wrap.js';
import { restore } from '../lib/restore.js';
import { status } from '../lib/status.js';
import { resolveBinPath, parseTimeout } from '../lib/utils.js';

function printUsage() {
  console.error(`Usage: npx @lionad/bin-timeout-wrapper [options] -- /path/to/binary

Options:
  --timeout N   Timeout in seconds (default: 5)
  --restore     Restore the original binary
  --status      Check wrap status of the binary

Examples:
  npx @lionad/bin-timeout-wrapper --timeout 5 -- /usr/local/bin/rg
  npx @lionad/bin-timeout-wrapper --restore -- /usr/local/bin/rg
  npx @lionad/bin-timeout-wrapper --status -- /usr/local/bin/rg`);
}

async function main() {
  const args = process.argv.slice(2);

  let mode = 'wrap';
  let timeout = 5;
  let binPath = null;
  let pastSeparator = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (pastSeparator) {
      if (binPath === null) {
        binPath = arg;
      }
      continue;
    }

    if (arg === '--') {
      pastSeparator = true;
      continue;
    }

    if (arg === '--restore') {
      mode = 'restore';
      continue;
    }

    if (arg === '--status') {
      mode = 'status';
      continue;
    }

    if (arg === '--timeout') {
      const next = args[++i];
      if (next === undefined) {
        console.error('Error: --timeout requires a value');
        process.exit(1);
      }
      timeout = parseTimeout(next);
      continue;
    }

    // Unknown argument before separator
    console.error(`Error: Unknown argument: ${arg}`);
    printUsage();
    process.exit(1);
  }

  if (!binPath) {
    console.error('Error: No binary path specified. Use -- /path/to/binary');
    printUsage();
    process.exit(1);
  }

  try {
    if (mode === 'wrap') {
      const resolvedPath = resolveBinPath(binPath);
      const result = await wrap(resolvedPath, timeout);
      console.log(`Wrapped: ${result.binPath}`);
      console.log(`  Backup: ${result.backupPath}`);
      console.log(`  Timeout: ${result.timeout}s (override with BIN_TIMEOUT env var)`);
    } else if (mode === 'restore') {
      const resolvedPath = resolveBinPath(binPath);
      const result = await restore(resolvedPath);
      console.log(`Restored: ${result.binPath}`);
      console.log(`  From backup: ${result.restoredFrom}`);
    } else if (mode === 'status') {
      const resolvedPath = resolveBinPath(binPath);
      const result = await status(resolvedPath);
      if (result.wrapped) {
        console.log(`Status: wrapped`);
        console.log(`  Binary: ${result.binPath}`);
        console.log(`  Timeout: ${result.timeout}s (override with BIN_TIMEOUT env var)`);
        console.log(`  Backup: ${result.backupPath}`);
      } else {
        console.log(`Status: not wrapped`);
        console.log(`  Binary: ${result.binPath}`);
      }
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
