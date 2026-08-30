/**
 * Ask The Reserve — the rendering contract, client half.
 *
 * A column's NAME decides how it displays. The prompt names columns, the
 * coercion layer types them, this formats them:
 *
 *   _cents  -> currency          ($356.41)
 *   _at     -> date/time         (Aug 23, 2026)
 *   _id     -> a link on the record's name (the id column stays hidden)
 *
 * Extracted from the dock so it can be unit-tested: getting money or dates
 * wrong on screen is the failure mode most likely to be believed. A raw
 * 35641 reads as a plausible dollar figure, which is worse than an obvious
 * error.
 *
 * `_id` columns are CONSUMED, not displayed. The prompt asks the model to
 * select entity ids alongside their labels; the id becomes the href on the
 * name, and the column itself stays hidden — a 36-character UUID is noise,
 * and in a narrow dock it ate the widest column. So the id does real work
 * without ever being shown.
 *
 * Pairing rule: an entity id links the column immediately after it, plus
 * any further columns whose name ends in "name". So
 * `client_id, first_name, last_name, spend_cents` links both name cells and
 * stops at the money column, and `client_id, first_name, last_name, status`
 * does NOT turn a status into a link to a person — which "every following
 * text column" would have done. This works because the prompt asks for the
 * id to be selected next to what it identifies; a query that separates them
 * simply gets no link, which is the safe way to be wrong.
 */

/** Shown for a null/absent value. */
const EMPTY = "—";

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});
const dayOnly = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});
const dayAndTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export type ColumnKind = "currency" | "date" | "entity" | "text";

/**
 * Entity id columns that can become links, and the page they point at.
 * Deliberately an allowlist: an id with no page here (appointment_id,
 * service_id) is still hidden, just not linked. Guessing a route from a
 * column name would produce confident 404s.
 */
const ENTITY_ROUTES: Record<string, string> = {
  client_id: "/clients",
  staff_id: "/staff",
};

export interface ColumnLink {
  /** The hidden id column supplying the record id. */
  idColumn: string;
  /** Route base; the id is appended to it. */
  routeBase: string;
}

/**
 * A column as the TABLE renders it, which is not always a column as SQL
 * returned it. `first_name` and `last_name` are one person, so they become
 * one "Name" cell with one link — two adjacent links to the same record
 * read as two people and give the eye nothing to land on.
 */
export interface DisplayColumn {
  /** Stable key for rendering. */
  key: string;
  /** Header text. */
  label: string;
  /** Source columns composing this cell, joined with a space. */
  parts: string[];
  /** Right-aligned (money and counts). */
  numeric: boolean;
  /** The record this cell links to, if any. */
  link: ColumnLink | null;
}

/** Columns that are parts of a person's name: first_name, last_name, name. */
const NAME_PART = /(^|_)name$/;

export interface ColumnPlan {
  /** Columns to render, in order. */
  visible: string[];
  /** Columns present in the data but deliberately not rendered. */
  hidden: string[];
  kinds: Map<string, ColumnKind>;
  /**
   * Columns to right-align, so magnitudes line up on the decimal point and
   * can be compared down the column.
   *
   * Membership is decided on the VALUES being real numbers, not on them
   * merely looking numeric — a postal code like "02134" is text and stays
   * left-aligned, where an `asNumber`-style test would have pulled it right.
   * Currency is always included, since a `_cents` column may legitimately
   * hold numeric strings after a type slip.
   */
  numeric: Set<string>;
  /** Label column -> the entity whose page it links to. */
  links: Map<string, ColumnLink>;
  /**
   * What the table actually renders, after merging name parts. Iterate this
   * rather than `visible`; the two differ wherever a name was combined.
   */
  display: DisplayColumn[];
}

/** A value usable as a number — real number, or a string holding one. */
export function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * A value usable as a date. Timestamps cross the wire as ISO strings (JSON
 * has no date type), so that is the case that matters; Date and epoch
 * numbers are accepted for completeness.
 *
 * Bare numbers are NOT treated as epochs — a `_at` column holding 7 is far
 * more likely to be a miscounted alias than 1970.
 */
export function asDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Require something ISO-shaped rather than accepting whatever Date() will
  // swallow, so a stray string does not silently become a date.
  if (!/^\d{4}-\d{2}-\d{2}([T ]|$)/.test(trimmed)) return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** True when a timestamp carries no time of day (a `::date` cast, in UTC). */
function isMidnightUtc(d: Date): boolean {
  return (
    d.getUTCHours() === 0 &&
    d.getUTCMinutes() === 0 &&
    d.getUTCSeconds() === 0 &&
    d.getUTCMilliseconds() === 0
  );
}

/**
 * Classify every column once per result, so the header and the cells always
 * agree.
 *
 * A suffixed column only earns its treatment if EVERY value in it actually
 * fits — that is what keeps the label honest. A `_cents` column that cannot
 * format is not currency anywhere, so `columnLabel` leaves the suffix on and
 * the reader still sees the units. "Spend: 35641" strips the only clue that
 * the number is not dollars, which is how a wrong figure gets believed.
 */
