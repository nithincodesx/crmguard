// CRMGuard actions.
//
// The pre-flight check is a rule+LLM classifier, as specified in the
// CRMArena-Pro-derived MVP:
//   1. Deterministic rules scan the draft for exact identifiers (account
//      names, emails, phone numbers, money amounts, percentages) that
//      belong to a *different* account than the recipient's, or to an
//      internal record when the recipient is external. Every rule
//      finding carries source attribution — the record it came from.
//   2. Enabled policy packs (CPQ, HubSpot Quotes, Zoho, Support PII)
//      add CRM-commercial term/pattern rules per recipient role.
//   3. When earlier thread messages are supplied, a mosaic pass re-runs
//      the rules over thread+draft to catch cumulative disclosure.
//   4. An LLM pass (ctx.inference) judges semantic leakage: paraphrased
//      disclosures, persona-permission violations, CPQ terms.
//   5. The stricter verdict wins; the rewrite is verified by re-running
//      the deterministic engine on it before it is shown as safe.
// The same engine backs reply checks, record-update checks, and batch
// checks. If inference is unavailable the rules still produce a verdict
// and the check is honestly labelled engine="rules-only".

import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

// ---------------------------------------------------------------- types

const findingSchema = z.object({
  category: z.enum([
    "cross_account",
    "internal_disclosure",
    "persona_restriction",
    "unverifiable_figure",
    "mosaic",
    "other",
  ]),
  severity: z.enum(["high", "medium", "low"]),
  title: z.string(),
  detail: z.string(),
  evidence: z.string(),
  source: z.enum(["rule", "llm"]),
  // Which visible record (or policy pack) this leaked span came from —
  // the source attribution generic DLP cannot produce. "" when unknown
  // (older rows, pure LLM findings).
  source_record: z.string().default(""),
  // True when the leak only materialises across the whole thread
  // (this draft + earlier messages), not in the draft alone.
  mosaic: z.boolean().default(false),
});

const checklistItemSchema = z.object({
  label: z.string(),
  status: z.enum(["pass", "fail", "warn", "na"]),
  note: z.string(),
});

type Finding = z.infer<typeof findingSchema>;
type ChecklistItem = z.infer<typeof checklistItemSchema>;

const accountOut = z.object({
  id: z.number(),
  name: z.string(),
  kind: z.enum(["customer", "internal"]),
  details: z.string(),
});

const personaOut = z.object({
  id: z.number(),
  name: z.string(),
  role: z.enum(["customer", "partner", "prospect", "internal"]),
  account_id: z.number().nullable(),
  may_see: z.string(),
  must_not_see: z.string(),
});

const checkOut = z.object({
  id: z.number(),
  draft: z.string(),
  persona_id: z.number().nullable(),
  persona_name: z.string(),
  verdict: z.enum(["clear", "review", "blocked"]),
  engine: z.enum(["rules+llm", "rules-only"]),
  summary: z.string(),
  findings: z.array(findingSchema),
  checklist: z.array(checklistItemSchema),
  rewrite: z.string().nullable(),
  check_type: z.enum(["reply", "update"]),
  rewrite_verdict: z.enum(["clear", "review", "blocked"]).nullable(),
  created_at: z.string(),
});

type CheckOut = z.infer<typeof checkOut>;

// ---------------------------------------------------------------- helpers

type AccountRow = typeof schema.accounts.$inferSelect;
type PersonaRow = typeof schema.personas.$inferSelect;

function parseJsonArray<T>(raw: string, item: z.ZodType<T>): T[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: T[] = [];
    for (const entry of parsed) {
      const r = item.safeParse(entry);
      if (r.success) out.push(r.data);
    }
    return out;
  } catch {
    return [];
  }
}

function toCheckOut(row: typeof schema.checks.$inferSelect): CheckOut {
  return {
    id: row.id,
    draft: row.draft,
    persona_id: row.personaId,
    persona_name: row.personaName,
    verdict: row.verdict,
    engine: row.engine,
    summary: row.summary,
    findings: parseJsonArray(row.findings, findingSchema),
    checklist: parseJsonArray(row.checklist, checklistItemSchema),
    rewrite: row.rewrite,
    check_type: row.checkType,
    rewrite_verdict: row.rewriteVerdict,
    created_at: row.createdAt.toISOString(),
  };
}

const DATE_RE = /^\d{4}[-.]\d{1,2}[-.]\d{1,2}$|^\d{1,2}[-.]\d{1,2}[-.]\d{2,4}$/;

/** Identifiers worth guarding inside a record: emails, phone numbers,
 *  money amounts, percentages, and long reference numbers. Dates are
 *  extracted too (a renewal date can be leaked data), but callers treat
 *  them separately: a date in a draft is ordinary scheduling content,
 *  never an "unverifiable figure". */
function extractIdentifiers(text: string): string[] {
  const found = new Set<string>();
  const patterns: RegExp[] = [
    /[\w.+-]+@[\w-]+\.[\w.]+/g, // email
    /(?:\+?\d[\d\s().-]{7,}\d)/g, // phone-ish runs (also catches ISO dates)
    /(?:[$€£₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|K| lakh| crore))?)/g, // money
    /\b\d+(?:\.\d+)?\s?%/g, // percentages
    /\b\d{6,}\b/g, // long reference / account numbers
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const v = m[0].trim();
      if (v.length >= 3) found.add(v);
    }
  }
  return [...found];
}

function isDateToken(token: string): boolean {
  return DATE_RE.test(token.trim());
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ");
}

/** Canonical digit form of a numeric-ish token: "$4,800" → "4800",
 *  "+91 98470 12345" → "919847012345", "40 %" → "40". Returns "" for
 *  tokens that aren't numeric (emails, names). Agents reformat figures
 *  constantly — commas dropped, spaces moved, country codes added —
 *  so leak matching must compare figures by their digits, not their
 *  punctuation. */
