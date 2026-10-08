import { describe, expect, it } from "vitest";
import { isSingleStatement } from "../src/mcp/tools/sql.js";

describe("isSingleStatement", () => {
  it.each([
    "SELECT 1",
    "SELECT 1;",
    "SELECT 1;  \n",
    "SELECT ';' AS semicolon",
    "SELECT 'it''s; fine'",
    "SELECT $$a;b$$",
    "SELECT $tag$a;$$b$tag$",
    "SELECT 1 -- ; DROP TABLE ideas",
    "SELECT /* ; DROP TABLE ideas */ 1",
    "SELECT 1; -- trailing comment",
  ])("accepts %j", (sql) => {
    expect(isSingleStatement(sql)).toBe(true);
  });

  it.each([
    "SELECT 1; SELECT 2",
    "SELECT 1;SELECT 2",
    "SELECT 'a'; DELETE FROM ideas",
    "SELECT 1; /* comment */ SELECT 2",
    "SELECT $$x$$; SELECT 2",
  ])("rejects %j", (sql) => {
    expect(isSingleStatement(sql)).toBe(false);
  });
});
