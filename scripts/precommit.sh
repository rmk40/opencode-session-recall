#!/bin/sh
set -eu

staged_files=$(mktemp)
trap 'rm -f "$staged_files"' EXIT INT TERM

git diff --cached --name-only -z --diff-filter=ACMR >"$staged_files"

npm run fix

if [ -s "$staged_files" ]; then
  xargs -0 git add -- <"$staged_files"
fi

npm run check
