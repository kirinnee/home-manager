---
org: vungle
baseBranch: master
ticketSystem: jira
ticketPattern: "PE-\\d+"
ticketFetchAccess: cli
ticketFetchCommand: "acli jira workitem view {ticketId} --fields '*all' --json"
ticketTransitions:
  start: 'In Progress'
  done: 'In Review'
  feedback: 'In Progress'
ticketTransitionAccess: cli
ticketTransitionCommand: 'acli jira workitem transition {ticketId} "{status}"'
coderabbit: false
prereviewEnabled: false
reReviewComment: '@claude please review the changes and approve if possible'
reviewComment: null
---

- Jira tickets (PE-XXXX), fetched via `acli` CLI
- Base branch is `master`
- No CodeRabbit, no local prereview
- Ticket transitions via `acli jira workitem transition`
