export interface AirlockSource {
  id: string;
  rawTitle: string;
  rawUrl?: string;
  tabId?: number;
  kind: "tab" | "file";
  content: string;
  lines: string[];
  byteSize: number;
}

export function createSource(params: {
  index: number;
  rawTitle: string;
  content: string;
  kind: "tab" | "file";
  rawUrl?: string;
  tabId?: number;
}): AirlockSource {
  const normalized = params.content.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  return {
    id: `src_${params.index}`,
    rawTitle: params.rawTitle,
    rawUrl: params.rawUrl,
    tabId: params.tabId,
    kind: params.kind,
    content: normalized,
    lines,
    byteSize: new TextEncoder().encode(normalized).length,
  };
}

export function runLocalOutline(source: AirlockSource): string {
  const highlights: string[] = [];
  for (let i = 0; i < source.lines.length; i++) {
    const line = source.lines[i].trim();
    if (!line) continue;
    const isHeading =
      /^#{1,4}\s+/.test(line) ||
      /^(?:export\s+)?(?:async\s+)?(?:function|class|def|interface|type)\s+/.test(
        line
      ) ||
      /\b(?:ERROR|FATAL|CRITICAL|EXCEPTION|502|503|504|TIMEOUT|OOM|DEADLOCK)\b/i.test(
        line
      );

    if (isHeading) {
      highlights.push(`L${i + 1}: ${line.slice(0, 180)}`);
      if (highlights.length >= 30) break;
    }
  }

  if (highlights.length === 0) {
    return source.lines
      .slice(0, 18)
      .map((l, idx) => `L${idx + 1}: ${l.slice(0, 180)}`)
      .join("\n");
  }
  return highlights.join("\n");
}

export function runLocalGrep(
  source: AirlockSource,
  rawQuery: string,
  maxMatches = 12
): { matchCount: number; excerpt: string; matchedLines: number[] } {
  const cap = Math.max(1, Math.min(25, maxMatches));
  const terms = rawQuery
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.toLowerCase());

  if (terms.length === 0) {
    return { matchCount: 0, excerpt: "Empty grep query.", matchedLines: [] };
  }

  const matchedLines: number[] = [];
  const snippets: string[] = [];
  const lowerQuery = rawQuery.trim().toLowerCase();

  for (let i = 0; i < source.lines.length; i++) {
    const lineLower = source.lines[i].toLowerCase();
    const exactHit = lineLower.includes(lowerQuery);
    const allTermsHit = terms.every((t) => lineLower.includes(t));

    if (exactHit || allTermsHit) {
      matchedLines.push(i + 1);
      const start = Math.max(0, i - 1);
      const end = Math.min(source.lines.length - 1, i + 1);
      const block = [];
      for (let j = start; j <= end; j++) {
        block.push(`L${j + 1}: ${source.lines[j].slice(0, 240)}`);
      }
      snippets.push(block.join("\n"));
      if (snippets.length >= cap) break;
    }
  }

  if (snippets.length === 0) {
    // Fallback to OR match if AND match returned nothing
    for (let i = 0; i < source.lines.length; i++) {
      const lineLower = source.lines[i].toLowerCase();
      if (terms.some((t) => t.length >= 3 && lineLower.includes(t))) {
        matchedLines.push(i + 1);
        snippets.push(`L${i + 1}: ${source.lines[i].slice(0, 240)}`);
        if (snippets.length >= cap) break;
      }
    }
  }

  return {
    matchCount: matchedLines.length,
    matchedLines,
    excerpt:
      snippets.length > 0
        ? snippets.join("\n---\n")
        : `No lines matched "${rawQuery}" in ${source.id}.`,
  };
}

export function runLocalReadChunk(
  source: AirlockSource,
  startLine: number,
  lineCount: number
): string {
  const safeStart = Math.max(1, Math.min(source.lines.length, startLine));
  const safeCount = Math.max(1, Math.min(60, lineCount));
  const slice = source.lines.slice(safeStart - 1, safeStart - 1 + safeCount);
  return slice
    .map((line, idx) => `L${safeStart + idx}: ${line.slice(0, 260)}`)
    .join("\n");
}

