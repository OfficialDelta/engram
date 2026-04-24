#!/usr/bin/env node
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { runInstall } from './install.js';
import { runUninstall } from './uninstall.js';
import { runStatus, formatStatus } from './status.js';
import { runConfig } from './config.js';

function printUsage(): void {
  console.log(`Usage: engram <command>

Commands:
  install     Register engram hooks and initialize project data
  uninstall   Remove engram hooks from Claude Code settings
  status      Show engram graph stats, hook registration, and data info
  config      Show, set, or interactively configure engram settings
  mcp         Start MCP server exposing engram tools
  consolidate Manually consolidate stale sessions
  inspect     Show detailed knowledge graph summary

Run 'engram <command> --help' for more information on a command.

Getting started:
  1. engram install        Set up hooks for this project
  2. engram config         Configure API keys and providers
  3. engram status         Check system health`);
}

async function main(): Promise<void> {
  const subcommand = process.argv[2];

  switch (subcommand) {
    case 'install': {
      try {
        const gsd = process.argv.slice(3).includes('--gsd');
        const result = runInstall({
          claudeConfigDir: resolve(homedir(), '.claude'),
          cwd: process.cwd(),
          gsd,
        });
        console.log('engram installed successfully:\n');
        if (gsd) {
          console.log(`  ✓ Extension installed at ${result.gsdExtensionPath}`);
          console.log(`  ✓ Data directory created at ${result.dataDir}`);
          console.log(`  ✓ Database initialized at ${result.dbPath}`);
          console.log('\n  Run `gsd trust` or `pi trust` in this project to allow the extension to load.');
        } else {
          console.log(`  ✓ Hooks registered in ${result.settingsPath}`);
          console.log(`  ✓ Data directory created at ${result.dataDir}`);
          console.log(`  ✓ Database initialized at ${result.dbPath}`);
        }
        if (result.warnings.length > 0) {
          console.log('');
          for (const w of result.warnings) {
            console.log(`  ⚠ ${w}`);
          }
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`Try running "engram status" to check your setup.`);
        process.exit(1);
      }
      break;
    }
    case 'config': {
      await runConfig(process.argv.slice(3));
      break;
    }
    case 'mcp': {
      if (process.argv.slice(3).includes('--help')) {
        console.log(`Usage: engram mcp

Start the MCP (Model Context Protocol) server exposing engram tools.

The server communicates over stdio and exposes two tools:
  query_knowledge   Query the engram knowledge graph with a natural language question
  save_decision     Save a decision to the engram knowledge graph for future retrieval

To configure in Claude Code, add to .claude/settings.json:
  { "mcpServers": { "engram": { "command": "engram", "args": ["mcp"] } } }

Options:
  --help  Show this help message`);
        break;
      }
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
    case 'consolidate': {
      if (process.argv.slice(3).includes('--help')) {
        const { printUsage: printConsolidateUsage } = await import('./consolidate.js');
        printConsolidateUsage();
        break;
      }
      const { runConsolidate } = await import('./consolidate.js');
      const args = process.argv.slice(3);
      const dryRun = args.includes('--dry-run');
      const retryFailed = args.includes('--retry-failed');
      const sessionId = args.find(a => !a.startsWith('--'));
      const result = await runConsolidate({
        cwd: process.cwd(),
        ...(sessionId != null ? { sessionId } : {}),
        dryRun,
        retryFailed,
      });
      if (!dryRun) {
        console.log(`\nDone: ${result.processed} processed, ${result.failed} failed, ${result.skipped} skipped`);
      }
      break;
    }
    case 'inspect': {
      if (process.argv.slice(3).includes('--help')) {
        const { printUsage: printInspectUsage } = await import('./inspect.js');
        printInspectUsage();
        break;
      }
      const { runInspect, formatInspect } = await import('./inspect.js');
      const inspectArgs = process.argv.slice(3);
      const json = inspectArgs.includes('--json');
      const superseded = inspectArgs.includes('--superseded');
      const topIdx = inspectArgs.indexOf('--top');
      const top = topIdx !== -1 ? parseInt(inspectArgs[topIdx + 1]!, 10) : undefined;
      const typeIdx = inspectArgs.indexOf('--type');
      const type = typeIdx !== -1 ? inspectArgs[typeIdx + 1] : undefined;
      try {
        const inspectResult = runInspect({ cwd: process.cwd(), ...(top != null ? { top } : {}), ...(type != null ? { type } : {}), superseded, json });
        console.log(json ? JSON.stringify(inspectResult, null, 2) : formatInspect(inspectResult));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      break;
    }
    default:
      if (subcommand && subcommand !== '--help' && subcommand !== '-h') {
        console.error(`Unknown command: ${subcommand}\n\nRun 'engram --help' for available commands.\nDid you mean: install, uninstall, status, config, mcp, consolidate, inspect?\n`);
        process.exit(1);
        break;
      }
      printUsage();
      process.exit(0);
      break;
  }
}

const argv1Real = (() => { try { return realpathSync(resolve(process.argv[1] ?? '')); } catch { return resolve(process.argv[1] ?? ''); } })();
if (argv1Real === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
