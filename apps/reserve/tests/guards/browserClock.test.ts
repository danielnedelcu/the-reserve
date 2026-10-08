// @vitest-environment node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The guard behind CLAUDE.md's business-time convention: nothing in app/
 * formats or buckets a time on the browser's clock. Business time goes
 * through shared/time/format.ts and period.ts in the location's zone;
 * date-only values go from the key to words without a Date; row counts
 * go through shared/format/count.ts. The next feature that reaches for
 * toLocaleTimeString fails here, naming the file and line, instead of
 * quietly drawing a New York appointment at a Los Angeles hour.
 *
 * Personal event time is allowed, file by file, each with its reason.
 * An allowlisted file that no longer matches fails too, so the list
 * cannot go stale.
 */

const APP = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../app");

const BANNED: { name: string; pattern: RegExp }[] = [
  { name: "toLocaleDateString", pattern: /\.toLocaleDateString\s*\(/ },
  { name: "toLocaleTimeString", pattern: /\.toLocaleTimeString\s*\(/ },
  { name: "toLocaleString", pattern: /\.toLocaleString\s*\(/ },
  { name: "Intl.DateTimeFormat", pattern: /Intl\.DateTimeFormat/ },
  {
    name: "Date getter/setter on the browser clock",
    pattern: /\.(get|set)(Day|Date|Hours|Minutes|Seconds|Milliseconds|Month|FullYear|Year|TimezoneOffset)\s*\(/,
  },
];

/** Files whose browser-clock use is PERSONAL event time, with the reason. */
const ALLOWED: Record<string, string> = {
  "pages/messages/[[id]].vue":
    "personal event time: when a message was sent (messageTime) and the conversation list's relative day ('Yesterday', 'Tue') are the viewer's own clock, per CLAUDE.md",
};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (/\.(vue|ts)$/.test(name)) yield full;
  }
}

const COMMENT = /^\s*(\/\/|\/\*|\*|<!--)/;

function scan(): { file: string; line: number; what: string }[] {
  const hits: { file: string; line: number; what: string }[] = [];
  for (const full of walk(APP)) {
    const file = relative(APP, full);
    const lines = readFileSync(full, "utf8").split("\n");
    lines.forEach((text, i) => {
      if (COMMENT.test(text)) return;
      for (const { name, pattern } of BANNED) {
        if (pattern.test(text)) hits.push({ file, line: i + 1, what: name });
      }
    });
  }
  return hits;
}

describe("app/ never formats or buckets a time on the browser's clock", () => {
  const hits = scan();

  it("has no browser-clock call outside the allowlist", () => {
    const offenders = hits.filter((h) => !(h.file in ALLOWED)).map((h) => `${h.file}:${h.line} — ${h.what}`);
    expect(offenders, `Use shared/time/format.ts (zone required), period.ts keys, or shared/format/count.ts:\n  ${offenders.join("\n  ")}`).toEqual([]);
  });

  it("every allowlisted file still needs its entry", () => {
    const stale = Object.keys(ALLOWED).filter((file) => !hits.some((h) => h.file === file));
    expect(stale, "allowlist entries with no remaining browser-clock use; remove them").toEqual([]);
  });

  it("scans the app (a scan that finds nothing to look at proves nothing)", () => {
    expect([...walk(APP)].length).toBeGreaterThan(50);
    expect(hits.length).toBeGreaterThan(0); // the messaging thread's personal time
  });
});
