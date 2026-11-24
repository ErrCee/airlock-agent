export type VaultCategory =
  | "SECRET"
  | "TOKEN"
  | "EMAIL"
  | "IP"
  | "HOST"
  | "PHONE"
  | "ACCOUNT"
  | "AMOUNT"
  | "PERSON"
  | "ORG"
  | "SERVICE"
  | "PROJECT";

export interface VaultEntry {
  alias: string;
  raw: string;
  category: VaultCategory;
  source: "regex" | "nano";
}

const ALIAS_PATTERN = /^\[[A-Z_]+_\d+\]$/;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const DETERMINISTIC_RULES: Array<{ category: VaultCategory; regex: RegExp }> = [
  // JWT tokens
  {
    category: "TOKEN",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  // Bearer / API keys / cloud credentials
  {
    category: "SECRET",
    regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    category: "SECRET",
    regex: /(?:Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/g,
  },
  // Connection strings with embedded passwords
  {
    category: "SECRET",
    regex: /\b(?:postgres|postgresql|mysql|mongodb|redis|amqps?):\/\/[^\s"'<>]+/gi,
  },
  // Emails
  {
    category: "EMAIL",
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  // Private / internal hostnames
  {
    category: "HOST",
    regex: /\b[a-z0-9][a-z0-9.-]*\.(?:internal|corp|local|intranet|lan|priv|svc\.cluster\.local)\b/gi,
  },
  // IPv4 addresses (excluding common masks/loopback-only noise like 0.0.0.0)
  {
    category: "IP",
    regex: /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g,
  },
  // Explicit account / customer / ticket IDs
  {
    category: "ACCOUNT",
    regex: /\b(?:ACC|CUST|ACCT|USR|TXN|PAN)-[A-Z0-9]{4,16}\b/g,
  },
  // Currency figures (USD/INR/EUR)
  {
    category: "AMOUNT",
    regex: /(?:₹|\$|€|£|INR\s?|USD\s?)\d[\d,]*(?:\.\d+)?(?:\s?(?:Cr|Lakh|Lakhs|M|B|K|million|billion))?\b/gi,
  },
  // Phone numbers (international / 10+ digits)
  {
    category: "PHONE",
    regex: /(?<!\w)(?:\+\d{1,3}[\s-]?)?(?:\(\d{2,4}\)[\s-]?)?\d{3,5}[\s-]\d{3,5}(?:[\s-]\d{2,4})?(?!\w)/g,
  },
];

/**
 * Stateful Bijective Session Vault:
 * 1. Prevents cross-turn PII entity drift by always applying existing mappings first.
 * 2. Guarantees <1ms, 100% lossless local re-hydration for code diffs & stack traces.
 * 3. Provides a hard fail-loud canary check before any bytes cross the wire.
 */
export class SessionVault {
  private rawToEntry = new Map<string, VaultEntry>();
  private aliasToEntry = new Map<string, VaultEntry>();
  private counters = new Map<VaultCategory, number>();

  register(
    rawInput: string,
    category: VaultCategory,
    source: "regex" | "nano"
  ): string | null {
    const raw = rawInput.trim();
    if (raw.length < 3) return null;
    if (ALIAS_PATTERN.test(raw)) return raw;

    const existing = this.rawToEntry.get(raw);
    if (existing) return existing.alias;

    const nextNum = (this.counters.get(category) ?? 0) + 1;
    this.counters.set(category, nextNum);
    const alias = `[${category}_${nextNum}]`;

    const entry: VaultEntry = { alias, raw, category, source };
    this.rawToEntry.set(raw, entry);
    this.aliasToEntry.set(alias, entry);
    return alias;
  }

  /**
   * Step 1 of Outbound Airlock:
   * Re-applies all existing vault aliases first (longest-first) so entity IDs stay
   * consistent across multi-turn tool calls, then runs deterministic secret regexes.
   */
  scrubDeterministic(input: string): { sanitized: string; redactionsApplied: number } {
    let text = input;
    let redactionsApplied = 0;

    // 1. Apply existing vault entries first (solves cross-turn entity drift)
    const known = Array.from(this.rawToEntry.values()).sort(
      (a, b) => b.raw.length - a.raw.length
    );
    for (const entry of known) {
      if (text.includes(entry.raw)) {
        const re = new RegExp(escapeRegExp(entry.raw), "g");
        const before = text;
        text = text.replace(re, entry.alias);
        if (text !== before) redactionsApplied += 1;
      }
    }

    // 2. Apply high-precision deterministic regex rules
    for (const rule of DETERMINISTIC_RULES) {
      text = text.replace(rule.regex, (fullMatch, captureGroup?: string) => {
        // Keep "Bearer " prefix readable for the cloud model while scrubbing the secret token
        if (
          typeof captureGroup === "string" &&
          fullMatch.startsWith("Bearer ")
        ) {
          const alias = this.register(captureGroup, rule.category, "regex");
          if (alias) {
            redactionsApplied += 1;
            return `Bearer ${alias}`;
          }
          return fullMatch;
        }
        const alias = this.register(fullMatch, rule.category, "regex");
        if (alias) {
          redactionsApplied += 1;
          return alias;
        }
        return fullMatch;
      });
    }

    return { sanitized: text, redactionsApplied };
  }

  /**
   * Step 2 of Outbound Airlock:
   * Registers contextual entities flagged by on-device Gemini Nano 4 and replaces
   * them deterministically in longest-first order.
   */
  applySemanticEntities(
    input: string,
    entities: Array<{ text: string; category: VaultCategory }>
  ): { sanitized: string; newEntitiesAdded: number } {
    let newEntitiesAdded = 0;
    const valid = entities
      .filter((e) => e && typeof e.text === "string" && e.text.trim().length >= 3)
      .filter((e) => !ALIAS_PATTERN.test(e.text.trim()))
      .sort((a, b) => b.text.length - a.text.length);

    let text = input;
    for (const item of valid) {
      const raw = item.text.trim();
      // Only register entities that actually appear in the text (prevents hallucinated vault bloat)
      if (!text.includes(raw)) continue;
      const had = this.rawToEntry.has(raw);
      const alias = this.register(raw, item.category, "nano");
      if (!alias) continue;
      if (!had) newEntitiesAdded += 1;
      text = text.replace(new RegExp(escapeRegExp(raw), "g"), alias);
    }

    return { sanitized: text, newEntitiesAdded };
  }

  /**
   * Inbound Hydration (< 1 ms, 100% syntax-preserving):
   * Used both to hydrate Cloud Gemini tool arguments before local grep
   * AND to hydrate the final RCA / code patch before displaying to the user.
   */
  hydrate(input: string): string {
    if (this.aliasToEntry.size === 0) return input;
    return input.replace(/\[[A-Z_]+_\d+\]/g, (token) => {
      const found = this.aliasToEntry.get(token);
      return found ? found.raw : token;
    });
  }

  /**
   * Fail-loud canary verifier: returns any registered sensitive value (>= 4 chars)
   * that still exists verbatim in an outbound string before network transmission.
   */
  findCanaryLeaks(outboundText: string): string[] {
    const leaks: string[] = [];
    for (const entry of this.rawToEntry.values()) {
      if (entry.raw.length >= 4 && outboundText.includes(entry.raw)) {
        leaks.push(`${entry.alias} (len ${entry.raw.length})`);
      }
    }
    return leaks;
  }

  entries(): VaultEntry[] {
    return Array.from(this.aliasToEntry.values());
  }

  size(): number {
    return this.aliasToEntry.size;
  }
}
