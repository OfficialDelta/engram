#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runInstall } from './install.js';

function printUsage(): void {
  console.log(`Usage: engram <command>

Commands:
  install     Register engram hooks and initialize project data
  uninstall   (not yet implemented)
  status      (not yet implemented)
  mcp         (not yet implemented)

Run 'engram <command> --help' for more information on a command.`);
}

function main(): void {
  const subcommand = process.argv[2];

  switch (subcommand) {
    case 'install': {
      try {
        const result = runInstall({
          claudeConfigDir: resolve(homedir(), '.claude'),
          cwd: process.cwd(),
        });
        console.log('engram installed successfully:\n');
        console.log(`  ✓ Hooks registered in ${result.settingsPath}`);
        console.log(`  ✓ Data directory created at ${result.dataDir}`);
        console.log(`  ✓ Database initialized at ${result.dbPath}`);
        if (result.warnings.length > 0) {
          console.log('');
          for (const w of result.warnings) {
            console.log(`  ⚠ ${w}`);
          }
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }
    case 'uninstall':
    case 'status':
    case 'mcp':
      console.log(`engram ${subcommand}: not yet implemented`);
      process.exit(1);
      break;
    default:
      if (subcommand && subcommand !== '--help' && subcommand !== '-h') {
        console.error(`Unknown command: ${subcommand}\n`);
      }
      printUsage();
      process.exit(subcommand ? 1 : 0);
      break;
  }
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