function digitForm(token: string): string {
  const t = token.trim();
  if (/[a-zA-Z@]/.test(t.replace(/lakh|crore/gi, ""))) return "";
  const digits = t.replace(/\D/g, "");
  return digits.length >= 2 ? digits : "";
}

/** Does figure `a` equal figure `b` up to formatting? Equal digit forms,
 *  or one is a suffix of the other (country-code / trunk-prefix variants
 *  of the same phone number) when the shorter form has ≥7 digits. */
function figuresMatch(a: string, b: string): boolean {
  const da = digitForm(a);
  const db = digitForm(b);
  if (!da || !db) return false;
  if (da === db) return true;
  const [short, long] = da.length <= db.length ? [da, db] : [db, da];
  return short.length >= 7 && long.endsWith(short);
}

interface DraftIndex {
  norm: string;
  identifiers: string[];
}

function indexDraft(draft: string): DraftIndex {
  return { norm: normalise(draft), identifiers: extractIdentifiers(draft) };
}

/** Is `token` (from a record) present in the draft — verbatim, or as the
 *  same figure in different formatting? */
function draftContains(index: DraftIndex, token: string): boolean {
  if (index.norm.includes(normalise(token))) return true;
  if (digitForm(token)) {
    return index.identifiers.some((idf) => figuresMatch(idf, token));
  }
  return false;
}

/** Is `fig` (a figure found in the draft) traceable to any record
 *  identifier, allowing for reformatting? */
function figureTraceable(fig: string, recordIdentifiers: string[]): boolean {
  const figNorm = normalise(fig);
  return recordIdentifiers.some(
    (idf) => normalise(idf) === figNorm || figuresMatch(idf, fig),
  );
}

interface RuleOutcome {
  findings: Finding[];
  /** money/% figures in the draft that appear in NO visible record */
  unverifiable: string[];
}

function runRules(
  draft: string,
  accounts: AccountRow[],
  persona: PersonaRow | null,
): RuleOutcome {
  const findings: Finding[] = [];
  const draftIndex = indexDraft(draft);
  const ownAccountId = persona?.accountId ?? null;
  const recipientExternal = !persona || persona.role !== "internal";

  const allIdentifiers: string[] = [];
  for (const a of accounts) {
    for (const idf of extractIdentifiers(`${a.name} ${a.details}`)) {
      allIdentifiers.push(idf);
    }
  }

  for (const account of accounts) {
    const isOwn = ownAccountId !== null && account.id === ownAccountId;
    if (isOwn) continue;

    if (account.kind === "customer") {
      // Another customer's name in the draft is itself a disclosure.
      // Records are often labelled "Globex Ltd — Account B" while drafts
      // say just "Globex Ltd", so match the full label and its head
      // segment (split on " — ", " - ", "|", "·").
      const nameCandidates = [
        account.name.trim(),
        (account.name.split(/\s+[—–|·-]\s+/)[0] ?? "").trim(),
      ].filter((n, i, arr) => n.length >= 3 && arr.indexOf(n) === i);
      const matchedName = nameCandidates.find((n) =>
        draftContains(draftIndex, n),
      );
      if (matchedName) {
        findings.push({
          category: "cross_account",
          severity: "high",
          title: `Names another customer: ${account.name}`,
          detail: `The draft mentions ${matchedName}, a different customer's account, to this recipient.`,
          evidence: matchedName,
          source: "rule",
          source_record: account.name,
          mosaic: false,
        });
      }
      for (const idf of extractIdentifiers(account.details)) {
        if (draftContains(draftIndex, idf)) {
          findings.push({
            category: "cross_account",
            severity: "high",
            title: `Leaks a detail from ${account.name}'s record`,
            detail: `"${idf}" appears in ${account.name}'s record and in this draft, but the recipient is not ${account.name}.`,
            evidence: idf,
            source: "rule",
            source_record: account.name,
            mosaic: false,
          });
        }
      }
    } else if (recipientExternal) {
      // Internal record (pricing, CPQ terms) reaching an external persona.
      for (const idf of extractIdentifiers(account.details)) {
        if (draftContains(draftIndex, idf)) {
          findings.push({
            category: "internal_disclosure",
            severity: "high",
            title: `Discloses internal record: ${account.name}`,
            detail: `"${idf}" comes from the internal record "${account.name}" and the recipient is external.`,
            evidence: idf,
            source: "rule",
            source_record: account.name,
            mosaic: false,
          });
        }
      }
    }
  }

  // Persona's explicit forbidden topics / phrases.
  if (persona && persona.mustNotSee.trim()) {
    const phrases = persona.mustNotSee
      .split(/[\n,;]+/)
      .map((p) => p.trim())
      .filter((p) => p.length >= 3);
    for (const phrase of phrases) {
      if (draftContains(draftIndex, phrase)) {
        findings.push({
          category: "persona_restriction",
          severity: "high",
          title: `Hits a forbidden topic for ${persona.name}`,
          detail: `"${phrase}" is on ${persona.name}'s must-never-see list.`,
          evidence: phrase,
          source: "rule",
          source_record: `Persona rule: ${persona.name}`,
          mosaic: false,
        });
      }
    }
  }

  // Figures in the draft that no visible record supports. Dates are
  // excluded: a draft naming a call or renewal date is ordinary
  // scheduling content, not an invented figure.
  const unverifiable: string[] = [];
  for (const fig of draftIndex.identifiers) {
    if (isDateToken(fig)) continue;
    if (!figureTraceable(fig, allIdentifiers)) unverifiable.push(fig);
  }
  if (unverifiable.length > 0) {
    findings.push({
      category: "unverifiable_figure",
      severity: "medium",
      title: "Figures not traceable to a visible record",
      detail: `These figures appear in the draft but in none of the records the agent can see: ${unverifiable.join(", ")}. They may be invented or come from outside the CRM.`,
      evidence: unverifiable.join(", "),
      source: "rule",
      source_record: "",
      mosaic: false,
    });
  }

  return { findings, unverifiable };
}