export function planColumns(
  columns: string[],
  rows: Record<string, unknown>[],
): ColumnPlan {
  const kinds = new Map<string, ColumnKind>();
  const visible: string[] = [];
  const hidden: string[] = [];
  const numeric = new Set<string>();
  const links = new Map<string, ColumnLink>();
  let pending: ColumnLink | null = null;
  let linkedForPending = false;

  const everyValue = (column: string, ok: (v: unknown) => boolean) =>
    rows.every((row) => {
      const value = row[column];
      return value === null || value === undefined || ok(value);
    });

  for (const column of columns) {
    if (column.endsWith("_id")) {
      kinds.set(column, "entity");
      hidden.push(column); // consumed for the link, never displayed
      const routeBase = ENTITY_ROUTES[column];
      pending = routeBase ? { idColumn: column, routeBase } : null;
      linkedForPending = false;
      continue;
    }

    let kind: ColumnKind;
    if (column.endsWith("_cents") && everyValue(column, (v) => asNumber(v) !== null)) {
      kind = "currency";
      numeric.add(column);
    } else if (column.endsWith("_at") && everyValue(column, (v) => asDate(v) !== null)) {
      kind = "date";
    } else {
      kind = "text";
      // Counts and other plain numbers: right-align them too.
      if (rows.length && everyValue(column, (v) => typeof v === "number")) {
        numeric.add(column);
      }
    }
    kinds.set(column, kind);

    // The column right after an entity id is its label; further columns join
    // only if they are also name parts (first_name, last_name). That stops a
    // trailing `status` or `note` from becoming a link to a person.
    const isLabel = kind === "text" && !numeric.has(column);
    const joinsRun = !linkedForPending || /name$/.test(column);
    if (pending && isLabel && joinsRun) {
      links.set(column, pending);
      linkedForPending = true;
    } else {
      pending = null;
    }

    visible.push(column);
  }

  // --- second pass: what the table renders -------------------------------
  // Adjacent name parts belonging to the same record collapse into one
  // "Name" cell. A lone label (a `display_name as provider`) keeps its own
  // heading — merging is for names split across columns, not for renaming.
  const sameRecord = (a: string, b: string) =>
    (links.get(a)?.idColumn ?? null) === (links.get(b)?.idColumn ?? null);

  const display: DisplayColumn[] = [];
  for (let i = 0; i < visible.length; ) {
    const column = visible[i]!;
    const run = [column];

    if (NAME_PART.test(column)) {
      let j = i + 1;
      while (
        j < visible.length &&
        NAME_PART.test(visible[j]!) &&
        sameRecord(column, visible[j]!)
      ) {
        run.push(visible[j]!);
        j += 1;
      }
    }

    if (run.length > 1) {
      display.push({
        key: run.join("+"),
        label: "Name",
        parts: run,
        numeric: false,
        link: links.get(column) ?? null,
      });
      i += run.length;
    } else {
      display.push({
        key: column,
        label: labelFor(column, kinds.get(column) ?? "text"),
        parts: [column],
        numeric: numeric.has(column),
        link: links.get(column) ?? null,
      });
      i += 1;
    }
  }

  return { visible, hidden, kinds, numeric, links, display };
}

function labelFor(column: string, kind: ColumnKind): string {
  let base = column;
  if (kind === "currency") base = column.replace(/_cents$/, "");
  else if (kind === "date") base = column.replace(/_at$/, "");
  return base.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Header text. A suffix is stripped only when the column really renders that way. */
export function columnLabel(column: string, plan?: ColumnPlan): string {
  return labelFor(column, plan?.kinds.get(column) ?? "text");
}

/** Cell text, per the column's kind. */
export function formatCell(
  column: string,
  value: unknown,
  plan?: ColumnPlan,
): string {
  if (value === null || value === undefined) return EMPTY;
  const kind = plan?.kinds.get(column) ?? "text";

  if (kind === "currency") {
    const n = asNumber(value);
    if (n !== null) return money.format(n / 100);
  }

  if (kind === "date") {
    const d = asDate(value);
    // A `::date` cast arrives as midnight UTC. Formatting that in local time
    // shows the previous day west of Greenwich, so day-only values are
    // rendered in UTC. Values with a real time of day use local time.
    // (The full implementation should use the LOCATION's timezone — see the
    // rendering contract in docs/design/ask-the-reserve-design.md.)
    if (d) return isMidnightUtc(d) ? dayOnly.format(d) : dayAndTime.format(d);
  }

  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * The href for a label cell, or null when it is not a link.
 *
 * The id must be a non-empty string: a null id (an outer join with no match)
 * yields no link rather than a route ending in "null".
 */
export function cellHref(
  column: string,
  row: Record<string, unknown>,
  plan?: ColumnPlan,
): string | null {
  const link = plan?.links.get(column);
  if (!link) return null;
  const id = row[link.idColumn];
  if (typeof id !== "string" || id === "") return null;
  return `${link.routeBase}/${id}`;
}

/** The text of a display cell — merged columns join their parts with a space. */
export function cellValue(
  column: DisplayColumn,
  row: Record<string, unknown>,
  plan?: ColumnPlan,
): string {
  const parts = column.parts
    .map((part) => formatCell(part, row[part], plan))
    .filter((text) => text !== "" && text !== EMPTY);
  return parts.length ? parts.join(" ") : EMPTY;
}

/** The href for a display cell, or null when it does not link. */
export function cellLink(
  column: DisplayColumn,
  row: Record<string, unknown>,
): string | null {
  if (!column.link) return null;
  const id = row[column.link.idColumn];
  if (typeof id !== "string" || id === "") return null;
  return `${column.link.routeBase}/${id}`;
}
