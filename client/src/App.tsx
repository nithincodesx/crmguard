import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Workspace = ApiResponse<typeof api, "getWorkspace">;
type Account = Workspace["accounts"][number];
type Persona = Workspace["personas"][number];
type Pack = Workspace["packs"][number];
type Check = ApiResponse<typeof api, "listChecks">["checks"][number];
type Finding = Check["findings"][number];
type EvalResult = ApiResponse<typeof api, "runEvalSuite">;

const VERDICT_LABEL: Record<Check["verdict"], string> = {
  blocked: "Blocked",
  review: "Review",
  clear: "Clear",
};

function verdictColor(v: Check["verdict"]): string {
  return v === "blocked"
    ? "var(--blocked)"
    : v === "review"
      ? "var(--review)"
      : "var(--clear)";
}
function verdictBg(v: Check["verdict"]): string {
  return v === "blocked"
    ? "var(--blocked-bg)"
    : v === "review"
      ? "var(--review-bg)"
      : "var(--clear-bg)";
}

function VerdictStamp({
  verdict,
  large,
}: {
  verdict: Check["verdict"];
  large?: boolean;
}) {
  return (
    <span
      className={`inline-block -rotate-2 border-[3px] font-mono font-semibold uppercase tracking-widest ${
        large ? "px-4 py-1.5 text-2xl" : "px-2 py-0.5 text-xs"
      }`}
      style={{ borderColor: verdictColor(verdict), color: verdictColor(verdict) }}
    >
      {VERDICT_LABEL[verdict]}
    </span>
  );
}

