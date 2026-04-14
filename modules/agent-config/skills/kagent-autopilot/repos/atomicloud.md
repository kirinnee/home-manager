---
org: atomicloud
baseBranch: main
ticketSystem: clickup
ticketPattern: '[0-9a-zA-Z]{6,}'
ticketFetchAccess: cli
ticketFetchCommand: 'cup task {ticketId} --json'
ticketTransitions:
  start: 'in progress'
  done: 'review'
  feedback: 'in progress'
ticketTransitionAccess: cli
ticketTransitionCommand: 'cup update {ticketId} --status "{status}"'
coderabbit: true
prereviewEnabled: true
reReviewComment: |
  @coderabbitai I have attempted to resolve all the issues mentioned, and replied to conversations that need further discussion.

  Please:
  1. Look through each and every conversation, and resolve those that you think have been resolved (if you agree, have learnt something, please resolve it too after commenting)
  2. Perform a re-review to see if there are any other issues

  By Claude Code Kagent Autopilot
reviewComment: null
---

- ClickUp tickets, fetched via `cup task {ticketId} --json`
- CodeRabbit active, local prereview before every push
- Ticket transitions via `cup update {ticketId} --status "{status}"`