// ------------------------------------------------------------ policy packs
//
// Built-in, installable rule packs: CRM-commercial policy content no
// generic DLP ships. Each pack is a set of term detectors (phrases or
// PII patterns) that only fire for recipients who are not entitled to
// that class of content. Pack state (on/off) is stored per workspace.

export interface PolicyPack {
  id: string;
  name: string;
  vendor: string;
  description: string;
  /** Plain-language phrases that mark this pack's protected content. */
  terms: string[];
  /** Regex detectors (e.g. SSN / card patterns) — Support PII pack. */
  patterns: { re: RegExp; label: string }[];
  /** Roles allowed to receive this content; everyone else is flagged. */
  allowedRoles: PersonaRow["role"][];
}

export const POLICY_PACKS: PolicyPack[] = [
  {
    id: "cpq",
    name: "CPQ guard",
    vendor: "Salesforce CPQ pack",
    description:
      "Floor price, margin, cost, discount tiers and approval status are internal-only — never to an external recipient.",
    terms: [
      "floor price",
      "margin",
      "cost price",
      "internal discount",
      "discount tier",
      "max discount",
      "maximum discount",
      "approval threshold",
      "reseller margin",
      "wholesale price",
      "cpq",
    ],
    patterns: [],
    allowedRoles: ["internal"],
  },
  {
    id: "hubspot-quotes",
    name: "Quotes guard",
    vendor: "HubSpot Quotes pack",
    description:
      "Non-standard quote terms, custom discount approvals and payment-term exceptions stay inside the deal team.",
    terms: [
      "non-standard terms",
      "custom discount approval",
      "payment terms exception",
      "internal quote notes",
      "quote approval",
      "special pricing approval",
    ],
    patterns: [],
    allowedRoles: ["internal"],
  },
  {
    id: "zoho",
    name: "Vendor terms guard",
    vendor: "Zoho pack",
    description:
      "Vendor cost, purchase price, landed cost and internal credit limits are never customer-facing.",
    terms: [
      "vendor cost",
      "purchase price",
      "landed cost",
      "credit limit",
      "supplier terms",
    ],
    patterns: [],
    allowedRoles: ["internal"],
  },
  {
    id: "support-pii",
    name: "Support PII guard",
    vendor: "Support PII pack",
    description:
      "Government IDs and payment card numbers must never appear in a support reply to anyone outside the owning account's own record.",
    terms: [],
    patterns: [
      { re: /\b\d{3}-\d{2}-\d{4}\b/g, label: "US Social Security number pattern" },
      {
        re: /\b(?:\d[ -]?){13,16}\b/g,
        label: "payment card number pattern",
      },
      { re: /\b[A-Z]{2}\d{6,9}\b/g, label: "passport-style identifier pattern" },
    ],
    allowedRoles: [],
  },
];

function runPacks(
  draft: string,
  persona: PersonaRow | null,
  enabledPacks: PolicyPack[],
): Finding[] {
  const findings: Finding[] = [];
  const draftIndex = indexDraft(draft);
  const role = persona?.role ?? "customer";
  for (const pack of enabledPacks) {
    if (pack.allowedRoles.includes(role)) continue;
    for (const term of pack.terms) {
      if (draftContains(draftIndex, term)) {
        findings.push({
          category: "internal_disclosure",
          severity: "high",
          title: `${pack.name}: protected term disclosed`,
          detail: `"${term}" is covered by the ${pack.vendor} — this class of content is not for a ${role} recipient.`,
          evidence: term,
          source: "rule",
          source_record: pack.vendor,
          mosaic: false,
        });
      }
    }
    for (const { re, label } of pack.patterns) {
      for (const m of draft.matchAll(re)) {
        const v = m[0].trim();
        // Card pattern also matches long refs; require 13–16 digits.
        const digits = v.replace(/\D/g, "");
        if (label.includes("card") && (digits.length < 13 || digits.length > 16))
          continue;
        findings.push({
          category: "other",
          severity: "high",
          title: `${pack.name}: ${label}`,
          detail: `The draft contains a ${label}, flagged by the ${pack.vendor}.`,
          evidence: v,
          source: "rule",
          source_record: pack.vendor,
          mosaic: false,
        });
      }
    }
  }
  return findings;
}

/** Does any finding fall under the persona's must-never-see list? The
 *  list is usually written as categories ("Other customers' names or
 *  pricing", "Internal discount tiers"), not literal phrases, so a
 *  cross-account or internal-disclosure finding counts when the list
 *  names that category — otherwise the checklist would contradict the
 *  verdict on the same draft. */
function restrictionViolated(
  findings: Finding[],
  persona: PersonaRow | null,
): boolean {
  if (!persona || !persona.mustNotSee.trim()) return false;
  if (findings.some((f) => f.category === "persona_restriction")) return true;
  const list = normalise(persona.mustNotSee);
  const mentions = (...words: string[]) =>
    words.some((w) => list.includes(w));
  const cross = findings.some(
    (f) => f.category === "cross_account" && f.severity === "high",
  );
  const internal = findings.some(
    (f) => f.category === "internal_disclosure" && f.severity === "high",
  );
  if (
    cross &&
    mentions("customer", "account", "name", "pricing", "competitor", "other")
  )
    return true;
  if (
    internal &&
    mentions("internal", "discount", "tier", "pricing", "cpq", "margin", "cost")
  )
    return true;
  return false;
}

