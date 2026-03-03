---
org: atomicloud
baseBranch: main
ticketSystem: clickup
ticketPattern: 'CU-[a-zA-Z0-9-]+'
ticketFetchAccess: mcp
ticketFetchCommand: clickup_get_task
ticketTransitions:
  start: 'in progress'
  done: 'review'
  feedback: 'in progress'
ticketTransitionAccess: mcp
ticketTransitionCommand: clickup_update_task
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

- ClickUp tickets (CU-XXXXX), fetched via MCP `clickup_get_task`
- CodeRabbit active, local prereview before every push
- Ticket transitions via MCP `clickup_update_task`
