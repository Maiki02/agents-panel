#!/usr/bin/env bash
# Regenerates the fixtures in this folder from the REAL output of the installed Kyro CLI.
# It works in a throwaway git repo under a temp dir; it never touches .agents/kyro/ of this repo.
# Usage: bash apps/api/test/fixtures/kyro/capture.sh   (needs `kyro` on PATH)
set -euo pipefail

OUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"

git init -q
git config user.name capture
git config user.email capture@example.com
mkdir -p .agents/kyro/scopes
printf '{\n  "schemaVersion": 4,\n  "artifactRoot": ".agents/kyro/scopes"\n}\n' > .agents/kyro/project.json
printf '{\n  "schemaVersion": 4,\n  "activeScope": "demo"\n}\n' > .agents/kyro/local.json

rm -f "$OUT"/context-pack.*.json "$OUT"/status-full.*.json "$OUT"/sprint.*.json "$OUT"/work-*.json "$OUT"/context-pack-task.*.json "$OUT"/capabilities.json

# --- scope fixtures -----------------------------------------------------------------------------

snap() { # snap <state> [scope]
  local scope="${2:-demo}"
  kyro context-pack --kyro-scope "$scope" --json > "$OUT/context-pack.$1.json"
  kyro status full --kyro-scope "$scope" --json > "$OUT/status-full.$1.json"
  cp ".agents/kyro/scopes/$scope/sprint.json" "$OUT/sprint.$1.json" # read-only source of roadmap + ledger
}

plan_init() { # plan_init <scope> <openQuestionsJson>
  cat > init.json <<EOF
{
  "scope": "$1",
  "title": "Demo scope",
  "objective": "Throwaway scope to capture real kyro output.",
  "successCriteria": ["Fixtures captured"],
  "spec": {
    "requirements": [{ "id": "R1", "statement": "Capture states", "priority": "must", "rationale": "fixtures" }],
    "nonGoals": ["none"],
    "openQuestions": $2
  },
  "roadmap": {
    "plannedSprintCount": 2,
    "sizingRationale": "two sprints so sprint n/m is visible",
    "sprints": [{ "n": 1, "slug": "uno", "title": "Uno" }, { "n": 2, "slug": "dos", "title": "Dos" }]
  }
}
EOF
  kyro plan --from init.json --kyro-scope "$1" > /dev/null
}

plan_sprint() { # plan_sprint <n> <slug> <fileA> <fileB>
  cat > sprint.json <<EOF
{
  "sprint": { "n": $1, "slug": "$2", "title": "Sprint $1", "objective": "Sprint $1 objective." },
  "phases": [
    { "id": "P1", "title": "Fase", "objective": "Fase uno",
      "tasks": [
        { "id": "T1.1", "title": "Primera", "description": "Hacer $3", "files_to_touch": ["$3"], "context": "ctx", "acceptance_criteria": ["$3 existe"], "depends_on": [], "scenario_refs": [] },
        { "id": "T1.2", "title": "Segunda", "description": "Hacer $4", "files_to_touch": ["$4"], "context": "ctx", "acceptance_criteria": ["$4 existe"], "depends_on": ["T1.1"], "scenario_refs": [] }
      ] }
  ],
  "definitionOfDone": ["Tareas con pass"],
  "scenarios": []
}
EOF
  kyro plan --from sprint.json --kyro-scope demo > /dev/null
}

finish_task() { # finish_task <taskId> <file>
  echo x > "$2"
  kyro record-evidence "$1" --kyro-scope demo --summary "done" --validation "ls $2" --file "$2" > /dev/null
  kyro review "$1" --kyro-scope demo --verdict pass --yes > /dev/null
}

plan_init demo '[]'
snap plan_sprint
plan_sprint 1 uno a.txt b.txt
snap execute_task
kyro context-pack --kyro-scope demo --task --verbosity detailed --json > "$OUT/context-pack-task.execute_task.json"
kyro capabilities --json > "$OUT/capabilities.json"
echo x > a.txt
kyro record-evidence T1.1 --kyro-scope demo --summary "done" --validation "ls a.txt" --file a.txt > /dev/null
snap review_task
kyro review T1.1 --kyro-scope demo --verdict pass --yes > /dev/null
finish_task T1.2 b.txt
snap qa_or_close
kyro close-sprint --kyro-scope demo --yes > /dev/null
snap plan_sprint_2
plan_sprint 2 dos c.txt d.txt
snap execute_task_sprint_2
finish_task T1.1 c.txt
finish_task T1.2 d.txt
kyro close-sprint --kyro-scope demo --yes > /dev/null
snap await_scope_completion
kyro scope complete --kyro-scope demo --yes > /dev/null
snap done

plan_init demo-clarify '["¿Qué base de datos?"]'
snap clarify demo-clarify

# --- work fixtures ------------------------------------------------------------------------------

rev() { kyro work status --work demo-work --json | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["work"]["revision"])'; }
wsnap() { # wsnap <state>
  kyro work status --work demo-work --json > "$OUT/work-status.$1.json"
  kyro work context-pack --work demo-work --json > "$OUT/work-context-pack.$1.json"
}

echo "Arreglar un typo en README" > brief.md
kyro work create --id demo-work --from brief.md --by maker > /dev/null
wsnap plan_tasks
cat > wplan.json <<'EOF'
{"tasks":[
  {"id":"W1","title":"Typo","description":"Arreglar typo","context":"ctx","acceptanceCriteria":["Typo corregido"],"filesToTouch":["README.md"],"dependsOn":[]},
  {"id":"W2","title":"Doc","description":"Actualizar doc","context":"ctx","acceptanceCriteria":["Doc actualizada"],"filesToTouch":["DOC.md"],"dependsOn":["W1"]}
]}
EOF
kyro work plan --work demo-work --from wplan.json --expect-revision "$(rev)" --by maker > /dev/null
wsnap execute_task
kyro work start --work demo-work --task W1 --expect-revision "$(rev)" --by maker > /dev/null
wsnap in_progress
cat > wev.json <<'EOF'
{"summary":"typo corregido","validations":[{"command":"grep","result":"passed","note":null}],"filesChanged":["README.md"],"notes":null}
EOF
kyro work record-evidence --work demo-work --task W1 --from wev.json --expect-revision "$(rev)" --by maker > /dev/null
wsnap awaiting_review
echo '{"checkedCriteria":["Typo corregido"],"findings":[]}' > wrev.json
kyro work review --work demo-work --task W1 --from wrev.json --verdict pass --expect-revision "$(rev)" --by checker > /dev/null
kyro work start --work demo-work --task W2 --expect-revision "$(rev)" --by maker > /dev/null
kyro work block --work demo-work --task W2 --reason "falta una decision" --expect-revision "$(rev)" --by maker > /dev/null
wsnap resolve_blocker
kyro work unblock --work demo-work --task W2 --expect-revision "$(rev)" --by maker > /dev/null
kyro work dispose --work demo-work --task W2 --kind cancelled --reason "no hace falta" --expect-revision "$(rev)" --by maker > /dev/null
wsnap ready_to_close
kyro work close --work demo-work --outcome completed --reason "listo" --expect-revision "$(rev)" --by maker --yes > /dev/null
wsnap closed

echo "fixtures written to $OUT"
ls "$OUT"