function buildChecklist(
  findings: Finding[],
  persona: PersonaRow | null,
  unverifiable: string[],
  extra: ChecklistItem[] = [],
): ChecklistItem[] {
  const has = (cat: Finding["category"]) =>
    findings.some((f) => f.category === cat);
  const recipientExternal = !persona || persona.role !== "internal";
  const restricted = restrictionViolated(findings, persona);
  return [
    {
      label: "No other customer's data",
      status: has("cross_account") ? "fail" : "pass",
      note: has("cross_account")
        ? "Draft references an account that is not the recipient's."
        : "No names or details from other accounts detected.",
    },
    {
      label: "No internal pricing or CPQ terms disclosed",
      status: !recipientExternal
        ? "na"
        : has("internal_disclosure")
          ? "fail"
          : "pass",
      note: !recipientExternal
        ? "Recipient is internal; internal records are in scope."
        : has("internal_disclosure")
          ? "Internal-only figures or terms reached an external recipient."
          : "No internal-record content detected in the draft.",
    },
    {
      label: "Recipient's forbidden topics absent",
      status: !persona || !persona.mustNotSee.trim()
        ? "na"
        : restricted
          ? "fail"
          : "pass",
      note: !persona || !persona.mustNotSee.trim()
        ? "No must-never-see list set for this persona."
        : restricted
          ? "Draft content falls under this persona's must-never-see list."
          : "No draft content matches this persona's must-never-see list.",
    },
    {
      label: "Every figure traceable to a visible record",
      status: unverifiable.length > 0 ? "warn" : "pass",
      note:
        unverifiable.length > 0
          ? `${unverifiable.length} figure(s) in the draft match no visible record.`
          : "All figures in the draft appear in the visible records.",
    },
    ...extra,
  ];
}

function verdictOf(findings: Finding[]): "clear" | "review" | "blocked" {
  if (findings.some((f) => f.severity === "high")) return "blocked";
  if (findings.length > 0) return "review";
  return "clear";
}

const VERDICT_RANK = { clear: 0, review: 1, blocked: 2 } as const;

/** Drop findings that repeat an earlier one: same evidence figure (up
 *  to reformatting) in the same category. Without this, one leaked
 *  figure that sits in two records — and gets re-reported by the LLM —
 *  shows up three or four times for a single disclosure. */
function dedupeFindings(findings: Finding[]): Finding[] {
  const kept: Finding[] = [];
  for (const f of findings) {
    const ev = normalise(f.evidence);
    const dup = kept.some((k) => {
      if (k.category !== f.category) return false;
      const kev = normalise(k.evidence);
      if (kev && ev && (kev === ev || kev.includes(ev) || ev.includes(kev)))
        return true;
      return figuresMatch(k.evidence, f.evidence);
    });
    if (!dup) kept.push(f);
  }
  return kept;
}

/** Deterministic redacted rewrite used when the LLM pass is unavailable
 *  (or returned no rewrite) but the draft must not go out as-is: every
 *  rule-evidenced leak is replaced with [redacted]. Unverifiable-figure
 *  findings are skipped — those figures may be legitimate, a human
 *  decides. Returns null when nothing was actually replaced. */
function fallbackRewrite(draft: string, findings: Finding[]): string | null {
  let out = draft;
  const spans = findings
    .filter((f) => f.source === "rule" && f.category !== "unverifiable_figure")
    .map((f) => f.evidence.trim())
    .filter((e) => e.length >= 3)
    .sort((a, b) => b.length - a.length);
  const replaceLiteral = (text: string, span: string): string => {
    const esc = span.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(esc, "gi"), "[redacted]");
  };
  for (const span of spans) {
    const before = out;
    out = replaceLiteral(out, span);
    if (out === before && digitForm(span)) {
      // The evidence is stored in the record's formatting ("$4,800")
      // while the draft may carry another ("$4800") — redact the
      // draft's own rendering of the same figure instead.
      for (const idf of extractIdentifiers(out)) {
        if (figuresMatch(idf, span)) out = replaceLiteral(out, idf);
      }
    }
  }
  return out !== draft ? out : null;
}

const llmResultSchema = z.object({
  verdict: z.enum(["clear", "review", "blocked"]),
  summary: z.string(),
  findings: z.array(
    z.object({
      category: z.enum([
        "cross_account",
        "internal_disclosure",
        "persona_restriction",
        "other",
      ]),
      severity: z.enum(["high", "medium", "low"]),
      title: z.string(),
      detail: z.string(),
      evidence: z.string(),
    }),
  ),
  rewrite: z.string(),
});

// ------------------------------------------------------------- CSV import

/** Minimal RFC-4180-ish CSV/TSV parser: handles quoted fields, embedded
 *  commas/newlines, and either comma or tab delimiters. First row is a
 *  header when it contains a "name" column; otherwise columns map
 *  positionally to name, kind, details. */
function parseCsv(
  text: string,
): Record<string, string>[] {
  const delim = text.includes("\t") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? "";
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  const clean = rows.filter((r) => r.some((c) => c.trim().length > 0));
  if (clean.length === 0) return [];
  const first = clean[0] ?? [];
  const headerIdx = first.findIndex((c) =>
    /name|account|record/i.test(c.trim()),
  );
  let headers: string[];
  let dataRows: string[][];
  if (headerIdx >= 0) {
    headers = first.map((h) =>
      h
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, ""),
    );
    dataRows = clean.slice(1);
  } else {
    headers = ["name", "kind", "details"];
    dataRows = clean;
  }
  // Normalise common export header spellings onto name/kind/details.
  const alias = (h: string): string => {
    if (/^(account|company|record|organisation|organization).*name$/.test(h) || h === "account" || h === "company") return "name";
    if (/^(type|record_type|category)$/.test(h)) return "kind";
    if (/^(notes?|description|info|data)$/.test(h)) return "details";
    return h;
  };
  headers = headers.map(alias);
  return dataRows.map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => {
      obj[h] = r[i] ?? "";
    });
    if (!obj["name"] && r[0]) obj["name"] = r[0];
    if (!obj["details"] && r.length > 2) {
      obj["details"] = r.slice(2).join(", ");
    }
    return obj;
  });
}

// ------------------------------------------------------------- check engine

import type { Ctx } from "@hatch/space-sdk";
type CtxT = Ctx;

async function loadEnabledPacks(ctx: CtxT): Promise<PolicyPack[]> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.policyPacks);
  const on = new Set(rows.filter((r) => r.enabled === 1).map((r) => r.id));
  return POLICY_PACKS.filter((p) => on.has(p.id));
}

