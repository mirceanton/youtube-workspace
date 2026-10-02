// findTransactionControl: the lexer that keeps COMMIT/ROLLBACK out of migration files (a file runs
// in one transaction that the runner commits together with its schema_migrations row).
import { describe, expect, it } from "vitest";
import { findTransactionControl } from "../src/migrate.js";

describe("findTransactionControl", () => {
  it.each([
    ["COMMIT", "CREATE TABLE a (id int);\nCOMMIT;", [{ statement: "COMMIT", line: 2 }]],
    [
      "lower case and no final semicolon",
      "select 1;\n  rollback",
      [{ statement: "ROLLBACK", line: 2 }],
    ],
    [
      "every transaction keyword",
      "BEGIN; START TRANSACTION; SAVEPOINT a; RELEASE a; ROLLBACK TO a; END; ABORT; COMMIT AND CHAIN;",
      ["BEGIN", "START", "SAVEPOINT", "RELEASE", "ROLLBACK", "END", "ABORT", "COMMIT"].map(
        (statement) => ({ statement, line: 1 }),
      ),
    ],
    [
      "PREPARE TRANSACTION",
      "PREPARE TRANSACTION 'gid';",
      [{ statement: "PREPARE TRANSACTION", line: 1 }],
    ],
    [
      "a statement after comments",
      "-- note\n/* block\n comment */ COMMIT;",
      [{ statement: "COMMIT", line: 3 }],
    ],
    [
      "a statement after a closed E'' string",
      "SELECT E'it\\'s';\nEND;",
      [{ statement: "END", line: 2 }],
    ],
  ])("finds %s", (_label, sql, expected) => {
    expect(findTransactionControl(sql)).toEqual(expected);
  });

  it.each([
    ["plain statements", "CREATE TABLE a (id int);\nINSERT INTO a VALUES (1);"],
    ["keywords in strings", "SELECT 'COMMIT;', 'it''s; ROLLBACK';"],
    ["keywords in E'' strings", "SELECT E'\\'; COMMIT; \\\\';"],
    ["keywords in quoted identifiers", 'CREATE TABLE "COMMIT" (id int); SELECT "a;END" FROM b;'],
    ["keywords in line comments", "SELECT 1; -- COMMIT;\nSELECT 2;"],
    ["keywords in nested block comments", "/* outer /* inner; COMMIT; */ ROLLBACK; */ SELECT 1;"],
    [
      "PL/pgSQL blocks",
      "DO $$ BEGIN PERFORM 1; COMMIT; END $$;\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN RAISE NOTICE 'x'; END $body$;",
    ],
    ["dollar quotes containing other dollar signs", "SELECT $a$ $$ COMMIT; $$ $a$;"],
    ["END inside a statement", "SELECT CASE WHEN true THEN 1 END;"],
    ["PREPARE of a statement", "PREPARE q AS SELECT 1;"],
    ["parameters", "SELECT $1; SELECT 1"],
    ["an empty file", ""],
  ])("ignores %s", (_label, sql) => {
    expect(findTransactionControl(sql)).toEqual([]);
  });

  it("counts lines across strings, comments and dollar quotes", () => {
    const sql = "SELECT 'a\nb';\n/* c\nd */\nDO $$\nBEGIN\nEND\n$$;\nCOMMIT;";
    expect(findTransactionControl(sql)).toEqual([{ statement: "COMMIT", line: 9 }]);
  });

  it("reports the END of an SQL-standard function body, which needs $$ quoting instead", () => {
    const sql = "CREATE FUNCTION f() RETURNS int LANGUAGE sql\nBEGIN ATOMIC SELECT 1;\nEND;";
    expect(findTransactionControl(sql)).toEqual([{ statement: "END", line: 3 }]);
  });
});
