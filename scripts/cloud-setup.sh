#!/usr/bin/env bash
# Setup script for a Claude Code cloud environment (Linux) working on casefile.
#
# Paste this file's contents into the environment's setup script. It installs the pinned Deno,
# headless Chromium for the browser checks, the libraries a Linux `deno desktop` build needs, and
# every dependency in deno.lock, then runs the full CI once so a session starts from a known-good
# state.
#
# Tools go into /usr/local/bin and settings into /etc/profile.d as well as ~/.bashrc, because a
# session's shell may read neither the setup script's environment nor ~/.bashrc. Also set
# DENO_CERT in the environment's variables if the session can't fetch over HTTPS (see step 2).
#
# Synthetic data only (ADR 11): no secrets, no model downloads. Tests that need the real name
# finder or a language model stay skipped unless CASEFILE_TEST_NER / CASEFILE_TEST_LLM_URL are
# set, so leave those unset here.
set -euo pipefail

DENO_VERSION="2.9.7" # the release workflow's version; build_desktop.ts needs 2.9.5 or later

SUDO=""
[ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null && SUDO="sudo"
PROFILE=/etc/profile.d/casefile.sh

# Remember a setting for later shells: this script, login shells and interactive shells.
persist() { # name value
  export "$1=$2"
  ${SUDO} touch "${PROFILE}"
  grep -q "^export $1=" "${PROFILE}" 2>/dev/null ||
    echo "export $1=\"$2\"" | ${SUDO} tee -a "${PROFILE}" >/dev/null
  grep -q "^export $1=" "${HOME}/.bashrc" 2>/dev/null ||
    echo "export $1=\"$2\"" >>"${HOME}/.bashrc"
}

# 1. System packages: unzip for Deno, sqlite3 for inspecting test databases, and the WebKitGTK
#    runtime plus a virtual display so a Linux `deno desktop` build can be launched under
#    `xvfb-run` (for example to test the updater).
if command -v apt-get >/dev/null; then
  ${SUDO} apt-get update -qq
  ${SUDO} apt-get install -y -qq unzip sqlite3 libwebkit2gtk-4.1-0 xvfb >/dev/null
fi

# 2. The cloud's HTTPS proxy uses its own certificate authority; Deno needs to be told about it.
for ca in /root/.ccr/ca-bundle.crt "${HOME}/.ccr/ca-bundle.crt"; do
  if [ -f "${ca}" ]; then
    persist DENO_CERT "${ca}"
    break
  fi
done

# 3. Deno, pinned, into /usr/local/bin so every shell finds it.
if ! command -v deno >/dev/null || ! deno --version | grep -q "deno ${DENO_VERSION} "; then
  case "$(uname -m)" in
    x86_64) target="x86_64-unknown-linux-gnu" ;;
    aarch64 | arm64) target="aarch64-unknown-linux-gnu" ;;
    *) echo "Unsupported machine $(uname -m)" >&2 && exit 1 ;;
  esac
  tmp="$(mktemp -d)"
  curl -fsSL -o "${tmp}/deno.zip" \
    "https://dl.deno.land/release/v${DENO_VERSION}/deno-${target}.zip"
  unzip -q -o "${tmp}/deno.zip" -d "${tmp}"
  ${SUDO} install -m 0755 "${tmp}/deno" /usr/local/bin/deno
  rm -rf "${tmp}"
fi
hash -r
deno --version | head -1

# 4. Headless Chromium for the browser checks (`deno task browsercheck`), with its system
#    libraries. Browser scripts launch it with `executablePath: Deno.env.get("CHROME_PATH")` and
#    `--no-sandbox`, or fall back to Playwright's own lookup. Each session runs the app on its own
#    --dir, CASEFILE_CONFIG_DIR and port. Playwright installs into PLAYWRIGHT_BROWSERS_PATH when
#    the environment sets it (Anthropic's cloud uses /opt/pw-browsers), otherwise
#    ~/.cache/ms-playwright. Prefer full Chromium and fall back to the headless shell.
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
persist CHROME_PATH "${CHROME_PATH}"
echo "CHROME_PATH=${CHROME_PATH}"
"${CHROME_PATH}" --headless --no-sandbox --dump-dom about:blank >/dev/null # smoke test

# 5. Every dependency, exactly as deno.lock pins it (fails if the lock would change). If the
#    checkout isn't here yet, stop after the tools: the session runs `deno task ci` itself.
cd "${CLAUDE_PROJECT_DIR:-$(pwd)}"
if [ ! -f deno.json ]; then
  echo "No casefile checkout in $(pwd); tools installed, skipping deno cache and ci"
  exit 0
fi
deno cache --frozen src/cli/main.ts src/app/main.ts scripts/seed.ts tests/*.ts

# 6. Known-good start: fmt check, lint, type check, tests.
deno task ci
