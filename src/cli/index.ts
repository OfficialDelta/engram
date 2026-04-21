#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runInstall } from './install.js';
import { runUninstall } from './uninstall.js';
import { runStatus, formatStatus } from './status.js';

function printUsage(): void {
  console.log(`Usage: engram <command>

Commands:
  install     Register engram hooks and initialize project data
  uninstall   Remove engram hooks from Claude Code settings
  status      Show engram graph stats, hook registration, and data info
  mcp         Start MCP server exposing engram tools

Run 'engram <command> --help' for more information on a command.`);
}

async function main(): Promise<void> {
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
    case 'mcp': {
      const { runMcp } = await import('./mcp.js');
      await runMcp(process.cwd());
      break;
    }
    case 'uninstall': {
      try {
        const purge = process.argv.slice(3).includes('--purge');
        const result = runUninstall({
          claudeConfigDir: resolve(homedir(), '.claude'),
          cwd: process.cwd(),
          purge,
        });
        if (result.hooksRemoved > 0) {
          console.log(`  ✓ Removed ${result.hooksRemoved} hook(s) from ${result.settingsPath}`);
        } else {
          console.log('  No engram hooks found in settings.');
        }
        if (result.dataDirRemoved) {
          console.log(`  ✓ Removed data directory ${result.dataDir}`);
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
      break;
    }
    case 'status': {
      const result = runStatus({
        claudeConfigDir: resolve(homedir(), '.claude'),
        cwd: process.cwd(),
      });
      console.log(formatStatus(result));
      break;
    }
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
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
