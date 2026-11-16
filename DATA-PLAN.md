# Data Plan

## Context provenance
- `CRMGuard ; hey shortlisted this idea ; start implementing` (verbatim build request; the user picked idea #5 from the research catalogue and asked to start building it)
- `CRMGuard — confidentiality pre-flight for CRM agents … Before a sales/service agent (human-configured AI or copilot) replies or updates Salesforce/HubSpot, check: does this disclose another customer's data, internal pricing, or CPQ terms to the wrong persona?` (research report idea #5, the accepted product definition)
- `MVP: Paste/import conversation + records the agent can see; rule+LLM classifier for cross-account leakage, persona permissions checklist, redacted rewrite suggestion.` (research report idea #5 MVP — implemented literally as the core workflow)
- `leading agents "around 58% single-turn success… dropping… to approximately 35% in multi-turn" and "near-zero inherent confidentiality awareness"` (CRMArena-Pro abstract, quoted in the report; shown in the artifact's evidence strip with its source link)
- Source paper: Salesforce AI Research — *CRMArena-Pro: Holistic Assessment of LLM Agents Across Diverse Business Scenarios and Interactions*, 2025 (arXiv:2505.18878) — https://arxiv.org/abs/2505.18878 (URL copied verbatim from the report; the only external link the artifact exposes)
- Users per report: RevOps, support QA, agencies managing client CRMs — every outbound batch / agent deployment.

## Tested sources
### ctx.inference (server-side model inference)
**Used by**: `runCheck` action — the LLM half of the rule+LLM classifier and the redacted-rewrite generator
**Test command**: `bun /opt/muse/assets/spaces/ts-runtime/dist/probe-ctx.js < /tmp/probe-inference4.ts` (schema-typed `complete(prompt, {system, schema})` call)
**Sample output**: For a draft leaking Globex Ltd's deal and an internal-only 40% discount tier to a different customer, it returned `verdict: "block"` with two findings (`cross_customer_leak`, `internal_pricing_leak`, each with a precise detail) and a clean redacted rewrite: "Good news Aisha — we've applied a discount to your account, and I can see your renewal is due."
**Processing**: Server merges LLM findings with a deterministic rule engine (exact matches of other accounts' names, emails, phone numbers, and amounts found in the records the agent can see; internal-only markers). The stricter verdict wins. Results persist to the `checks` table.
**Fix pass 2026-11-16** (user report: "current one is full bug"; diagnosed by probing the live actions on a sandbox copy): (1) figure matching is now digit-canonical — "$4,800" in a record matches "$4800" in a draft, phone country-code variants match — previously reformatted leaks were missed by rules and simultaneously misreported as "unverifiable"; (2) dates are no longer flagged as unverifiable figures — previously any clean draft naming a date absent from the records got a false Review verdict; (3) findings are deduped by evidence so one leak reported by rules + LLM (or held in two records) shows once per category instead of 3–4 times; (4) a deterministic [redacted] rewrite is generated when the LLM pass is unavailable, so a blocked draft always has a sendable rewrite; (5) client: composer persona selection and open-check selection now fall back when the selected persona/check is deleted, and the add-record/add-persona forms fully reset after save.

## 2× upgrade 2026-11-16 (competitor-check driven)
- User ask: `if something like this exist ; then pls upgrade 2x that the current one ; coz i don't want to build something already there`.
- Source: deep-research report at `~/workspace/research_notes/crmguard-competitor-check-2026-20261116-1412/report.md` (read 2026-11-16). Verdict: **partially built — still open**; no product does the full CRMGuard job. Closest five and their decisive limits are shown in the artifact's "Checked against what already exists" section, with URLs copied verbatim from the report: WaverSec MCP https://www.waversec.com/mcp (pre-send email verdicts, from $8/seat/mo per https://www.waversec.com/pricing — email-only, no CRM records/rewrite); Nightfall AI https://www.nightfall.ai/pricing (DLP into AI, amounts blank/contact sales, 7-day proof of value); Salesforce Trust Layer https://help.salesforce.com/s/articleView?id=copilot_trust.htm&language=en_US&type=5 (official, published 2026-11-13 — data masking disabled for agents; Salesforce-only); Lakera Guard https://docs.lakera.ai/docs/api/guard (generic pattern API, paid tiers not publicly priced); Galileo Protect https://docs.galileo.ai/sdk-api/protect/rules (generic PII categories for LLM-app developers). Report hedges carried into the UI: exact paid pricing for several vendors is unpublished, and a stealth/very new entrant cannot be ruled out.
- Features implemented from the report's §4 priority list: (1) source-attributed findings (`source_record` on every rule/pack finding); (2) policy packs — CPQ (Salesforce CPQ pack), HubSpot Quotes pack, Zoho pack, Support PII pack — stored on/off in `policy_packs`, applied per recipient role; (3) multi-turn mosaic pass — optional earlier-thread input, findings flagged `mosaic` when the leak only completes across thread+draft, plus a checklist item; (4) verified rewrite loop — the rewrite is re-run through rules+packs, one deterministic repair attempt is made if it still flags, and `checks.rewrite_verdict` records the proof shown in the UI; (5) record-update pre-flight (`runUpdateCheck`, `checks.check_type = 'update'`, synthetic persona = target account); (6) CSV/TSV import of CRM exports (`importAccounts`, extra columns fold into details) + batch checking (`runBatchCheck`, rules+packs, ranked riskiest first, honestly labelled rules-only); (7) built-in synthetic eval suite (`runEvalSuite`, 7 CRMArena-Pro-style cases against fixed synthetic "Eval …" records, nothing persisted) + per-check audit report download (client-generated .txt).
- Also fixed during the upgrade: the deterministic fallback rewrite now redacts the draft's own formatting of a matched figure (evidence "$4,800" vs draft "$4800"), so rules-only/batch blocked drafts no longer end up rewriteless.
- Migration 0003: `checks.check_type`, `checks.rewrite_verdict`, `policy_packs` table.

## Web-search sources
None beyond the competitor-check report above — it already answers the product questions; no further research commissioned.

## Agent-task sources
None.

## Long-term data behavior
- **Refresh policy**: None. All data is user-entered (records, personas, checks) and read live from the artifact DB on open. No external data goes stale.
- **Growth**: One row per record, persona, and check run; history list capped at the 100 most recent checks.
- **Ordering**: Checks newest-first; records and personas in creation order.
- **Time semantics**: Check timestamps are creation instants rendered viewer-local.

## Imagery
Imagery not needed: CRMGuard is a text-in/text-out compliance tool (drafts, records, findings); it has no visual subjects, and decorative imagery would weaken the control-room aesthetic.

## Rejected approaches
- **Tried**: Seeding demo accounts/records so the first screen looks full.
  **Why rejected**: The records are the user's own CRM data; invented sample customers would be presented as the user's records. The app starts empty with guided empty states instead.
- **Tried**: LLM-only classification.
  **Why rejected**: The report's MVP specifies rule+LLM; deterministic exact-match rules catch verbatim leaks (emails, amounts, account names) reliably and explainably, and keep working as an honest partial result if inference fails.
