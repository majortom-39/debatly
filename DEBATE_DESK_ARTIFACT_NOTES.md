# Debate Desk Artifact Notes

Current working definition as of 2026-05-26.

Architecture name:

**TEST 4 - Direct Ledger Debate Desk v2**

This is the active live app architecture. Older Family Merger / canonical / judge-agent paths are historical only.

## Active Schema

```text
analysis_schema_version = 6
architecture = direct_debate_desk_v2
livePipeline = direct-ledger
```

## Public Debate Desk Tabs

The live UI currently exposes four tabs:

```text
Debate Points
Claims
Clashes
Key Moments
```

No public Sources tab.

No public Inconsistency tab.

Sources and inconsistencies are internal unless they appear inside Claim cards or become Key Moments.

## Live Pipeline

Universal front half:

```text
Speechmatics realtime diarization
-> Speechmatics final-turn packaging
-> Cleaner
-> TranscriptStore
-> Stabilizer Gate
-> Side Builder
```

Direct-ledger analysis:

```text
Side Builder
-> Debate Point Builder
-> Thesis Builder
-> Claim Builder
-> Fact Checker
-> Clash Finder
-> Inconsistency Finder
-> deterministic Key Moments + Score
-> Debate Desk + Final Report
```

## Debate Points Tab

Purpose:

Show the clean ledger of side-owned debate points extracted from the side-built transcript.

A Debate Point is:

- a meaningful proposition a side advances, defends, defines, or uses to challenge the other side
- side-owned by Blue side or Red side
- backed by an exact quote and timestamp
- allowed to be factual, value-based, policy-based, definitional, or rebuttal-based

A Debate Point is not:

- filler
- a greeting
- a moderator/host setup line
- an ad/sponsor read
- a random sentence
- a question unless it contains a proposition the speaker is advancing
- a source-check card
- a clash card
- a score event

## Claims Tab

Purpose:

Show only externally source-checkable factual claims.

A Claim card must:

- come from a Debate Point
- be one checkable factual statement
- have exact speaker, side, quote, and timestamp provenance
- create one internal fact-check job

Allowed visible source statuses:

```text
checking
verified
contradicted
no clear source
cannot verify
```

Claim card content should be stable once created. The normal live update is source status changing from `checking` to a final status.

## Fact Checker

Purpose:

Internal source-checking for Claim cards.

Rules:

- Firecrawl Search is primary.
- Gemini grounding is fallback only when Firecrawl is unavailable/exhausted.
- Search queries should use the exact checkable claim plus a short context hint only when needed.
- Final statuses are locked unless manually rerun.

## Clashes Tab

Purpose:

Show direct Blue side vs Red side disagreements on the same specific proposition.

A Clash card must:

- contain both Blue side and Red side positions
- show adjacent side cards in the UI
- use exact quotes and timestamps
- never pair same-side speakers
- not pair a specific point against an unrelated broad talking point
- append later relevant quotes instead of rewriting the whole clash under the same id

Allowed plain verdict labels:

```text
Blue side answered better
Red side answered better
No clear edge
```

## Inconsistencies

Purpose:

Internal detection only. Important confirmed inconsistencies can become negative Key Moments.

An inconsistency must:

- be speaker-level or side-level
- have two supporting quotes
- have debate timestamps
- matter enough to affect debate analysis

It should not treat teammates adding detail, emphasis, or a normal clarification as a contradiction.

## Key Moments Tab

Purpose:

Show score-moving moments only.

Inputs:

- final fact-check outcomes
- resolved clash outcomes
- confirmed important inconsistencies

Score rules:

```text
verified claim = +10 for that side
contradicted claim = -10 for that side
strong rebuttal / answered better = +10 for that side
weak response / lost clash = -10 for that side when represented as a Key Moment
confirmed inconsistency = -10 for that side
```

The score timeline is based only on Key Moment dots by debate time.

## Thesis / Featured Quote

Thesis Builder runs from new Debate Points.

It updates:

- Blue side current thesis/topic
- Red side current thesis/topic
- top featured quote strip

Quote cleanup is allowed only for STT roughness and sentence-boundary smoothing. It must not change meaning.

## Persistence

Direct-ledger tables are the source of truth:

- `debate_claim_cards`
- `debate_fact_checks`
- `debate_clash_cards`
- `debate_inconsistency_cards`
- `debate_key_moment_cards`
- `debate_score_events`
- `debate_side_assignment_events`

`debate_sessions.analysis_state` stores the current direct-ledger state.

`debate_reports.analysis_state` stores the final direct-ledger state used for the report.

Old artifact/canonical tables are compatibility only and must not drive the current UI.

## Current Critical Risk

Live Speechmatics diarization is currently the main blocker.

Latest live user tests showed raw Speechmatics labels collapsing mostly to one speaker before Side Builder. Fixing this must happen before judging Side Builder, Debate Point Builder, Claim Builder, Clash Finder, or UI output quality.
