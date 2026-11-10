/**
 * Bulk key input parsing.
 *
 * Dependency free so it can be unit tested under plain Node, and so the admin
 * UI's documented textarea format has exactly one implementation.
 */

export interface ParsedKey {
  secret: string;
  label?: string;
}

/**
 * Parse a bulk key paste.
 *
 * One key per line. An optional note follows the key after a comma:
 *
 *   tvly-abc123,小号一号
 *   tvly-def456,备用
 *   tvly-ghi789
 *
 * A line without a comma is just a key. Blank lines and lines starting with
 * `#` are skipped, so a pasted column with a header still works.
 * Array input is accepted too, both as strings and as `{secret,label}` objects.
 */
export function parseKeyInput(input: unknown): ParsedKey[] {
  const lines: string[] = [];

  if (Array.isArray(input)) {
    for (const item of input) {
      if (typeof item === "string") {
        lines.push(...item.split(/\r?\n/));
        continue;
      }
      if (item && typeof item === "object") {
        const obj = item as { secret?: unknown; key?: unknown; label?: unknown; note?: unknown };
        const secret = String(obj.secret ?? obj.key ?? "").trim();
        if (!secret) continue;
        const label = String(obj.label ?? obj.note ?? "").trim();
        lines.push(label ? `${secret},${label}` : secret);
      }
    }
  } else if (typeof input === "string") {
    lines.push(...input.split(/\r?\n/));
  }

  const out: ParsedKey[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const comma = line.indexOf(",");
    if (comma === -1) {
      out.push({ secret: line });
      continue;
    }

    const secret = line.slice(0, comma).trim();
    if (!secret) continue;
    const label = line.slice(comma + 1).trim();
    out.push(label ? { secret, label } : { secret });
  }

  return out;
}