function FindingRow({ finding }: { finding: Finding }) {
  const sevColor =
    finding.severity === "high"
      ? "var(--blocked)"
      : finding.severity === "medium"
        ? "var(--review)"
        : "var(--dim)";
  return (
    <li className="border-b border-[var(--border)] py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className="font-mono text-xs font-semibold uppercase tracking-wide"
          style={{ color: sevColor }}
        >
          {finding.severity}
        </span>
        <span className="text-sm font-semibold text-[var(--text)]">
          {finding.title}
        </span>
        <span className="font-mono text-[11px] uppercase text-[var(--dim)]">
          {finding.source === "rule" ? "rule match" : "AI pass"}
        </span>
        {finding.mosaic ? (
          <span
            className="px-1.5 py-0.5 font-mono text-[11px] uppercase"
            style={{ background: "var(--review-bg)", color: "var(--review)" }}
          >
            via thread
          </span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-[var(--dim)]">{finding.detail}</p>
      {finding.source_record ? (
        <p className="mt-1 font-mono text-[11px] uppercase tracking-wide text-[var(--dim)]">
          Source: {finding.source_record}
        </p>
      ) : null}
      {finding.evidence ? (
        <p className="mt-1.5 inline-block bg-[var(--surface-alt)] px-2 py-1 font-mono text-xs text-[var(--text)]">
          “{finding.evidence}”
        </p>
      ) : null}
    </li>
  );
}

function CheckResult({ check }: { check: Check }) {
  const [copied, setCopied] = useState(false);
  return (
    <section
      aria-label="Check result"
      className="border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div
        className="flex flex-wrap items-center gap-3 px-3 py-3"
        style={{ background: verdictBg(check.verdict), borderRadius: "6px" }}
      >
        <VerdictStamp verdict={check.verdict} large />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[var(--text)]">
            {check.verdict === "blocked"
              ? "Do not send — this draft discloses protected information."
              : check.verdict === "review"
                ? "A human should review this draft before it goes out."
                : "No disclosures detected. Safe to send."}
          </p>
          <p className="text-xs text-[var(--dim)]">
            {check.check_type === "update" ? "Record update · " : "To "}
            {check.persona_name} ·{" "}
            {new Date(check.created_at).toLocaleString()} ·{" "}
            {check.engine === "rules+llm"
              ? "rule + AI check"
              : "rule check only (AI pass unavailable)"}
          </p>
        </div>
      </div>

      {check.summary ? (
        <p className="mt-3 text-sm text-[var(--text)]">{check.summary}</p>
      ) : null}

      {check.findings.length > 0 ? (
        <div className="mt-2">
          <h3 className="mt-3 font-mono text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">
            Findings ({check.findings.length})
          </h3>
          <ul>
            {check.findings.map((f, i) => (
              <FindingRow key={i} finding={f} />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="mt-4">
        <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">
          Persona permissions checklist
        </h3>
        <ul className="mt-2 space-y-1.5">
          {check.checklist.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span
                aria-hidden
                className="mt-0.5 font-mono text-xs font-bold"
                style={{
                  color:
                    item.status === "pass"
                      ? "var(--clear)"
                      : item.status === "fail"
                        ? "var(--blocked)"
                        : item.status === "warn"
                          ? "var(--review)"
                          : "var(--dim)",
                }}
              >
                {item.status === "pass"
                  ? "✓"
                  : item.status === "fail"
                    ? "✗"
                    : item.status === "warn"
                      ? "!"
                      : "–"}
              </span>
              <span className="text-[var(--text)]">
                {item.label}
                <span className="block text-xs text-[var(--dim)]">
                  {item.note}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      {check.rewrite ? (
        <div className="mt-4 border border-[var(--border)] bg-[var(--surface-alt)] p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">
              Redacted rewrite{" "}
              {check.rewrite_verdict === "clear"
                ? "— re-checked: Clear ✓ safe to send"
                : check.rewrite_verdict
                  ? `— re-checked: ${VERDICT_LABEL[check.rewrite_verdict]} — review before sending`
                  : "— safe to send"}
            </h3>
            <button
              type="button"
              className="shrink-0 px-2 py-1 font-mono text-xs font-semibold text-[var(--accent)]"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(check.rewrite ?? "");
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? "Copied ✓" : "Copy"}
            </button>
          </div>
          <p className="mt-2 whitespace-pre-wrap font-mono text-sm text-[var(--text)]">
            {check.rewrite}
          </p>
        </div>
      ) : null}

      <details className="mt-4">
        <summary className="cursor-pointer font-mono text-xs uppercase tracking-widest text-[var(--dim)]">
          Original draft
        </summary>
        <p className="mt-2 whitespace-pre-wrap font-mono text-sm text-[var(--dim)]">
          {check.draft}
        </p>
      </details>

      <button
        type="button"
        className="mt-4 border border-[var(--border)] px-3 py-1.5 font-mono text-xs font-semibold text-[var(--accent)]"
        style={{ borderRadius: "6px" }}
        onClick={() => downloadAuditReport(check)}
      >
        Download audit report (.txt)
      </button>
    </section>
  );
}

function downloadAuditReport(check: Check) {
  const lines: string[] = [
    "CRMGuard — pre-flight audit report",
    `When: ${new Date(check.created_at).toLocaleString()}`,
    `Type: ${check.check_type === "update" ? "Record update" : "Outbound reply"}`,
    `Recipient / target: ${check.persona_name}`,
    `Verdict: ${VERDICT_LABEL[check.verdict]}`,
    `Engine: ${check.engine === "rules+llm" ? "rule + AI check" : "rule check only"}`,
    "",
    "Summary",
    check.summary || "(none)",
    "",
    `Findings (${check.findings.length})`,
    ...check.findings.map(
      (f, i) =>
        `${i + 1}. [${f.severity}] ${f.title} (${f.source === "rule" ? "rule match" : "AI pass"}${f.mosaic ? ", via thread" : ""})\n   ${f.detail}${f.evidence ? `\n   Evidence: "${f.evidence}"` : ""}${f.source_record ? `\n   Source record: ${f.source_record}` : ""}`,
    ),
    "",
    "Persona permissions checklist",
    ...check.checklist.map(
      (c) => `- [${c.status.toUpperCase()}] ${c.label} — ${c.note}`,
    ),
    "",
    "Redacted rewrite",
    check.rewrite
      ? `${check.rewrite}\nRewrite re-check verdict: ${check.rewrite_verdict ? VERDICT_LABEL[check.rewrite_verdict] : "not recorded"}`
      : "(none — draft was clear)",
    "",
    "Original draft",
    check.draft,
  ];
  const blob = new Blob([lines.join("\n")], {
    type: "text/plain;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `crmguard-audit-${check.id}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ------------------------------------------------------------- setup panels

const inputCls =
  "w-full border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--dim)]";
const labelCls =
  "block font-mono text-xs font-semibold uppercase tracking-widest text-[var(--dim)]";

function RecordsPanel({ accounts }: { accounts: Account[] }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"customer" | "internal">("customer");
  const [details, setDetails] = useState("");
  const [showForm, setShowForm] = useState(false);

  const add = useMutation({
    mutationFn: async () =>
      await api.addAccount({ name: name.trim(), kind, details }),
    onSuccess: () => {
      setName("");
      setDetails("");
      setKind("customer");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
  });
  const del = useMutation({
    mutationFn: async (id: number) => await api.deleteAccount({ id }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["workspace"] }),
  });
  const [csv, setCsv] = useState("");
  const imp = useMutation({
    mutationFn: async () => await api.importAccounts({ csv }),
    onSuccess: () => {
      setCsv("");
      queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
  });

  return (
    <section
      aria-label="Records the agent can see"
      className="border border-[var(--border)] bg-[var(--surface)] p-4"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--text)]">
          Records the agent can see
        </h2>
        <button
          type="button"
          className="font-mono text-xs font-semibold text-[var(--accent)]"
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? "Close" : "+ Add record"}
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Customer accounts and internal sheets (pricing, CPQ terms). The
        checker can only catch leaks against records it knows.
      </p>

      {accounts.length === 0 && !showForm ? (
        <p className="mt-3 bg-[var(--surface-alt)] px-3 py-2 text-sm text-[var(--dim)]">
          No records yet. Add at least one customer account and your internal
          pricing sheet to make checks meaningful.
        </p>
      ) : null}

      <ul className="mt-3 divide-y divide-[var(--border)]">
        {accounts.map((a) => (
          <li key={a.id} className="flex items-start justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text)]">
                {a.name}{" "}
                <span
                  className="ml-1 px-1.5 py-0.5 font-mono text-[11px] uppercase"
                  style={{
                    background:
                      a.kind === "internal"
                        ? "var(--review-bg)"
                        : "var(--surface-alt)",
                    color:
                      a.kind === "internal"
                        ? "var(--review)"
                        : "var(--dim)",
                  }}
                >
                  {a.kind}
                </span>
              </p>
              {a.details ? (
                <p className="mt-0.5 line-clamp-2 font-mono text-xs text-[var(--dim)]">
                  {a.details}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={`Delete record ${a.name}`}
              className="shrink-0 px-2 font-mono text-xs text-[var(--blocked)]"
              onClick={() => del.mutate(a.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>

      {showForm ? (
        <form
          className="mt-3 space-y-3 border-t border-[var(--border)] pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <div>
            <label className={labelCls} htmlFor="rec-name">
              Record name
            </label>
            <input
              id="rec-name"
              className={inputCls}
              style={{ borderRadius: "6px" }}
              placeholder="e.g. Globex Ltd — Account B, or Internal pricing sheet 2026"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="rec-kind">
              Type
            </label>
            <select
              id="rec-kind"
              className={inputCls}
              style={{ borderRadius: "6px" }}
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as "customer" | "internal")
              }
            >
              <option value="customer">Customer account</option>
              <option value="internal">Internal record (pricing / CPQ)</option>
            </select>
          </div>
          <div>
            <label className={labelCls} htmlFor="rec-details">
              Details the agent can see
            </label>
            <textarea
              id="rec-details"
              className={`${inputCls} font-mono`}
              style={{ borderRadius: "6px" }}
              rows={4}
              placeholder="Plan, renewal date, discount, contact email, deal terms — paste what the agent has access to."
              value={details}
              onChange={(e) => setDetails(e.target.value)}
            />
          </div>
          {add.isError ? (
            <p className="text-sm text-[var(--blocked)]">
              Couldn't save that record. Try again.
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!name.trim() || add.isPending}
            className="px-4 py-2 text-sm font-semibold disabled:opacity-40"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
              borderRadius: "6px",
            }}
          >
            {add.isPending ? "Saving…" : "Save record"}
          </button>
        </form>
      ) : null}

      <details className="mt-3 border-t border-[var(--border)] pt-3">
        <summary className="cursor-pointer font-mono text-xs font-semibold uppercase tracking-widest text-[var(--accent)]">
          Import a CRM export (CSV)
        </summary>
        <p className="mt-2 text-sm text-[var(--dim)]">
          Paste a Salesforce / HubSpot / Zoho export — no CRM login or admin
          install needed. Columns: <span className="font-mono">name, kind
          (customer|internal), details</span>. Extra columns are kept inside
          the record's details.
        </p>
        <textarea
          aria-label="CSV export to import"
          className={`${inputCls} mt-2 font-mono`}
          style={{ borderRadius: "6px" }}
          rows={4}
          placeholder={"name,kind,details\nGlobex Ltd,customer,\"Contact a@globex.example, deal $9,600\"\nInternal pricing,internal,\"Floor price $3,200, margin 18%\""}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
        />
        {imp.isSuccess ? (
          <p className="mt-2 text-sm text-[var(--clear)]">
            Imported {imp.data.imported} record(s)
            {imp.data.skipped > 0
              ? `, skipped ${imp.data.skipped} row(s) without a name`
              : ""}
            .
          </p>
        ) : null}
        {imp.isError ? (
          <p className="mt-2 text-sm text-[var(--blocked)]">
            Import failed. Check the CSV and try again.
          </p>
        ) : null}
        <button
          type="button"
          disabled={!csv.trim() || imp.isPending}
          onClick={() => imp.mutate()}
          className="mt-2 px-4 py-2 text-sm font-semibold disabled:opacity-40"
          style={{
            background: "var(--accent)",
            color: "var(--accent-ink)",
            borderRadius: "6px",
          }}
        >
          {imp.isPending ? "Importing…" : "Import records"}
        </button>
      </details>
    </section>
  );
}

function PersonasPanel({
  personas,
  accounts,
}: {
  personas: Persona[];
  accounts: Account[];
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Persona["role"]>("customer");
  const [accountId, setAccountId] = useState<string>("");
  const [maySee, setMaySee] = useState("");
  const [mustNotSee, setMustNotSee] = useState("");
  const [showForm, setShowForm] = useState(false);

  const add = useMutation({
    mutationFn: async () =>
      await api.addPersona({
        name: name.trim(),
        role,
        account_id: accountId ? Number(accountId) : null,
        may_see: maySee,
        must_not_see: mustNotSee,
      }),
    onSuccess: () => {
      setName("");
      setRole("customer");
      setAccountId("");
      setMaySee("");
      setMustNotSee("");
      setShowForm(false);
      queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
  });
  const del = useMutation({
    mutationFn: async (id: number) => await api.deletePersona({ id }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["workspace"] }),
  });

  const accountName = (id: number | null) =>
    accounts.find((a) => a.id === id)?.name;

  return (
    <section
      aria-label="Recipient personas"
      className="border border-[var(--border)] bg-[var(--surface)] p-4"
      style={{ borderRadius: "var(--radius)" }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-[var(--text)]">
          Recipient personas
        </h2>
        <button
          type="button"
          className="font-mono text-xs font-semibold text-[var(--accent)]"
          onClick={() => setShowForm((s) => !s)}
        >
          {showForm ? "Close" : "+ Add persona"}
        </button>
      </div>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Who receives the reply, which account is theirs, and what they must
        never see.
      </p>

      <ul className="mt-3 divide-y divide-[var(--border)]">
        {personas.map((p) => (
          <li key={p.id} className="flex items-start justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text)]">
                {p.name}{" "}
                <span className="font-mono text-[11px] uppercase text-[var(--dim)]">
                  {p.role}
                  {p.account_id
                    ? ` · ${accountName(p.account_id) ?? "account removed"}`
                    : ""}
                </span>
              </p>
              {p.must_not_see ? (
                <p className="mt-0.5 text-xs text-[var(--dim)]">
                  Must never see: {p.must_not_see}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              aria-label={`Delete persona ${p.name}`}
              className="shrink-0 px-2 font-mono text-xs text-[var(--blocked)]"
              onClick={() => del.mutate(p.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
      {personas.length === 0 && !showForm ? (
        <p className="mt-1 bg-[var(--surface-alt)] px-3 py-2 text-sm text-[var(--dim)]">
          No personas yet — add one to run a check.
        </p>
      ) : null}

      {showForm ? (
        <form
          className="mt-3 space-y-3 border-t border-[var(--border)] pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) add.mutate();
          }}
        >
          <div>
            <label className={labelCls} htmlFor="per-name">
              Persona name
            </label>
            <input
              id="per-name"
              className={inputCls}
              style={{ borderRadius: "6px" }}
              placeholder="e.g. Aisha Khan (Globex account admin)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls} htmlFor="per-role">
                Role
              </label>
              <select
                id="per-role"
                className={inputCls}
                style={{ borderRadius: "6px" }}
                value={role}
                onChange={(e) => setRole(e.target.value as Persona["role"])}
              >
                <option value="customer">Customer</option>
                <option value="partner">Partner</option>
                <option value="prospect">Prospect</option>
                <option value="internal">Internal staff</option>
              </select>
            </div>
            <div>
              <label className={labelCls} htmlFor="per-account">
                Their account
              </label>
              <select
                id="per-account"
                className={inputCls}
                style={{ borderRadius: "6px" }}
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">None / external</option>
                {accounts
                  .filter((a) => a.kind === "customer")
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
              </select>
            </div>
          </div>
          <div>
            <label className={labelCls} htmlFor="per-may">
              May see
            </label>
            <textarea
              id="per-may"
              className={inputCls}
              style={{ borderRadius: "6px" }}
              rows={2}
              placeholder="Their own plan, invoices, renewal dates…"
              value={maySee}
              onChange={(e) => setMaySee(e.target.value)}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="per-mustnot">
              Must never see (one per line)
            </label>
            <textarea
              id="per-mustnot"
              className={inputCls}
              style={{ borderRadius: "6px" }}
              rows={2}
              placeholder={"Other customers' names or pricing\nInternal discount tiers\nCPQ margins"}
              value={mustNotSee}
              onChange={(e) => setMustNotSee(e.target.value)}
            />
          </div>
          {add.isError ? (
            <p className="text-sm text-[var(--blocked)]">
              Couldn't save that persona. Try again.
            </p>
          ) : null}
          <button
            type="submit"
            disabled={!name.trim() || add.isPending}
            className="px-4 py-2 text-sm font-semibold disabled:opacity-40"
            style={{
              background: "var(--accent)",
              color: "var(--accent-ink)",
              borderRadius: "6px",
            }}
          >
            {add.isPending ? "Saving…" : "Save persona"}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function PacksPanel({ packs }: { packs: Pack[] }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: async (args: { pack_id: string; enabled: boolean }) =>
      await api.setPackEnabled(args),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["workspace"] }),
  });
  return (
    <section
      aria-label="Policy packs"
      className="border border-[var(--border)] bg-[var(--surface)] p-4"
      style={{ borderRadius: "var(--radius)" }}
    >
      <h2 className="text-base font-semibold text-[var(--text)]">
        Policy packs
      </h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Ready-made CRM policy content: switch a pack on and its protected
        terms are flagged for any recipient who isn't entitled to them —
        no blank-slate rule writing.
      </p>
      <ul className="mt-3 divide-y divide-[var(--border)]">
        {packs.map((p) => (
          <li key={p.id} className="flex items-start justify-between gap-3 py-2">
            <div className="min-w-0">
              <p className="text-sm font-medium text-[var(--text)]">
                {p.name}{" "}
                <span className="font-mono text-[11px] uppercase text-[var(--dim)]">
                  {p.vendor}
                </span>
              </p>
              <p className="mt-0.5 text-xs text-[var(--dim)]">{p.description}</p>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={p.enabled}
              aria-label={`${p.enabled ? "Disable" : "Enable"} ${p.name} (${p.vendor})`}
              disabled={toggle.isPending}
              onClick={() =>
                toggle.mutate({ pack_id: p.id, enabled: !p.enabled })
              }
              className="shrink-0 px-2.5 py-1 font-mono text-xs font-semibold disabled:opacity-40"
              style={{
                background: p.enabled ? "var(--accent)" : "var(--surface-alt)",
                color: p.enabled ? "var(--accent-ink)" : "var(--dim)",
                borderRadius: "999px",
              }}
            >
              {p.enabled ? "ON" : "OFF"}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function UpdateCheckPanel({
  accounts,
  onDone,
}: {
  accounts: Account[];
  onDone: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const [accountId, setAccountId] = useState<string>("");
  const [field, setField] = useState("");
  const [value, setValue] = useState("");
  const effectiveAccountId =
    accounts.find((a) => a.id === Number(accountId))?.id ??
    accounts[0]?.id ??
    null;
  const run = useMutation({
    mutationFn: async () =>
      await api.runUpdateCheck({
        target_account_id: effectiveAccountId as number,
        field: field.trim(),
        value: value.trim(),
      }),
    onSuccess: (result) => {
      onDone(result.id);
      queryClient.invalidateQueries({ queryKey: ["checks"] });
    },
  });
  const canRun =
    effectiveAccountId !== null &&
    field.trim().length > 0 &&
    value.trim().length > 0 &&
    !run.isPending;
  return (
    <section
      aria-label="Record-update pre-flight"
      className="border border-[var(--border)] bg-[var(--surface)] p-4"
      style={{ borderRadius: "var(--radius)" }}
    >
      <h2 className="text-base font-semibold text-[var(--text)]">
        Record-update pre-flight
      </h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        The quiet leak never becomes an email: check a value before it's
        written into a record. If it came from another account — or from
        an internal sheet — it gets flagged before it lands.
      </p>
      <div className="mt-3 space-y-3">
        <div>
          <label className={labelCls} htmlFor="upd-account">
            Write into record
          </label>
          <select
            id="upd-account"
            className={inputCls}
            style={{ borderRadius: "6px" }}
            value={effectiveAccountId ?? ""}
            onChange={(e) => setAccountId(e.target.value)}
            disabled={accounts.length === 0}
          >
            {accounts.length === 0 ? (
              <option value="">Add a record first →</option>
            ) : (
              accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.kind})
                </option>
              ))
            )}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="upd-field">
            Field
          </label>
          <input
            id="upd-field"
            className={inputCls}
            style={{ borderRadius: "6px" }}
            placeholder="e.g. Notes, Next step, Billing contact"
            value={field}
            onChange={(e) => setField(e.target.value)}
          />
        </div>
        <div>
          <label className={labelCls} htmlFor="upd-value">
            Proposed value
          </label>
          <textarea
            id="upd-value"
            className={`${inputCls} font-mono`}
            style={{ borderRadius: "6px" }}
            rows={3}
            placeholder="The value about to be saved into that field…"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        {run.isError ? (
          <p className="text-sm text-[var(--blocked)]">
            The update check failed to run. Try again.
          </p>
        ) : null}
        <button
          type="button"
          disabled={!canRun}
          onClick={() => run.mutate()}
          className="w-full py-2.5 text-sm font-bold disabled:opacity-40"
          style={{
            background: "var(--accent)",
            color: "var(--accent-ink)",
            borderRadius: "6px",
          }}
        >
          {run.isPending ? "Checking update…" : "Check this update"}
        </button>
      </div>
    </section>
  );
}

function BatchPanel({
  personas,
  onDone,
}: {
  personas: Persona[];
  onDone: (id: number) => void;
}) {
  const queryClient = useQueryClient();
  const [personaId, setPersonaId] = useState<string>("");
  const [text, setText] = useState("");
  const [results, setResults] = useState<Check[] | null>(null);
  const effectivePersonaId =
    personas.find((p) => p.id === Number(personaId))?.id ??
    personas[0]?.id ??
    null;
  const drafts = text
    .split(/\n\s*---\s*\n|\n{2,}/)
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
    .slice(0, 20);
  const run = useMutation({
    mutationFn: async () =>
      await api.runBatchCheck({
        persona_id: effectivePersonaId as number,
        drafts,
      }),
    onSuccess: (result) => {
      setResults(result.checks);
      queryClient.invalidateQueries({ queryKey: ["checks"] });
    },
  });
  const canRun =
    effectivePersonaId !== null && drafts.length > 0 && !run.isPending;
  return (
    <section
      aria-label="Batch check"
      className="border border-[var(--border)] bg-[var(--surface)] p-4"
      style={{ borderRadius: "var(--radius)" }}
    >
      <h2 className="text-base font-semibold text-[var(--text)]">
        Batch check
      </h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        Audit a queue of agent drafts at once — yesterday's outbound, a
        campaign batch. Separate drafts with a blank line or a{" "}
        <span className="font-mono">---</span> line (max 20). Batch runs
        the rule engine + packs (no AI pass) and ranks riskiest first.
      </p>
      <div className="mt-3 space-y-3">
        <div>
          <label className={labelCls} htmlFor="batch-persona">
            Recipient persona for all drafts
          </label>
          <select
            id="batch-persona"
            className={inputCls}
            style={{ borderRadius: "6px" }}
            value={effectivePersonaId ?? ""}
            onChange={(e) => setPersonaId(e.target.value)}
            disabled={personas.length === 0}
          >
            {personas.length === 0 ? (
              <option value="">Add a persona first →</option>
            ) : (
              personas.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.role})
                </option>
              ))
            )}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="batch-drafts">
            Drafts ({drafts.length})
          </label>
          <textarea
            id="batch-drafts"
            className={`${inputCls} font-mono`}
            style={{ borderRadius: "6px" }}
            rows={6}
            placeholder={"First draft…\n\n---\n\nSecond draft…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {run.isError ? (
          <p className="text-sm text-[var(--blocked)]">
            The batch check failed to run. Try again.
          </p>
        ) : null}
        <button
          type="button"
          disabled={!canRun}
          onClick={() => run.mutate()}
          className="w-full py-2.5 text-sm font-bold disabled:opacity-40"
          style={{
            background: "var(--accent)",
            color: "var(--accent-ink)",
            borderRadius: "6px",
          }}
        >
          {run.isPending
            ? "Checking batch…"
            : `Check ${drafts.length || ""} draft${drafts.length === 1 ? "" : "s"}`}
        </button>
        {results ? (
          <ul className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
            {results.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-3 py-2 text-left"
                  onClick={() => onDone(c.id)}
                >
                  <VerdictStamp verdict={c.verdict} />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--dim)]">
                    {c.draft}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-[var(--dim)]">
                    {c.findings.length} finding
                    {c.findings.length === 1 ? "" : "s"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function EvalPanel() {
  const [result, setResult] = useState<EvalResult | null>(null);
  const run = useMutation({
    mutationFn: async () => await api.runEvalSuite({}),
    onSuccess: (r) => setResult(r),
  });
  return (
    <section
      aria-label="Detection self-test"
      className="border border-[var(--border)] bg-[var(--surface)] p-4"
      style={{ borderRadius: "var(--radius)" }}
    >
      <h2 className="text-base font-semibold text-[var(--text)]">
        Detection self-test
      </h2>
      <p className="mt-1 text-sm text-[var(--dim)]">
        A built-in synthetic suite in the CRMArena-Pro style — cross-account
        leaks, CPQ terms to an external, a mosaic thread, and benign
        own-data drafts — run through the rule engine against fixed
        synthetic records. Nothing here touches your data.
      </p>
      <button
        type="button"
        disabled={run.isPending}
        onClick={() => run.mutate()}
        className="mt-3 px-4 py-2 text-sm font-semibold disabled:opacity-40"
        style={{
          background: "var(--accent)",
          color: "var(--accent-ink)",
          borderRadius: "6px",
        }}
      >
        {run.isPending ? "Running…" : "Run the suite"}
      </button>
      {run.isError ? (
        <p className="mt-2 text-sm text-[var(--blocked)]">
          The suite failed to run. Try again.
        </p>
      ) : null}
      {result ? (
        <div className="mt-3">
          <p className="text-sm font-semibold text-[var(--text)]">
            {result.passed}/{result.total} cases match the expected verdict
          </p>
          <ul className="mt-2 divide-y divide-[var(--border)]">
            {result.cases.map((c) => (
              <li key={c.name} className="flex items-baseline gap-2 py-1.5 text-sm">
                <span
                  aria-hidden
                  className="font-mono text-xs font-bold"
                  style={{ color: c.pass ? "var(--clear)" : "var(--blocked)" }}
                >
                  {c.pass ? "✓" : "✗"}
                </span>
                <span className="min-w-0 flex-1 text-[var(--text)]">
                  {c.name}
                  <span className="block font-mono text-[11px] uppercase text-[var(--dim)]">
                    {c.category} · expected {c.expected} · got {c.actual}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

const LANDSCAPE: {
  name: string;
  nails: string;
  limit: string;
  url: string;
  urlLabel: string;
}[] = [
  {
    name: "WaverSec Protect / MCP",
    nails: "True pre-send Allow / Warn / Block for AI-agent email, from $8/seat/mo.",
    limit:
      "Email-only (Outlook; Gmail “coming soon”). No CRM records, no cross-account attribution, no CPQ persona rules, no redacted rewrite.",
    url: "https://www.waversec.com/mcp",
    urlLabel: "waversec.com/mcp",
  },
  {
    name: "Nightfall AI",
    nails:
      "Broadest SaaS/AI DLP — Salesforce & Zendesk coverage, redact/block, copy-paste lineage into AI tools.",
    limit:
      "Direction is data into AI, not a draft out to the wrong customer. No recipient-account entitlement or CPQ logic; pricing page blanks the amounts — contact sales, 7-day proof of value.",
    url: "https://www.nightfall.ai/pricing",
    urlLabel: "nightfall.ai/pricing",
  },
  {
    name: "Salesforce Einstein Trust Layer",
    nails:
      "CRM-native: permission-respecting retrieval, zero retention, toxicity checks, audit.",
    limit:
      "Salesforce-only, and Salesforce's own help page (published 2026-11-13) states data masking through the Trust Layer is disabled for agents. No outbound recipient-persona check.",
    url: "https://help.salesforce.com/s/articleView?id=copilot_trust.htm&language=en_US&type=5",
    urlLabel: "help.salesforce.com",
  },
  {
    name: "Lakera Guard (Check Point AI Guardrails)",
    nails: "Clean runtime API screening inputs/outputs for PII and data leakage.",
    limit:
      "Generic pattern detection — no CRM account graph, no persona or CPQ rules, no rewrite; the caller implements the action. Paid tiers not publicly priced on its site.",
    url: "https://docs.lakera.ai/docs/api/guard",
    urlLabel: "docs.lakera.ai",
  },
  {
    name: "Galileo Protect / Patronus AI",
    nails: "Runtime blocking and evaluation for PII, injection, hallucination in LLM apps.",
    limit:
      "Built for developers of LLM apps, not RevOps. Generic PII categories, no CRM grounding, persona, cross-account logic, or rewrite.",
    url: "https://docs.galileo.ai/sdk-api/protect/rules",
    urlLabel: "docs.galileo.ai",
  },
];

function LandscapeSection() {
  return (
    <section
      aria-label="What already exists, checked November 2026"
      className="mt-8 border border-[var(--border)] bg-[var(--surface)] p-4 sm:p-5"
      style={{ borderRadius: "var(--radius)" }}
    >
      <h2 className="text-lg font-semibold text-[var(--text)]">
        Checked against what already exists
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-[var(--dim)]">
        A November 2026 competitor check of CRM trust layers, DLP, and AI
        guardrails found no product that does this whole job — draft vs.
        the records the agent can see, decided by recipient persona, with
        source attribution and a verified rewrite, vendor-neutral and
        self-serve. The closest five each cover one slice:
      </p>
      <ul className="mt-3 divide-y divide-[var(--border)]">
        {LANDSCAPE.map((row) => (
          <li key={row.name} className="py-3">
            <p className="text-sm font-semibold text-[var(--text)]">
              {row.name}{" "}
              <a
                className="font-mono text-xs font-medium text-[var(--accent)] underline"
                href={row.url}
                target="_blank"
                rel="noreferrer"
              >
                {row.urlLabel}
              </a>
            </p>
            <p className="mt-0.5 text-sm text-[var(--dim)]">
              <span className="font-medium text-[var(--text)]">Nails:</span>{" "}
              {row.nails}
            </p>
            <p className="mt-0.5 text-sm text-[var(--dim)]">
              <span className="font-medium text-[var(--text)]">
                Where it stops:
              </span>{" "}
              {row.limit}
            </p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-[var(--dim)]">
        Caveat from the same check: exact paid pricing for several vendors
        isn't published (amounts blank or quote-only), and a stealth or very
        new entrant can't be ruled out. Generic PII detection, pre-send
        email verdicts, and permission-respecting grounding inside one CRM
        all already exist — CRMGuard's ground is the combination none of
        them ship.
      </p>
    </section>
  );
}

// ------------------------------------------------------------------- app

export function App() {
  const queryClient = useQueryClient();
  const workspace = useQuery({
    queryKey: ["workspace"],
    queryFn: () => api.getWorkspace({}),
  });
  const checksQuery = useQuery({
    queryKey: ["checks"],
    queryFn: () => api.listChecks({ limit: 30 }),
  });

  const accounts = workspace.data?.accounts ?? [];
  const personas = workspace.data?.personas ?? [];
  const checks = checksQuery.data?.checks ?? [];

  const [personaId, setPersonaId] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [thread, setThread] = useState("");
  const [selectedCheckId, setSelectedCheckId] = useState<number | null>(null);

  // The stored selection only counts while that persona still exists —
  // after it's deleted, fall back to the first persona instead of
  // pointing the composer (and the next check) at a removed record.
  const effectivePersonaId =
    personas.find((p) => p.id === Number(personaId))?.id ??
    personas[0]?.id ??
    null;
  const selectedCheck =
    checks.find((c) => c.id === selectedCheckId) ?? checks[0] ?? null;

  // Same for the open check: once it's deleted from history, move the
  // selection to the newest remaining check rather than leaving a
  // dangling id that silently shows a different result.
  useEffect(() => {
    if (
      selectedCheckId !== null &&
      checks.length > 0 &&
      !checks.some((c) => c.id === selectedCheckId)
    ) {
      setSelectedCheckId(checks[0]?.id ?? null);
    }
  }, [checks, selectedCheckId]);

  const run = useMutation({
    mutationFn: async () =>
      await api.runCheck({
        draft: draft.trim(),
        persona_id: effectivePersonaId as number,
        thread: thread.trim(),
      }),
    onSuccess: (result) => {
      setSelectedCheckId(result.id);
      queryClient.invalidateQueries({ queryKey: ["checks"] });
    },
  });
  const deleteCheck = useMutation({
    mutationFn: async (id: number) => await api.deleteCheck({ id }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["checks"] }),
  });

  const canRun =
    draft.trim().length > 0 && effectivePersonaId !== null && !run.isPending;

  return (
    <div className="min-h-screen bg-[var(--bg)] [overflow-x:clip]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-6xl px-4 pb-10 pt-4 sm:px-6">
        {/* Lead: the job, and the evidence it matters */}
        <div className="max-w-3xl">
          <h1 className="text-2xl font-bold leading-tight text-[var(--text)] sm:text-3xl">
            Catch the leak before the reply goes out.
          </h1>
          <p className="mt-2 text-base text-[var(--dim)]">
            Paste a draft reply from your sales or support agent, pick who
            it's going to, and CRMGuard checks whether it discloses another
            customer's data, internal pricing, or CPQ terms to the wrong
            persona — every finding attributed to the record it came from.
            The redacted rewrite it drafts is re-checked before it's
            called safe. New in this build: thread (mosaic) checks, policy
            packs, record-update pre-flight, CSV import, and batch audits.
          </p>
          <p className="mt-3 border-l-2 border-[var(--accent)] pl-3 text-sm text-[var(--dim)]">
            Why: in Salesforce AI Research's CRMArena-Pro benchmark (2025),
            leading CRM agents succeeded at only ~58% of single-turn tasks
            and ~35% multi-turn, with “near-zero inherent confidentiality
            awareness.”{" "}
            <a
              className="font-medium text-[var(--accent)] underline"
              href="https://arxiv.org/abs/2505.18878"
              target="_blank"
              rel="noreferrer"
            >
              Read the paper
            </a>
          </p>
        </div>

        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          {/* Left column: composer + setup */}
          <div className="min-w-0 space-y-5">
            <section
              aria-label="New pre-flight check"
              className="border-2 border-[var(--text)] bg-[var(--surface)] p-4 sm:p-5"
              style={{ borderRadius: "var(--radius)" }}
            >
              <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">
                Pre-flight check
              </h2>
              <div className="mt-3">
                <label className={labelCls} htmlFor="check-persona">
                  Recipient persona
                </label>
                <select
                  id="check-persona"
                  className={inputCls}
                  style={{ borderRadius: "6px" }}
                  value={effectivePersonaId ?? ""}
                  onChange={(e) => setPersonaId(e.target.value)}
                  disabled={personas.length === 0}
                >
                  {personas.length === 0 ? (
                    <option value="">Add a persona first →</option>
                  ) : (
                    personas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.role})
                      </option>
                    ))
                  )}
                </select>
              </div>
              <div className="mt-3">
                <label className={labelCls} htmlFor="check-draft">
                  Draft reply to check
                </label>
                <textarea
                  id="check-draft"
                  className={`${inputCls} font-mono`}
                  style={{ borderRadius: "6px" }}
                  rows={7}
                  placeholder="Paste the agent's draft reply or CRM update here…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
              </div>
              <details className="mt-3">
                <summary className="cursor-pointer font-mono text-xs uppercase tracking-widest text-[var(--dim)]">
                  Earlier messages in this thread (optional — mosaic check)
                </summary>
                <textarea
                  aria-label="Earlier messages in this thread"
                  className={`${inputCls} mt-2 font-mono`}
                  style={{ borderRadius: "6px" }}
                  rows={4}
                  placeholder="Paste the earlier messages to this recipient. Leaks split across messages — a name here, a figure in the draft — are flagged as cumulative disclosure."
                  value={thread}
                  onChange={(e) => setThread(e.target.value)}
                />
              </details>
              {accounts.length === 0 ? (
                <p className="mt-2 text-sm text-[var(--review)]">
                  No records added yet — the check will run, but it can only
                  catch leaks against records it knows. Add records below.
                </p>
              ) : null}
              {run.isError ? (
                <p className="mt-2 text-sm text-[var(--blocked)]">
                  The check failed to run. Check your connection and try
                  again.
                </p>
              ) : null}
              <button
                type="button"
                disabled={!canRun}
                onClick={() => run.mutate()}
                className="mt-4 w-full py-3 text-base font-bold disabled:opacity-40"
                style={{
                  background: "var(--accent)",
                  color: "var(--accent-ink)",
                  borderRadius: "6px",
                }}
              >
                {run.isPending
                  ? "Running pre-flight…"
                  : "Run pre-flight check"}
              </button>
            </section>

            {workspace.isPending ? (
              <p className="text-sm text-[var(--dim)]">Loading workspace…</p>
            ) : workspace.isError ? (
              <p className="text-sm text-[var(--blocked)]">
                Couldn't load your records and personas.{" "}
                <button
                  type="button"
                  className="underline"
                  onClick={() => workspace.refetch()}
                >
                  Retry
                </button>
              </p>
            ) : (
              <>
                <RecordsPanel accounts={accounts} />
                <PersonasPanel personas={personas} accounts={accounts} />
                <PacksPanel packs={workspace.data?.packs ?? []} />
              </>
            )}
          </div>

          {/* Right column: latest result + history */}
          <div className="min-w-0 space-y-5">
            {selectedCheck ? (
              <CheckResult check={selectedCheck} />
            ) : (
              <section
                aria-label="Check result"
                className="border border-dashed border-[var(--border)] bg-[var(--surface)] p-6 text-center"
                style={{ borderRadius: "var(--radius)" }}
              >
                <p className="font-mono text-xs uppercase tracking-widest text-[var(--dim)]">
                  No checks yet
                </p>
                <p className="mx-auto mt-2 max-w-sm text-sm text-[var(--dim)]">
                  Add the records your agent can see and a recipient persona,
                  paste a draft, and run your first pre-flight. The verdict —
                  blocked, review, or clear — lands here with the evidence.
                </p>
              </section>
            )}

            {checks.length > 0 ? (
              <section
                aria-label="Check history"
                className="border border-[var(--border)] bg-[var(--surface)] p-4"
                style={{ borderRadius: "var(--radius)" }}
              >
                <h2 className="font-mono text-xs font-semibold uppercase tracking-widest text-[var(--dim)]">
                  History
                </h2>
                <ul className="mt-2 divide-y divide-[var(--border)]">
                  {checks.map((c) => (
                    <li key={c.id} className="flex items-center gap-2 py-2">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 items-center gap-3 text-left"
                        onClick={() => setSelectedCheckId(c.id)}
                        aria-label={`View check for ${c.persona_name}, verdict ${VERDICT_LABEL[c.verdict]}`}
                      >
                        <VerdictStamp verdict={c.verdict} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-[var(--text)]">
                            {c.check_type === "update"
                              ? c.persona_name
                              : `To ${c.persona_name}`}
                          </span>
                          <span className="block truncate font-mono text-xs text-[var(--dim)]">
                            {new Date(c.created_at).toLocaleString()} ·{" "}
                            {c.draft}
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete check for ${c.persona_name}`}
                        className="shrink-0 px-2 font-mono text-xs text-[var(--blocked)]"
                        onClick={() => deleteCheck.mutate(c.id)}
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </div>

        {/* Second surface: batch, record updates, proof */}
        <div className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-3">
          <BatchPanel
            personas={personas}
            onDone={(id) => setSelectedCheckId(id)}
          />
          <UpdateCheckPanel
            accounts={accounts}
            onDone={(id) => setSelectedCheckId(id)}
          />
          <EvalPanel />
        </div>

        <LandscapeSection />
      </main>
    </div>
  );
}
