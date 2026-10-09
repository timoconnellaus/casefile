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
#    Playwright installs into PLAYWRIGHT_BROWSERS_PATH when the environment sets it (Anthropic's
#    cloud uses /opt/pw-browsers), otherwise ~/.cache/ms-playwright. Prefer full Chromium and fall
#    back to the headless shell.
deno run -A npm:playwright@1 install --with-deps chromium
PW_BROWSERS="${PLAYWRIGHT_BROWSERS_PATH:-${HOME}/.cache/ms-playwright}"
CHROME_PATH="$(find "${PW_BROWSERS}" -type f \( -path '*/chromium-*/chrome-linux*/chrome' \
  -o -path '*/chromium_headless_shell-*/chrome-headless-shell-linux*/chrome-headless-shell' \) \
  2>/dev/null | sort -t/ -k1,1 | awk '/\/chrome$/ { print; found = 1; exit } { last = $0 }
  END { if (!found && last != "") print last }' || true)"
if [ -z "${CHROME_PATH}" ]; then
  echo "No Chromium found under ${PW_BROWSERS} after playwright install" >&2
  exit 1
fi
export CHROME_PATH
grep -q 'CHROME_PATH=' "${HOME}/.bashrc" 2>/dev/null ||
  echo "export CHROME_PATH=\"${CHROME_PATH}\"" >>"${HOME}/.bashrc"
echo "CHROME_PATH=${CHROME_PATH}"
"${CHROME_PATH}" --headless --no-sandbox --dump-dom about:blank >/dev/null # smoke test

# 4. Every dependency, exactly as deno.lock pins it (fails if the lock would change). If the
#    checkout isn't here yet, stop after the tools: the session runs `deno task ci` itself.
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
if [ ! -f deno.json ]; then
  echo "No casefile checkout in $(pwd); tools installed, skipping deno cache and ci"
  exit 0
fi
deno cache --frozen src/cli/main.ts src/app/main.ts scripts/seed.ts tests/*.ts

# 5. Known-good start: fmt check, lint, type check, tests.
deno task ci
