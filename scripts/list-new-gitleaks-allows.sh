#!/usr/bin/env bash
# Lists the lines a change adds that carry gitleaks' allow marker, as GitHub warning
# annotations on those lines and in the job's summary, so a reviewer looks at each: the
# marker tells gitleaks to pass whatever secret-like value is on its line, which is right
# only for a made-up value (.gitleaks.toml). It never fails: a reviewer decides.
#
# Usage: scripts/list-new-gitleaks-allows.sh BASE HEAD   (commits; the change is BASE...HEAD,
#        from their merge base, as a pull request's diff is)
set -euo pipefail

base=${1:?usage: list-new-gitleaks-allows.sh BASE HEAD}
head=${2:?usage: list-new-gitleaks-allows.sh BASE HEAD}
cd "$(git rev-parse --show-toplevel)"

# Built in two parts, so this file's own lines don't carry it.
marker='gitleaks:''allow'
found=()
# Each file the change adds to, by its name as git lists it with -z (NUL-separated, never
# quoted), then that file's diff alone: the name in a diff's `+++ b/` header is quoted
# and escaped when it has a byte git quotes (non-ASCII, a tab, a quote), so such a file was
# missed, its lines not listed.
while IFS= read -r -d '' file; do
  line=0
  # The header runs to the first hunk; a `+++ ` line there is the file's name, not an added
  # line that starts with "++".
  in_header=1
  while IFS= read -r diffline; do
    if [ "$in_header" -eq 1 ]; then
      if [[ $diffline == '@@ '* ]]; then in_header=0; else continue; fi
    fi
    case "$diffline" in
      '@@ '*)
        # @@ -a,b +c,d @@: the hunk's added lines start at line c of the new file.
        hunk=${diffline#*+}
        hunk=${hunk%% *}
        line=${hunk%%,*} ;;
      '+'*)
        if [[ $diffline == *"$marker"* ]]; then found+=("$file:$line"); fi
        line=$((line + 1)) ;;
    esac
  done < <(git diff --no-color --no-ext-diff --no-renames -U0 "$base...$head" -- ":(literal)$file")
done < <(git diff -z --name-only --no-renames --diff-filter=d "$base...$head")

if [ "${#found[@]}" -eq 0 ]; then
  echo "No line this change adds carries $marker."
  exit 0
fi
for where in "${found[@]}"; do
  path=${where%:*}
  # The file= value escapes %, a line break, : and , as the workflow command format asks.
  escaped=${path//%/%25}
  escaped=${escaped//$'\r'/%0D}
  escaped=${escaped//$'\n'/%0A}
  escaped=${escaped//:/%3A}
  escaped=${escaped//,/%2C}
  echo "::warning file=$escaped,line=${where##*:}::This line is new and carries $marker, so gitleaks passes it: check that its value is made up."
done
echo "${#found[@]} new line(s) carry $marker:"
printf '  %s\n' "${found[@]}"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### New \`$marker\` lines"
    echo
    echo "gitleaks passes each of these lines. Check that each value is made up (.gitleaks.toml)."
    echo
    printf -- "- \`%s\`\n" "${found[@]}"
  } >> "$GITHUB_STEP_SUMMARY"
fi
