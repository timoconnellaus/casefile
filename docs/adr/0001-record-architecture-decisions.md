# 1. Record architecture decisions

Date: 2026-10-07
Status: Accepted

## Context

casefile handles sensitive family-law material and has to stand up to questions about how AI was
used (FCFCOA PD-AI para 4.11). The reasons behind design choices need to survive beyond one
conversation.

## Decision

We record significant decisions as numbered Architecture Decision Records in `docs/adr/`, using
the Nygard format (Context, Decision, Consequences). A superseded ADR is kept and marked
"Superseded by N".

## Consequences

New decisions that change the safety boundary, data formats or user-facing compliance behaviour
need an ADR in the same change.