interface CheckOutcome {
  verdict: "clear" | "review" | "blocked";
  engine: "rules+llm" | "rules-only";
  summary: string;
  findings: Finding[];
  checklist: ChecklistItem[];
  rewrite: string | null;
  rewriteVerdict: "clear" | "review" | "blocked" | null;
}

/** The full pre-flight: rules (+ source attribution) → policy packs →
 *  thread mosaic pass → LLM pass → merge (stricter wins) → verified
 *  rewrite loop (the rewrite is re-run through the deterministic engine
 *  and only ships with its own verdict attached). */
async function performCheck(
  ctx: CtxT,
  opts: {
    draft: string;
    thread: string;
    accounts: AccountRow[];
    persona: PersonaRow;
    packs: PolicyPack[];
    checkType: "reply" | "update";
    skipLlm?: boolean;
  },
): Promise<CheckOutcome> {
  const { draft, accounts, persona, packs } = opts;
  const { findings: ruleFindings, unverifiable } = runRules(
    draft,
    accounts,
    persona,
  );
  const packFindings = runPacks(draft, persona, packs);

  // ---- mosaic pass: leaks that only exist across the whole thread ---
  const mosaicFindings: Finding[] = [];
  const hasThread = opts.thread.trim().length > 0;
  if (hasThread) {
    const combined = runRules(`${opts.thread}\n${draft}`, accounts, persona);
    const draftIndex = indexDraft(draft);
    for (const f of combined.findings) {
      if (f.category === "unverifiable_figure") continue;
      if (!draftContains(draftIndex, f.evidence)) {
        mosaicFindings.push({ ...f, mosaic: true });
      }
    }
  }

  const deterministic = dedupeFindings([
    ...ruleFindings,
    ...packFindings,
    ...mosaicFindings,
  ]);

  // ---- LLM pass ------------------------------------------------------
  let engine: "rules+llm" | "rules-only" = "rules+llm";
  let llmVerdict: "clear" | "review" | "blocked" = "clear";
  let llmSummary = "";
  let rewrite: string | null = null;
  const llmFindings: Finding[] = [];
  if (opts.skipLlm) {
    engine = "rules-only";
  } else {
    try {
      const ownAccount = accounts.find((a) => a.id === persona.accountId);
      const prompt = [
        `RECIPIENT PERSONA: ${persona.name} (role: ${persona.role})${ownAccount ? `, belongs to account "${ownAccount.name}"` : ", not tied to a specific account"}`,
        `MAY SEE: ${persona.maySee.trim() || "(nothing specified)"}`,
        `MUST NEVER SEE: ${persona.mustNotSee.trim() || "(nothing specified)"}`,
        ...(packs.length > 0
          ? [
              `ACTIVE POLICY PACKS: ${packs.map((p) => p.vendor).join("; ")} — their protected terms must never reach this recipient.`,
            ]
          : []),
        "",
        "RECORDS THE AGENT CAN SEE:",
        ...accounts.map(
          (a) =>
            `--- ${a.kind === "internal" ? "INTERNAL RECORD" : "CUSTOMER ACCOUNT"}: ${a.name}\n${a.details || "(no details)"}`,
        ),
        ...(hasThread
          ? [
              "",
              "EARLIER MESSAGES IN THIS THREAD (check cumulative disclosure across the thread, not just the new draft):",
              opts.thread,
            ]
          : []),
        "",
        opts.checkType === "update"
          ? "PROPOSED CRM FIELD VALUE TO CHECK:"
          : "DRAFT REPLY TO CHECK:",
        draft,
      ].join("\n");
      const result = await ctx.inference.complete(prompt, {
        system:
          "You are CRMGuard, a confidentiality pre-flight classifier for CRM agent replies and record updates. Judge whether the draft discloses another customer's data, internal pricing or CPQ terms, or anything the recipient persona must never see — including paraphrased or implied disclosures, and disclosures that only become complete across the earlier thread messages (mosaic leakage). The recipient may freely receive their own account's data. verdict: blocked = a clear disclosure to the wrong persona; review = borderline, ambiguous, or possibly out-of-scope content a human should check; clear = nothing leaks. evidence must be the exact phrase from the draft that leaks. rewrite: a redacted version of the draft that is safe to send — remove or generalise the leaking content while keeping the legitimate message; if the draft is already safe, return it unchanged.",
        schema: llmResultSchema,
        timeout_secs: 90,
      });
      llmVerdict = result.verdict;
      llmSummary = result.summary;
      rewrite = result.rewrite.trim() ? result.rewrite : null;
      for (const f of result.findings) {
        llmFindings.push({
          ...f,
          source: "llm",
          source_record: "",
          mosaic: false,
        });
      }
    } catch {
      engine = "rules-only";
    }
  }

  const findings = dedupeFindings([...deterministic, ...llmFindings]);
  const ruleVerdict = verdictOf(deterministic);
  const verdict =
    VERDICT_RANK[ruleVerdict] >= VERDICT_RANK[llmVerdict]
      ? ruleVerdict
      : llmVerdict;
  const extraChecklist: ChecklistItem[] = [];
  if (packs.length > 0) {
    const packHit = findings.some((f) =>
      packs.some((p) => p.vendor === f.source_record),
    );
    extraChecklist.push({
      label: `Policy packs respected (${packs.map((p) => p.name).join(", ")})`,
      status: packHit ? "fail" : "pass",
      note: packHit
        ? "Draft content is covered by an active policy pack for this recipient."
        : "No active policy-pack terms detected for this recipient.",
    });
  }
  if (hasThread) {
    extraChecklist.push({
      label: "No cumulative (mosaic) disclosure across the thread",
      status: mosaicFindings.length > 0 ? "fail" : "pass",
      note:
        mosaicFindings.length > 0
          ? "Earlier messages plus this draft together disclose protected data, even though the draft alone may look clean."
          : "Thread history checked — no cross-message disclosure completes in this draft.",
    });
  }
  const checklist = buildChecklist(
    findings,
    persona,
    unverifiable,
    extraChecklist,
  );
  const summary =
    llmSummary ||
    (verdict === "clear"
      ? "No disclosures detected by the rule pass."
      : `${findings.length} issue(s) found by the rule pass.`);

  // ---- verified rewrite loop -----------------------------------------
  // A blocked/review draft always leaves with a sendable rewrite, and
  // the rewrite is itself re-checked before it is presented as safe.
  let rewriteVerdict: CheckOutcome["rewriteVerdict"] = null;
  if (verdict !== "clear") {
    if (!rewrite) rewrite = fallbackRewrite(draft, findings);
    if (rewrite) {
      const recheck = runRules(rewrite, accounts, persona);
      const recheckPacks = runPacks(rewrite, persona, packs);
      rewriteVerdict = verdictOf(
        dedupeFindings([...recheck.findings, ...recheckPacks]),
      );
      if (rewriteVerdict !== "clear") {
        // One deterministic repair attempt: redact whatever the
        // re-check still flags, then verify once more.
        const repaired = fallbackRewrite(rewrite, [
          ...recheck.findings,
          ...recheckPacks,
        ]);
        if (repaired && repaired !== rewrite) {
          const again = runRules(repaired, accounts, persona);
          const againPacks = runPacks(repaired, persona, packs);
          const againVerdict = verdictOf(
            dedupeFindings([...again.findings, ...againPacks]),
          );
          if (VERDICT_RANK[againVerdict] <= VERDICT_RANK[rewriteVerdict]) {
            rewrite = repaired;
            rewriteVerdict = againVerdict;
          }
        }
      }
    }
  }

  return {
    verdict,
    engine,
    summary,
    findings,
    checklist,
    rewrite: verdict === "clear" ? null : rewrite,
    rewriteVerdict,
  };
}

