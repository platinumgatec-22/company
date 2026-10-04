#!/bin/bash
# Installs MarkItDown (https://github.com/microsoft/markitdown) so any file
# can be converted to Markdown in Claude Code cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if ! command -v markitdown >/dev/null 2>&1; then
  pip install --quiet --root-user-action=ignore 'markitdown[all]'
fi
