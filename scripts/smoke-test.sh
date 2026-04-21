#!/usr/bin/env bash
set -euo pipefail

# Manual smoke test for the engram pipeline with real APIs.
# This script GUIDES you through each step — it does not execute them automatically.
# Real API calls require human judgment to verify outputs.

BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

step() {
  echo ""
  echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════════════════${RESET}"
  echo -e "${BOLD}${CYAN}  Step $1: $2${RESET}"
  echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════════════════${RESET}"
  echo ""
}

cmd() {
  echo -e "  ${GREEN}\$ $1${RESET}"
}

expect() {
  echo -e "  ${BOLD}Expected:${RESET} $1"
}

troubleshoot() {
  echo -e "  ${YELLOW}Troubleshoot:${RESET} $1"
}

pause() {
  echo ""
  echo -e "${DIM}  Press Enter when ready to continue...${RESET}"
  read -r
}

echo -e "${BOLD}"
echo "  ╔═══════════════════════════════════════════════════════╗"
echo "  ║          engram — Manual Smoke Test Guide             ║"
echo "  ║                                                       ║"
echo "  ║   6-step real-API verification of the full pipeline   ║"
echo "  ║   events → consolidation → graph → retrieval →        ║"
echo "  ║   context injection → contradiction detection         ║"
echo "  ╚═══════════════════════════════════════════════════════╝"
echo -e "${RESET}"

echo -e "${BOLD}Prerequisites:${RESET}"
echo "  • Node.js >= 18"
echo "  • Anthropic API key (ANTHROPIC_API_KEY or set via engram config)"
echo "  • engram built and available: npm run build && npm link"
echo "  • Optional: Ollama running locally for local embeddings"
echo "    (ollama serve, then: ollama pull nomic-embed-text)"
echo ""
echo -e "${BOLD}Before you begin:${RESET}"
echo "  Make sure you're in a test project directory (not the engram repo itself)."
echo "  Create one if needed:"
cmd "mkdir -p /tmp/engram-smoke && cd /tmp/engram-smoke && git init"
echo ""

pause

# ─────────────────────────────────────────────────────────────
# Step 1: Install
# ─────────────────────────────────────────────────────────────
step 1 "Install — register hooks and initialize database"

echo "  Run the install command to register Claude Code hooks and"
echo "  set up the engram data directory (~/.engram/<project-hash>/)."
echo ""
cmd "engram install"
echo ""
expect "Output shows:"
echo "    • 4 hooks registered (PostToolUse, SessionStart, UserPromptSubmit, Stop)"
echo "    • Data directory created"
echo "    • Database initialized"
echo "    • Prompt to run 'engram config' for API keys"
echo ""
troubleshoot "If 'engram: command not found', run 'npm link' from the engram repo."
troubleshoot "If hooks fail to register, check ~/.claude/settings.json exists."
troubleshoot "Run 'engram status' to verify hook registration."

pause

# ─────────────────────────────────────────────────────────────
# Step 2: Config
# ─────────────────────────────────────────────────────────────
step 2 "Config — set API keys and verify configuration"

echo "  Configure the LLM and embedding providers."
echo ""
echo -e "  ${BOLD}Option A: Interactive wizard${RESET}"
cmd "engram config"
echo ""
echo -e "  ${BOLD}Option B: Set keys directly${RESET}"
cmd "engram config set llm.apiKey sk-ant-..."
cmd "engram config set embedding.provider anthropic"
echo "  (or 'ollama' for local embeddings)"
echo ""
echo -e "  ${BOLD}Verify:${RESET}"
cmd "engram config show"
echo ""
expect "Output shows key=value pairs with API keys masked:"
echo "    llm.apiKey = sk-ant-***...***"
echo "    llm.pass1Model = claude-haiku-4-5-20251001"
echo "    llm.pass2Model = claude-sonnet-4-5-20250514"
echo "    embedding.provider = anthropic (or ollama)"
echo ""
troubleshoot "Config is stored at ~/.engram/config.json — check it directly if needed."
troubleshoot "Run 'engram status' to see config validity and embedding provider status."

pause

# ─────────────────────────────────────────────────────────────
# Step 3: Create session events
# ─────────────────────────────────────────────────────────────
step 3 "Create session events — trigger file_read/file_write events"

echo "  Events are created automatically by the Claude Code hooks during"
echo "  normal usage. To generate events for this test:"
echo ""
echo -e "  ${BOLD}Option A: Use Claude Code naturally${RESET}"
echo "    1. Open Claude Code in the test project"
echo "    2. Ask it to read and modify a file (e.g., 'read package.json and add a description')"
echo "    3. The PostToolUse hook fires on each tool call, recording events"
echo ""
echo -e "  ${BOLD}Option B: Create events manually (for testing without Claude Code)${RESET}"
echo "    Create a JSONL event file in the engram data directory:"
cmd "DATA_DIR=\$(engram status 2>&1 | grep -o 'Data dir: .*' | cut -d' ' -f3-)"
cmd "SESSION_ID=\$(date +%s)-manual-test"
cmd "mkdir -p \"\$DATA_DIR/sessions\""
cmd "cat > \"\$DATA_DIR/sessions/\$SESSION_ID.jsonl\" << 'EVENTS'"
echo '    {"type":"file_read","timestamp":"'"\$(date -Iseconds)"'","file":"src/auth.ts","content":"export function authenticate(token: string) { return verify(token); }"}'
echo '    {"type":"file_write","timestamp":"'"\$(date -Iseconds)"'","file":"src/auth.ts","content":"export function authenticate(token: string) { return bcrypt.compare(token, hash); }"}'
echo "EVENTS"
echo ""
expect "Events file created with file_read and file_write entries."
echo ""
troubleshoot "Run 'engram status' — check 'Pending consolidations' count."
troubleshoot "Event files are JSONL in \$DATA_DIR/sessions/<session-id>.jsonl"

