---
name: baton-reasoning
description: Use when a technical decision, trade-off, rejected alternative, architecture rationale, or design risk should be recorded or recovered.
---

# Baton Reasoning

Use reasoning memory for why a decision was made. Use ordinary memory for what happened.

## Tool Router

| Situation | Prefer | CLI fallback |
|---|---|---|
| Store why a decision was made | `baton_store_reasoning` | `baton reasoning store --entity <name> --decision "<decision>" --rationale "<why>"` |
| Find earlier rationale | `baton_search_reasoning` | `baton reasoning search --query "<topic>"` |
| Need a stable evolving topic key | `baton_suggest_topic_key` | `baton memory suggest-topic-key --type decision --title "<title>"` |
| Link rationale to commit evidence | `relatedCommits` on reasoning store | `baton reasoning store ... --relatedCommits <sha>` |

## Use Reasoning When

- The answer depends on alternatives considered, constraints, expected outcomes, or accepted risks.
- A future agent may otherwise reopen the same debate.
- The user chose a direction and the reason matters more than the implementation details.
- A Git Memory entry says what changed, but not why it changed.

## Do Not Use Reasoning For

- Simple progress notes.
- Mechanical refactors with no decision.
- Facts that belong in `baton_store` as `how-it-works`, `what-changed`, or `problem-solution`.
