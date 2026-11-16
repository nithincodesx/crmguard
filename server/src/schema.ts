// CRMGuard data model.
//
// accounts  — the records an AI/CRM agent can see: one row per customer
//             account or internal record (pricing sheet, CPQ terms…).
// personas  — who a draft reply is going to, and what they may / must
//             never see. A persona may belong to one account.
// checks    — one pre-flight run: the draft, the merged rule+LLM verdict,
//             findings, persona checklist, and the redacted rewrite.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const accounts = sqliteTable("accounts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  kind: text("kind", { enum: ["customer", "internal"] })
    .notNull()
    .default("customer"),
  details: text("details").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const personas = sqliteTable("personas", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  role: text("role", {
    enum: ["customer", "partner", "prospect", "internal"],
  })
    .notNull()
    .default("customer"),
  accountId: integer("account_id"),
  maySee: text("may_see").notNull().default(""),
  mustNotSee: text("must_not_see").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const checks = sqliteTable("checks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  draft: text("draft").notNull(),
  personaId: integer("persona_id"),
  personaName: text("persona_name").notNull().default(""),
  verdict: text("verdict", { enum: ["clear", "review", "blocked"] }).notNull(),
  engine: text("engine", { enum: ["rules+llm", "rules-only"] })
    .notNull()
    .default("rules+llm"),
  summary: text("summary").notNull().default(""),
  findings: text("findings").notNull().default("[]"),
  checklist: text("checklist").notNull().default("[]"),
  rewrite: text("rewrite"),
  // "reply" = an outbound draft; "update" = a proposed CRM field update.
  checkType: text("check_type", { enum: ["reply", "update"] })
    .notNull()
    .default("reply"),
  // Verdict of the re-check run on the rewrite itself (verified rewrite
  // loop). Null when there is no rewrite.
  rewriteVerdict: text("rewrite_verdict", {
    enum: ["clear", "review", "blocked"],
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// Which built-in policy packs (CPQ, HubSpot Quotes, Support PII, Zoho)
// the workspace has switched on. Pack definitions live in actions.ts;
// this table only stores the on/off state per pack id.
export const policyPacks = sqliteTable("policy_packs", {
  id: text("id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
});
