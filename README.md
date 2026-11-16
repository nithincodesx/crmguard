# CRMGuard

**Vendor-neutral confidentiality pre-flight for CRM AI agents.**

Before a sales or service agent — AI or a human using a copilot — sends a reply or updates a record in Salesforce, HubSpot or Zoho, CRMGuard checks the draft against the CRM records the agent can see and the recipient's persona, and flags:

1. **Cross-account leakage** — another customer's data (name, contact, email, phone, reference number, deal amount) disclosed to the wrong customer
2. **Internal / commercial leakage** — internal pricing, margin, floor price and CPQ terms disclosed to an external persona
3. **Other accounts' PII** — identifiers that belong to a different account than the recipient's

Every finding is **source-attributed**: it names the exact CRM record the leaked value came from. The recipient's own account data is auto-allowed — generic DLP tools can't make that distinction because they have no account graph.

## Why this exists

Salesforce AI Research's **CRMArena-Pro** benchmark (2025, [arXiv:2505.18878](https://arxiv.org/abs/2505.18878)) found leading CRM agents reach only ~58% success single-turn, dropping to ~35% multi-turn, with **near-zero inherent confidentiality awareness**.

A 2026 competitor check found the exact job still open: WaverSec does pre-send checks for email only (no CRM graph, no rewrite), Nightfall AI guards data going *into* AI rather than drafts going *out* to the wrong customer, Salesforce's Einstein Trust Layer is Salesforce-only (with data masking disabled for agents), and Lakera / Galileo are generic pattern guardrails with no CRM schema, persona or CPQ concept.

## Features (2×)

- **Pre-flight verdict** — Blocked / Review / Clear with evidence-backed findings, highlighted at the leaked span
- **Persona permissions checklist** — each recipient persona has may-see / must-never-see rules; the checklist is evaluated per draft
- **Policy packs** — Salesforce CPQ, HubSpot Quotes, Zoho vendor terms, Support PII — toggleable per workspace
- **Multi-turn mosaic checks** — paste the earlier thread; leaks that only complete across messages (name in one message, price in the next) are flagged
- **Verified rewrite loop** — a redacted rewrite is generated *and re-checked*; it is only labelled Clear if it actually passes
- **Record-update pre-flight** — check a proposed field value's provenance before it is written into an account (field-to-field copying across accounts)
- **CSV import** — bulk-import Salesforce / HubSpot / Zoho exports (`name, kind, details`) instead of typing records one by one
- **Batch check** — check up to 20 queued drafts at once, ranked riskiest first (rules-only pass, honestly labelled)
- **Built-in eval suite** — CRMArena-Pro-style synthetic cases (cross-account, CPQ, mosaic, paraphrase-shaped, benign own-data); currently **7/7 pass**
- **Audit report** — a downloadable report per check; all checks persist in history

## How it works

1. Add the records the agent can see — customer accounts and internal records (pricing, CPQ sheets) — manually or via CSV import.
2. Add recipient personas with their own account, may-see and must-never-see rules, and enable the policy packs that apply.
3. Paste a draft reply (plus the earlier thread, if any), or a proposed record update, and run the check.
4. A deterministic rule engine (digit-canonical figure matching, so a record's `$4,800` catches a draft's `$4800`) runs first, then an AI pass catches paraphrased disclosures. The stricter verdict wins.
5. If blocked, copy the verified rewrite instead of the risky draft.

## Tech

- TypeScript, React 19, Tailwind CSS 4 (client)
- Server actions with a deterministic rule engine + LLM classifier pass
- Drizzle ORM / SQLite migrations (`drizzle/`)
- Bun

```
client/   React app (src/App.tsx, src/api.ts)
server/   Actions + schema (src/actions.ts, src/schema.ts)
drizzle/  SQL migrations
```

> This repository contains the CRMGuard application source. Runtime data (the local app database and any CRM records you enter) is intentionally **not** included.

## Status

V2 (the "2×" upgrade) — verified end-to-end: leaking drafts Blocked with source attribution and verified rewrites, clean own-account drafts Clear, record-update, batch, CSV import, mosaic and eval-suite flows all exercised live.
