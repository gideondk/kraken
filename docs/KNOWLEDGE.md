# Knowledge pane — the bridge renders domain artifacts

Status: design agreed 2026-07-06, not built. Third pane of the bridge:
work (runs/campaigns) · conversation (channel) · knowledge (this).

## Thesis

Skills produce knowledge (event storms, domain models, specs), fleets produce
code, the channel produces intent — the bridge is where a human reads,
questions, and approves all three. The bridge renders artifacts; it never
owns the methodology. No workshop canvas, no live persona theater.

## v1 — reader

- Per-project "Knowledge" view listing docs/domain/, docs/specs/,
  .planning/storm-*/ (configurable roots in kraken.toml).
- Markdown rendered with the existing Prose machinery; selection-annotation
  works document-level (infrastructure already generic) → a comment on a
  spec becomes a fix-forward contract on the doc.

## v2 — event model renderer (the flagship)

Event modeling (eventmodeling.org) is a formal grammar, so it renders from
data, not drawings:

- Modelling skills emit `docs/domain/model.yaml` alongside markdown:
  actors, swimlanes (contexts/systems), timeline slices; stickies typed
  command | event | view | external, with links (ui→command→event→view).
- Bridge renders the standard notation as SVG (timeline left→right, lanes,
  blue commands / orange events / green views), reusing the Pipeline
  component's SVG approach. Click a sticky → details; select → annotate →
  fix-forward on the model. Model versions flow through the merge train
  like any artifact — gated, judged, reviewed.

## Boundary

If it edits the model interactively, it belongs in a skill/run, not the
bridge. The bridge shows what the last run produced and routes feedback
into the next one.
