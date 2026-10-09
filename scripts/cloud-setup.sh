#!/usr/bin/env bash
# Setup script for a Claude Code cloud environment (Linux) working on casefile.
#
# Paste this file's contents into the environment's setup script. It installs the pinned Deno,
# headless Chromium for the browser checks, and every dependency in deno.lock, then runs the full
# CI once so a session starts from a known-good state.
#
# Synthetic data only (ADR 11): no secrets, no model downloads. Tests that need the real name
# finder or a language model stay skipped unless CASEFILE_TEST_NER / CASEFILE_TEST_LLM_URL are
# set, so leave those unset here. The desktop app (`deno task desktop`) is macOS only.
set -euo pipefail

DENO_VERSION="2.9.2" # keep in step with the local toolchain (`deno --version`)

# 1. Deno, pinned.
if ! command -v deno >/dev/null || ! deno --version | grep -q "deno ${DENO_VERSION}"; then
  curl -fsSL https://deno.land/install.sh | sh -s "v${DENO_VERSION}"
fi
export DENO_INSTALL="${HOME}/.deno"
export PATH="${DENO_INSTALL}/bin:${PATH}"
grep -q '.deno/bin' "${HOME}/.bashrc" 2>/dev/null ||
  echo 'export PATH="$HOME/.deno/bin:$PATH"' >>"${HOME}/.bashrc"

# 2. Small tools: sqlite3 for inspecting test databases, unzip for the Deno installer.
if command -v apt-get >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq sqlite3 unzip >/dev/null
fi

# 3. Headless Chromium for the browser checks, with its system libraries. Browser scripts launch
#    it with `executablePath: Deno.env.get("CHROME_PATH")` and `--no-sandbox`. Each session runs
#    the app on its own --dir, CASEFILE_CONFIG_DIR and port.
deno run -A npm:playwright@1 install --with-deps chromium
CHROME_PATH="$(ls -d "${HOME}"/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | head -1)"
export CHROME_PATH
grep -q 'CHROME_PATH=' "${HOME}/.bashrc" 2>/dev/null ||
  echo "export CHROME_PATH=\"${CHROME_PATH}\"" >>"${HOME}/.bashrc"
"${CHROME_PATH}" --headless=new --no-sandbox --dump-dom about:blank >/dev/null # smoke test

# 4. Every dependency, exactly as deno.lock pins it (fails if the lock would change).
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
deno cache --frozen src/cli/main.ts src/app/main.ts scripts/seed.ts tests/*.ts

# 5. Known-good start: fmt check, lint, type check, tests.
deno task ci
