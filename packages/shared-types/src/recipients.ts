/**
 * Shared, dependency-light parsing utilities.
 * Used by the API (uploads endpoint), the worker (tests), and mirrored in web tests.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalize a candidate address: trim, strip mailto:, lower-case. */
export function normalizeEmail(raw: string): string {
  let v = raw.trim();
  if (v.toLowerCase().startsWith("mailto:")) v = v.slice(7);
  // "Name <addr@x.com>" → addr@x.com
  const angle = v.match(/<([^>]+)>/);
  if (angle) v = angle[1];
  return v.trim().toLowerCase();
}

export function isValidEmail(v: string): boolean {
  return v.length <= 254 && EMAIL_RE.test(v);
}

/**
 * Parse a CSV/text blob of recipients (FR-30, PRD edge case: "CSV contains
 * duplicate or malformed addresses — deduplicated and validated before
 * scheduling; skipped rows are reported back to the user").
 *
 * Accepts comma/newline/semicolon-separated values and CSV rows with
 * quoted fields. Returns deduplicated valid addresses plus skip feedback.
 */
export function parseRecipients(
  text: string
): { valid: string[]; invalid: string[]; duplicatesSkipped: number } {
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  let duplicatesSkipped = 0;

  // Split into candidate tokens on newlines, semicolons, and commas that are
  // not inside quotes. Handles CSV rows like `Doe, Jane",jane@x.com` too.
  const tokens = splitTokens(text);

  for (const token of tokens) {
    const email = normalizeEmail(token);
    if (email.length === 0) continue; // empty cell / blank line
    if (!isValidEmail(email)) {
      if (invalid.length < 100) invalid.push(token.trim().slice(0, 120));
      continue;
    }
    if (seen.has(email)) {
      duplicatesSkipped++;
      continue;
    }
    seen.add(email);
    valid.push(email);
  }

  return { valid, invalid, duplicatesSkipped };
}

function splitTokens(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && (ch === "," || ch === ";" || ch === "\n" || ch === "\r")) {
      tokens.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  tokens.push(current);
  return tokens;
}

/** Format a delay in ms humanly, for UI and logs. */
export function formatDelay(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${Math.floor(s % 60)}s`;
}