/**
 * Optional quick-load sample pack for hosted web judges who do not have local logs handy.
 * Drag-and-drop of ANY user file (.log, .har, .ts, .py, .md, .json) is the primary workflow.
 */
export function buildSampleIncidentSources(): AirlockSource[] {
  const samples = [
    {
      rawTitle: "prod-gateway-incident.log",
      content: [
        "2026-11-22T09:14:02Z INFO  edge-proxy host=payments-gw.corp.internal req_id=TXN-992841 user=priya.nair@meridianfin.com status=200 ms=42",
        "2026-11-22T09:14:09Z WARN  ledger-reconciler host=recon-02.internal pool=pg-primary active=48/50 wait_ms=890",
        "2026-11-22T09:14:11Z ERROR ledger-reconciler db=postgresql://recon_svc:S3cr3tP4ss99@10.42.8.19:5432/treasury timeout acquiring connection after 5000ms",
        "2026-11-22T09:14:11Z ERROR edge-proxy upstream=http://recon-02.internal:8080/v2/settle status=502 account=ACC-774102 amount=$4.2M auth=Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJwcml5YS5uYWlyIiwiYWNjdCI6IkFDQy03NzQxMDIifQ.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        "2026-11-22T09:14:14Z ERROR ledger-reconciler retry_exhausted project=ProjectKestrel client=MeridianCapitalCorp owner=ArjunMehta phone=+91-98301-44219",
        "2026-11-22T09:14:16Z CRITICAL settlement-worker circuit_breaker=OPEN reason=deadlock_on_batch_commit_lock affected_batch=9941",
      ].join("\n"),
    },
    {
      rawTitle: "reconciler-pool.ts",
      content: [
        "import { Pool } from 'pg';",
        "",
        "// Service: ledger-reconciler (ProjectKestrel treasury pipeline)",
        "export const dbPool = new Pool({",
        "  connectionString: 'postgresql://recon_svc:S3cr3tP4ss99@10.42.8.19:5432/treasury',",
        "  max: 50,",
        "  connectionTimeoutMillis: 5000,",
        "  idleTimeoutMillis: 30000,",
        "});",
        "",
        "export async function settleBatch(batchId: string, accountId: string) {",
        "  const client = await dbPool.connect();",
        "  // BUG: missing try/finally around client.release() when settlement throws!",
        "  await client.query('BEGIN');",
        "  await client.query('SELECT * FROM balances WHERE acct_id = $1 FOR UPDATE', [accountId]);",
        "  const res = await fetch('http://recon-02.internal:8080/v2/audit', {",
        "    headers: { Authorization: 'Bearer sk-live-9f8e7d6c5b4a3210fedcba987654' },",
        "  });",
        "  if (!res.ok) throw new Error('Audit webhook failed for ' + batchId);",
        "  await client.query('COMMIT');",
        "  client.release();",
        "}",
      ].join("\n"),
    },
    {
      rawTitle: "slack-warroom-notes.md",
      content: [
        "# Incident War Room — Nov 22",
        "- Escalated by Priya Nair (MeridianCapitalCorp) after $4.2M wire settlement returned HTTP 502.",
        "- Arjun Mehta confirmed recon-02.internal CPU is only 18%, so this is NOT compute starvation.",
        "- Audit webhook at recon-02.internal started returning HTTP 429 at 09:13:55Z right before connection pool hit 50/50.",
        "- Constraint: Cannot restart PostgreSQL primary (10.42.8.19) during market hours; fix must be in ledger-reconciler TypeScript code.",
      ].join("\n"),
    },
  ];

  return samples.map((s, idx) =>
    createSource({
      index: idx + 1,
      rawTitle: s.rawTitle,
      content: s.content,
      kind: "file",
    })
  );
}