pause

# ─────────────────────────────────────────────────────────────
# Step 4: Trigger consolidation
# ─────────────────────────────────────────────────────────────
step 4 "Trigger consolidation — process events into knowledge graph"

echo "  Consolidation transforms raw session events into graph nodes."
echo "  It triggers automatically when the Stop hook fires (session end)"
echo "  and the turn/event thresholds are met."
echo ""
echo -e "  ${BOLD}Automatic (via Claude Code):${RESET}"
echo "    Simply end your Claude Code session (Ctrl+C or /exit)."
echo "    The Stop hook checks thresholds and spawns consolidation if met."
echo ""
echo -e "  ${BOLD}Thresholds (from config):${RESET}"
echo "    consolidation.turnThreshold  — min turns before consolidation (default: 3)"
echo "    consolidation.eventThreshold — min events before consolidation (default: 10)"
echo "    Lower these for testing:"
cmd "engram config set consolidation.turnThreshold 1"
cmd "engram config set consolidation.eventThreshold 1"
echo ""
echo -e "  ${BOLD}Watch for consolidation:${RESET}"
cmd "engram status"
echo "    Check 'Pending consolidations' drops to 0 and 'Graph nodes' increases."
echo ""
expect "After consolidation completes:"
echo "    • engram status shows new graph nodes"
echo "    • No pending consolidations remain"
echo "    • No failed consolidations"
echo ""
troubleshoot "Check logs at \$DATA_DIR/logs/stop.log for consolidation errors."
troubleshoot "Verify API key is valid — consolidation requires LLM calls."
troubleshoot "Run 'engram status' to check for failed consolidations (shows warning)."

pause

# ─────────────────────────────────────────────────────────────
# Step 5: Query knowledge
# ─────────────────────────────────────────────────────────────
step 5 "Query knowledge — verify graph nodes via MCP"

echo "  The engram MCP server exposes a query_knowledge tool."
echo "  Test it by sending a query about the code you worked with."
echo ""
echo -e "  ${BOLD}Option A: Via Claude Code (recommended)${RESET}"
echo "    Start Claude Code and ask a question about code you edited."
echo "    If engram hooks are registered, the MCP tools are available."
echo "    Try: 'What authentication approach is this project using?'"
echo ""
echo -e "  ${BOLD}Option B: Direct MCP call via stdin${RESET}"
echo "    The MCP server speaks JSON-RPC over stdio:"
cmd "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"query_knowledge\",\"arguments\":{\"question\":\"How does authentication work?\"}}}' | engram mcp"
echo ""
expect "Response includes:"
echo "    • Graph nodes related to your query"
echo "    • Descriptions extracted during consolidation"
echo "    • Relevance-ranked results from spreading activation"
echo ""
troubleshoot "If no results, check 'engram status' for graph node count."
troubleshoot "If graph is empty, consolidation may not have completed — check Step 4."
troubleshoot "MCP errors are logged to stderr."

pause

# ─────────────────────────────────────────────────────────────
# Step 6: Verify contradiction detection
# ─────────────────────────────────────────────────────────────
step 6 "Verify contradiction detection — detect conflicting decisions"

echo "  Contradiction detection fires when a file_write event occurs"
echo "  and the written code conflicts with a stored decision."
echo ""
echo -e "  ${BOLD}Step 6a: Store a decision${RESET}"
echo "    Via MCP (in Claude Code or direct):"
cmd "echo '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"save_decision\",\"arguments\":{\"decision\":\"Use bcrypt for password hashing\",\"rationale\":\"Industry standard, resistant to brute force\",\"affected_files\":[\"src/auth.ts\"]}}}' | engram mcp"
echo ""
echo -e "  ${BOLD}Step 6b: Write contradicting code${RESET}"
echo "    In Claude Code, write code that contradicts the decision."
echo "    For example, change src/auth.ts to use MD5 instead of bcrypt."
echo "    The PostToolUse hook detects the file_write, spawns the"
echo "    contradiction worker, and checks against stored decisions."
echo ""
expect "Claude Code shows a warning in hookSpecificOutput:"
echo "    ⚠️ CONTRADICTION: code change in src/auth.ts may conflict"
echo "    with decision 'Use bcrypt for password hashing'"
echo ""
troubleshoot "Check \$DATA_DIR/logs/post-tool-use.log for contradiction worker output."
troubleshoot "Ensure the decision was saved (query_knowledge should return it)."
troubleshoot "Contradiction detection requires a valid LLM API key (uses Haiku)."

pause

# ─────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}${GREEN}  Smoke Test Complete!${RESET}"
echo -e "${BOLD}${GREEN}═══════════════════════════════════════════════════════════${RESET}"
echo ""
echo "  If all 6 steps produced expected results, the full pipeline works:"
echo ""
echo "    ✓ Step 1: Hooks installed, database initialized"
echo "    ✓ Step 2: Config set with valid API keys"
echo "    ✓ Step 3: Session events recorded"
echo "    ✓ Step 4: Consolidation processed events into graph"
echo "    ✓ Step 5: Knowledge retrieval returns relevant nodes"
echo "    ✓ Step 6: Contradiction detection flags conflicting writes"
echo ""
echo -e "  ${BOLD}Cleanup:${RESET}"
cmd "engram uninstall          # remove hooks"
cmd "engram uninstall --purge  # remove hooks + data directory"
echo ""
echo -e "${DIM}  Report issues: https://github.com/OfficialDelta/engram/issues${RESET}"
