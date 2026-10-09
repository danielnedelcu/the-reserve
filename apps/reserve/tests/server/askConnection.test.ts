// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

/**
 * Ask The Reserve — the connection helper's guards.
 *
 * The point of these: the ask feature must FAIL CLOSED. With no
 * ASK_DATABASE_URL there is no ask_readonly connection, so there is no
 * safety boundary — and an ask must be refused rather than fall back to
 * anything. This asserts that by executing it, not by reading it.
 */

// The pg driver is never exercised here — these are the guards that run
// BEFORE a connection is ever opened. Stubbing it keeps the node-only
// driver out of the test environment.
vi.mock("pg", () => ({ default: { Pool: function MockPool() {} } }));

const { assertConnectionString, assertSingleSelect, sslFor } = await import(
  "../../server/utils/askConnection"
);

describe("sslFor: TLS for the hosted pooler, none for a local Postgres", () => {
  it.each([
    "postgresql://ask_readonly:pw@aws-0-us-west-1.pooler.supabase.com:6543/postgres",
    "postgresql://ask_readonly:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres",
  ])("asks for TLS on the hosted pooler and the hosted database (%s)", (dsn) => {
    expect(sslFor(dsn)).toEqual({ rejectUnauthorized: false });
  });

  it.each(["127.0.0.1", "localhost", "[::1]"])("sends no TLS to %s, which refuses it", (host) => {
    expect(sslFor(`postgresql://ask_readonly:pw@${host}:54322/postgres`)).toBe(false);
  });

  it("treats a string it cannot parse as remote", () => {
    expect(sslFor("not a url")).toEqual({ rejectUnauthorized: false });
  });
});

describe("fail closed without ASK_DATABASE_URL", () => {
  it("throws 503 when the value is undefined", () => {
    expect(() => assertConnectionString(undefined)).toThrowError(
      expect.objectContaining({ statusCode: 503 }),
    );
  });

  it("throws 503 when the value is empty", () => {
    expect(() => assertConnectionString("")).toThrowError(
      expect.objectContaining({ statusCode: 503 }),
    );
  });

  it("passes once a connection string is configured", () => {
    expect(() =>
      assertConnectionString("postgresql://ask_readonly:pw@host:5432/postgres"),
    ).not.toThrow();
  });
});

describe("assertSingleSelect", () => {
  it("accepts a plain SELECT and strips the trailing semicolon", () => {
    expect(assertSingleSelect("select 1;")).toBe("select 1");
  });

  it("accepts a CTE", () => {
    expect(assertSingleSelect("with x as (select 1) select * from x")).toContain(
      "with x",
    );
  });

  it("rejects a second statement", () => {
    expect(() => assertSingleSelect("select 1; drop table clients")).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects anything that is not a SELECT or WITH", () => {
    expect(() => assertSingleSelect("update clients set active = false")).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  it("rejects an empty statement", () => {
    expect(() => assertSingleSelect("   ")).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });

  // These checks are error quality, not security — the ask_readonly role is
  // the boundary. This documents the known false positive so nobody later
  // mistakes it for a hole being patched here.
  it("false-positives on a semicolon inside a string literal (accepted trade)", () => {
    expect(() => assertSingleSelect("select 'a;b'")).toThrowError(
      expect.objectContaining({ statusCode: 400 }),
    );
  });
});
