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
  feedback:
    - 'Testing'
    - 'Blocked'
    - 'In Progress'
ticketTransitionAccess: cli
ticketTransitionCommand: 'acli jira workitem transition --key {ticketId} --status "{status}" --yes'
coderabbit: false
prereviewEnabled: false
reReviewComment: '@claude please review the changes and approve if possible'
reviewComment: null
---

- Jira tickets (PE-XXXX), fetched via `acli` CLI
- Base branch is `master`
- No CodeRabbit, no local prereview
- Ticket transitions via `acli jira workitem transition --key {id} --status "{status}" --yes`
- Jira workflow is one-way: backward transitions require multi-step path (In Review → Testing → Blocked → In Progress)