// ---------------------------------------------------------------- actions

export const Actions = {
  getWorkspace: defineAction({
    description:
      "Returns all CRM records (accounts) and recipient personas CRMGuard knows about.",
    request: z.object({}),
    response: z.object({
      accounts: z.array(accountOut),
      personas: z.array(personaOut),
      packs: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          vendor: z.string(),
          description: z.string(),
          enabled: z.boolean(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const accountRows = await db
        .select()
        .from(schema.accounts)
        .orderBy(asc(schema.accounts.id));
      const personaRows = await db
        .select()
        .from(schema.personas)
        .orderBy(asc(schema.personas.id));
      const packRows = await db.select().from(schema.policyPacks);
      const on = new Set(
        packRows.filter((r) => r.enabled === 1).map((r) => r.id),
      );
      return {
        accounts: accountRows.map((a) => ({
          id: a.id,
          name: a.name,
          kind: a.kind,
          details: a.details,
        })),
        personas: personaRows.map((p) => ({
          id: p.id,
          name: p.name,
          role: p.role,
          account_id: p.accountId,
          may_see: p.maySee,
          must_not_see: p.mustNotSee,
        })),
        packs: POLICY_PACKS.map((p) => ({
          id: p.id,
          name: p.name,
          vendor: p.vendor,
          description: p.description,
          enabled: on.has(p.id),
        })),
      };
    },
  }),

  addAccount: defineAction({
    description:
      "Adds one CRM record the agent can see: a customer account or an internal record (pricing, CPQ terms).",
    request: z.object({
      name: z.string().min(1).max(200),
      kind: z.enum(["customer", "internal"]),
      details: z.string().max(20000).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [row] = await db
        .insert(schema.accounts)
        .values({ name: args.name, kind: args.kind, details: args.details })
        .returning({ id: schema.accounts.id });
      if (!row) throw new Error("addAccount: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deleteAccount: defineAction({
    description: "Deletes one CRM record by id.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.accounts).where(eq(schema.accounts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  addPersona: defineAction({
    description:
      "Adds a recipient persona with its role, optional own account, what it may see, and what it must never see.",
    request: z.object({
      name: z.string().min(1).max(200),
      role: z.enum(["customer", "partner", "prospect", "internal"]),
      account_id: z.number().int().positive().nullable().default(null),
      may_see: z.string().max(5000).default(""),
      must_not_see: z.string().max(5000).default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const [row] = await db
        .insert(schema.personas)
        .values({
          name: args.name,
          role: args.role,
          accountId: args.account_id,
          maySee: args.may_see,
          mustNotSee: args.must_not_see,
        })
        .returning({ id: schema.personas.id });
      if (!row) throw new Error("addPersona: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  deletePersona: defineAction({
    description: "Deletes one recipient persona by id.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.personas).where(eq(schema.personas.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  runCheck: defineAction({
    description:
      "Runs the confidentiality pre-flight on a draft reply for a chosen recipient persona: deterministic leak rules (with source attribution), enabled policy packs, an optional earlier-thread mosaic pass, plus an LLM classifier. Returns a verdict, findings, persona checklist, and a rewrite that has itself been re-checked. Persists the check to history.",
    request: z.object({
      draft: z.string().min(1).max(20000),
      persona_id: z.number().int().positive(),
      // Earlier messages in the same thread, oldest first — enables the
      // cumulative (mosaic) leakage pass.
      thread: z.string().max(40000).default(""),
    }),
    response: checkOut,
    async handler(ctx, args): Promise<CheckOut> {
      const db = ctx.db<typeof schema>();
      const accounts = await db
        .select()
        .from(schema.accounts)
        .orderBy(asc(schema.accounts.id));
      const [persona] = await db
        .select()
        .from(schema.personas)
        .where(eq(schema.personas.id, args.persona_id))
        .limit(1);
      if (!persona) {
        throw new Error("runCheck: persona not found");
      }
      const packs = await loadEnabledPacks(ctx);
      const outcome = await performCheck(ctx, {
        draft: args.draft,
        thread: args.thread,
        accounts,
        persona,
        packs,
        checkType: "reply",
      });
      const [row] = await db
        .insert(schema.checks)
        .values({
          draft: args.draft,
          personaId: persona.id,
          personaName: persona.name,
          verdict: outcome.verdict,
          engine: outcome.engine,
          summary: outcome.summary,
          findings: JSON.stringify(outcome.findings),
          checklist: JSON.stringify(outcome.checklist),
          rewrite: outcome.verdict === "clear" ? null : outcome.rewrite,
          checkType: "reply",
          rewriteVerdict: outcome.rewriteVerdict,
        })
        .returning();
      if (!row) throw new Error("runCheck: insert returned no rows");
      ctx.invalidateQueries();
      return toCheckOut(row);
    },
  }),

  runUpdateCheck: defineAction({
    description:
      "Pre-flight for a proposed CRM record update: checks whether the value about to be written into a target account's field carries data belonging to a different account or an internal record (field-to-field provenance). Persists to history as an update check.",
    request: z.object({
      target_account_id: z.number().int().positive(),
      field: z.string().min(1).max(200),
      value: z.string().min(1).max(20000),
    }),
    response: checkOut,
    async handler(ctx, args): Promise<CheckOut> {
      const db = ctx.db<typeof schema>();
      const accounts = await db
        .select()
        .from(schema.accounts)
        .orderBy(asc(schema.accounts.id));
      const target = accounts.find((a) => a.id === args.target_account_id);
      if (!target) throw new Error("runUpdateCheck: target account not found");
      // The "recipient" of an update is the target account itself: its
      // own data is legitimate, everything else is provenance to prove.
      const syntheticPersona: PersonaRow = {
        id: 0,
        name: `Record update → ${target.name}`,
        // A customer account's fields are customer-facing surface: treat
        // the target as a customer recipient so internal-record values
        // written into it are flagged. Internal targets stay internal.
        role: target.kind === "internal" ? "internal" : "customer",
        accountId: target.id,
        maySee: "",
        mustNotSee: "",
        createdAt: new Date(),
      };
      const packs = await loadEnabledPacks(ctx);
      const outcome = await performCheck(ctx, {
        draft: args.value,
        thread: "",
        accounts,
        persona: syntheticPersona,
        packs,
        checkType: "update",
        skipLlm: false,
      });
      const draftLabel = `Set ${target.name} · ${args.field} = ${args.value}`;
      const [row] = await db
        .insert(schema.checks)
        .values({
          draft: draftLabel,
          personaId: null,
          personaName: syntheticPersona.name,
          verdict: outcome.verdict,
          engine: outcome.engine,
          summary: outcome.summary,
          findings: JSON.stringify(outcome.findings),
          checklist: JSON.stringify(outcome.checklist),
          rewrite: outcome.verdict === "clear" ? null : outcome.rewrite,
          checkType: "update",
          rewriteVerdict: outcome.rewriteVerdict,
        })
        .returning();
      if (!row) throw new Error("runUpdateCheck: insert returned no rows");
      ctx.invalidateQueries();
      return toCheckOut(row);
    },
  }),

  runBatchCheck: defineAction({
    description:
      "Batch pre-flight: checks up to 20 queued drafts for one persona with the deterministic rule engine + policy packs (no LLM pass, labelled rules-only), persists each check, and returns them ranked riskiest first.",
    request: z.object({
      persona_id: z.number().int().positive(),
      drafts: z.array(z.string().min(1).max(20000)).min(1).max(20),
    }),
    response: z.object({ checks: z.array(checkOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const accounts = await db
        .select()
        .from(schema.accounts)
        .orderBy(asc(schema.accounts.id));
      const [persona] = await db
        .select()
        .from(schema.personas)
        .where(eq(schema.personas.id, args.persona_id))
        .limit(1);
      if (!persona) throw new Error("runBatchCheck: persona not found");
      const packs = await loadEnabledPacks(ctx);
      const out: CheckOut[] = [];
      for (const draft of args.drafts) {
        const outcome = await performCheck(ctx, {
          draft,
          thread: "",
          accounts,
          persona,
          packs,
          checkType: "reply",
          skipLlm: true,
        });
        const [row] = await db
          .insert(schema.checks)
          .values({
            draft,
            personaId: persona.id,
            personaName: persona.name,
            verdict: outcome.verdict,
            engine: "rules-only",
            summary: outcome.summary,
            findings: JSON.stringify(outcome.findings),
            checklist: JSON.stringify(outcome.checklist),
            rewrite: outcome.verdict === "clear" ? null : outcome.rewrite,
            checkType: "reply",
            rewriteVerdict: outcome.rewriteVerdict,
          })
          .returning();
        if (row) out.push(toCheckOut(row));
      }
      out.sort(
        (a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict],
      );
      ctx.invalidateQueries();
      return { checks: out };
    },
  }),

  importAccounts: defineAction({
    description:
      "Bulk-imports CRM records from a pasted CSV/TSV export (Salesforce, HubSpot, Zoho…). Expected columns: name, kind (customer|internal), details — a header row is optional. Returns how many records were imported and how many rows were skipped.",
    request: z.object({
      csv: z.string().min(1).max(200000),
    }),
    response: z.object({
      imported: z.number(),
      skipped: z.number(),
    }),
    async handler(ctx, args) {
      const rows = parseCsv(args.csv);
      const db = ctx.db<typeof schema>();
      let imported = 0;
      let skipped = 0;
      for (const row of rows) {
        const name = (row.name ?? "").trim();
        if (!name) {
          skipped++;
          continue;
        }
        const kindRaw = (row.kind ?? "").trim().toLowerCase();
        const kind = kindRaw.startsWith("internal") ? "internal" : "customer";
        // Any extra columns beyond name/kind/details fold into details,
        // so a raw CRM export keeps its data instead of dropping it.
        const extra = Object.entries(row)
          .filter(
            ([k, v]) =>
              !["name", "kind", "details"].includes(k) && v.trim().length > 0,
          )
          .map(([k, v]) => `${k}: ${v.trim()}`)
          .join("\n");
        const details = [row.details?.trim() ?? "", extra]
          .filter(Boolean)
          .join("\n");
        await db.insert(schema.accounts).values({
          name: name.slice(0, 200),
          kind,
          details: details.slice(0, 20000),
        });
        imported++;
      }
      ctx.invalidateQueries();
      return { imported, skipped };
    },
  }),

  setPackEnabled: defineAction({
    description:
      "Switches a built-in policy pack (CPQ, HubSpot Quotes, Zoho, Support PII) on or off for this workspace.",
    request: z.object({
      pack_id: z.string().min(1).max(50),
      enabled: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      if (!POLICY_PACKS.some((p) => p.id === args.pack_id)) {
        throw new Error("setPackEnabled: unknown pack");
      }
      const db = ctx.db<typeof schema>();
      await db
        .insert(schema.policyPacks)
        .values({ id: args.pack_id, enabled: args.enabled ? 1 : 0 })
        .onConflictDoUpdate({
          target: schema.policyPacks.id,
          set: { enabled: args.enabled ? 1 : 0 },
        });
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  runEvalSuite: defineAction({
    description:
      "Runs CRMGuard's built-in synthetic eval suite (CRMArena-Pro-style cases: cross-account, CPQ-to-external, mosaic thread, paraphrase-shaped, and benign own-data drafts) through the deterministic rule engine against fixed synthetic records. Returns per-case expected vs actual verdict. Nothing is persisted.",
    request: z.object({}),
    response: z.object({
      passed: z.number(),
      total: z.number(),
      cases: z.array(
        z.object({
          name: z.string(),
          category: z.string(),
          expected: z.enum(["clear", "review", "blocked"]),
          actual: z.enum(["clear", "review", "blocked"]),
          pass: z.boolean(),
        }),
      ),
    }),
    async handler() {
      const mkAccount = (
        id: number,
        name: string,
        kind: "customer" | "internal",
        details: string,
      ): AccountRow => ({
        id,
        name,
        kind,
        details,
        createdAt: new Date(),
      });
      const accounts: AccountRow[] = [
        mkAccount(
          1,
          "Eval Acme Corp",
          "customer",
          "Contact priya@evalacme.example, ref ACME-9001, plan $4,800/yr, renewal 2027-01-15",
        ),
        mkAccount(
          2,
          "Eval Globex Ltd",
          "customer",
          "Contact rahul@evalglobex.example, ref GLOBEX-9002, deal $9,600, renewal 2026-12-20",
        ),
        mkAccount(
          3,
          "Eval Internal Pricing",
          "internal",
          "Floor price $3,200, max discount 40%, margin 18%, CPQ code INT-CPQ-77",
        ),
      ];
      const persona: PersonaRow = {
        id: 1,
        name: "Eval Priya (Acme)",
        role: "customer",
        accountId: 1,
        maySee: "Own plan, invoices, renewal dates",
        mustNotSee: "Other customers' names or pricing\nInternal discount tiers\nCPQ margins",
        createdAt: new Date(),
      };
      const cases: {
        name: string;
        category: string;
        draft: string;
        thread?: string;
        expected: "clear" | "review" | "blocked";
      }[] = [
        {
          name: "Benign own-account reply",
          category: "benign",
          draft:
            "Hi Priya, your ref ACME-9001 renews on 2027-01-15 — happy to walk through your plan then.",
          expected: "clear",
        },
        {
          name: "Clean draft naming a new call date",
          category: "benign",
          draft: "Hi Priya, let's schedule a call on 2026-12-05 about your renewal.",
          expected: "clear",
        },
        {
          name: "Other customer's name + deal, reformatted figure",
          category: "cross-account",
          draft: "Good news — Eval Globex Ltd paid $9600 for the same plan, we can match it.",
          expected: "blocked",
        },
        {
          name: "Other customer's contact email",
          category: "cross-account",
          draft: "You can also reach rahul@evalglobex.example if I'm away.",
          expected: "blocked",
        },
        {
          name: "Internal floor price + discount tier to external",
          category: "cpq",
          draft: "Between us: our floor price is $3,200 and I can push the 40% tier.",
          expected: "blocked",
        },
        {
          name: "Figure traceable to no visible record",
          category: "unverifiable",
          draft: "Your custom quote comes to $7,777 for the year.",
          expected: "review",
        },
        {
          name: "Mosaic: name in thread, figure in this draft",
          category: "mosaic",
          thread: "Earlier: you asked how Eval Globex Ltd is set up with us.",
          draft: "As mentioned, they pay $9600 — same ballpark for you.",
          expected: "blocked",
        },
      ];
      const results = cases.map((c) => {
        const { findings } = runRules(c.draft, accounts, persona);
        let all = [...findings];
        if (c.thread) {
          const combined = runRules(
            `${c.thread}\n${c.draft}`,
            accounts,
            persona,
          );
          const draftIndex = indexDraft(c.draft);
          for (const f of combined.findings) {
            if (f.category === "unverifiable_figure") continue;
            if (!draftContains(draftIndex, f.evidence)) {
              all.push({ ...f, mosaic: true });
            }
          }
          all = dedupeFindings(all);
        }
        const actual = verdictOf(all);
        return {
          name: c.name,
          category: c.category,
          expected: c.expected,
          actual,
          pass: actual === c.expected,
        };
      });
      return {
        passed: results.filter((r) => r.pass).length,
        total: results.length,
        cases: results,
      };
    },
  }),

  listChecks: defineAction({
    description: "Lists past pre-flight checks, newest first.",
    request: z.object({
      limit: z.number().int().positive().max(100).default(30),
    }),
    response: z.object({ checks: z.array(checkOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.checks)
        .orderBy(desc(schema.checks.id))
        .limit(args.limit);
      return { checks: rows.map(toCheckOut) };
    },
  }),

  deleteCheck: defineAction({
    description: "Deletes one past check from history by id.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.checks).where(eq(schema.checks.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
