# kteam problem log

Append every kteam malfunction here (problem, evidence, suspected code path,
workaround) — see the kteam-experimental rule in CLAUDE.md. Commit and push so
entries merge across machines.

All entries logged through 2026-07-19 were root-caused, fixed, and verified in
real use; the full history lives in git (`git log -- kteam-prob.md`, fixes
landed through commit ff567bb). Highlights of what got fixed along the way:
env propagation to panes, launch.sh env sourcing, injection turn-start proof,
serialized bootstrap, pane-derived state (false completed/failed), atomic
revive-send, `wait --until-marker`, quota/auth fail-fast, and the loge
custom-api-key dialog.

<!-- New problems go below this line. -->
