// Global full-text search (migration 0063, T15): search_all over idea titles, idea pitches and the
// latest script revisions. Ranking, the restriction to the resources the caller passes, hostile and
// garbage query text, the limit, the snippet (markers, length, forgery), privileges and the caller's
// own rights.
import { RESOURCES } from "@ytw/shared/constants";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APP_ROLES, withActor } from "../src/client.js";
import { ValidationError } from "../src/errors.js";
import { archiveIdea } from "../src/ideas.js";
import {
  SEARCH_HIGHLIGHT_START,
  SEARCH_HIGHLIGHT_STOP,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SEARCH_QUERY_MAX_CHARS,
  SEARCH_RESOURCES,
  SEARCH_SNIPPET_MAX_CHARS,
  searchAll,
  snippetSegments,
  type SearchHit,
  type SearchResource,
} from "../src/search.js";
import { saveScriptVersion, type ScriptRecord } from "../src/scripts.js";
import { createTestDb, type TestDb } from "../src/testing.js";
import {
  act,
  alice,
  expectedNullOutcomes,
  functionPrivileges,
  newAgent,
  newIdea,
  nullArgumentOutcomes,
  type FunctionSpec,
} from "./content-helpers.js";
import { sqlstate } from "./helpers.js";
import { rejectedWith } from "./video-helpers.js";

let db: TestDb;
const writer = newAgent("search-writer");

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.drop();
});

const BOTH: readonly SearchResource[] = ["ideas", "scripts"];

/** A word that exists nowhere else in the database, so a test's hits are exactly its own records. */
const token = (): string => `qz${randomBytes(5).toString("hex")}`;

const search = (query: string, resources: readonly SearchResource[] = BOTH, limit?: number) =>
  searchAll(db.pool("ytw_web"), { query, resources, ...(limit === undefined ? {} : { limit }) });

const idea = (title: string, pitch?: string) =>
  newIdea(db, { title, ...(pitch === undefined ? {} : { pitch }) });

const nextVersion = new Map<string, Record<string, number>>();
/** Saves the next version of an idea's script (or packaging) through the real function. */
async function script(
  ideaId: string,
  body: string,
  kind: "script" | "packaging" = "script",
): Promise<ScriptRecord> {
  const versions = nextVersion.get(ideaId) ?? {};
  const base = versions[kind] ?? 0;
  const saved = await act(db, writer, (tx) =>
    saveScriptVersion(tx, { ideaId, kind, baseVersion: base, bodyMd: body }),
  );
  nextVersion.set(ideaId, { ...versions, [kind]: saved.version });
  return saved;
}

/** Asserts the properties every snippet must have, whatever it matched. */
function expectWellFormed(snippet: string): void {
  const characters = [...snippet];
  expect(characters.length).toBeLessThanOrEqual(SEARCH_SNIPPET_MAX_CHARS);
  expect(
    characters.some((character) => (character.codePointAt(0) ?? 0) < 32 || character === "\u007f"),
  ).toBe(false);
  expect(snippet).toBe(snippet.trim());
  expect(snippet).not.toMatch(/ {2}/);
  // Markers come in pairs and never nest.
  let open = false;
  let violations = 0;
  for (const character of characters) {
    if (character === SEARCH_HIGHLIGHT_START) {
      violations += open ? 1 : 0;
      open = true;
    } else if (character === SEARCH_HIGHLIGHT_STOP) {
      violations += open ? 0 : 1;
      open = false;
    }
  }
  expect(violations).toBe(0);
  expect(open).toBe(false);
}

/** The ids of the hits, sorted (for comparisons that do not depend on the ranking). */
const ids = (hits: SearchHit[]): string[] => hits.map((hit) => hit.id).toSorted();

/** The entity types of the hits, sorted. */
const kinds = (hits: SearchHit[]): string[] => hits.map((hit) => hit.entityType).toSorted();

const highlighted = (snippet: string): string[] =>
  snippetSegments(snippet)
    .filter((segment) => segment.highlight)
    .map((segment) => segment.text);

// ---------------------------------------------------------------------------------------------
describe("what is found", () => {
  it("finds an idea by its title and returns the documented hit", async () => {
    const t = token();
    const created = await idea(`A note on ${t} in titles`);
    const hits = await search(t);
    expect(hits).toHaveLength(1);
    const [hit] = hits;
    expect(hit).toMatchObject({
      entityType: "idea",
      id: created.id,
      ideaId: created.id,
      kind: null,
      version: null,
      title: `A note on ${t} in titles`,
    });
    expect(hit?.rank).toBeGreaterThan(0);
    expect(highlighted(hit?.snippet ?? "")).toEqual([t]);
    expectWellFormed(hit?.snippet ?? "");
  });

  it("finds an idea by its pitch, with the match highlighted in context", async () => {
    const t = token();
    const created = await idea(
      "Plain title",
      `Long ago we found ${t} hidden in the pitch of this idea.`,
    );
    const [hit] = await search(t);
    expect(hit).toMatchObject({ entityType: "idea", id: created.id, title: "Plain title" });
    expect(highlighted(hit?.snippet ?? "")).toEqual([t]);
    expect(hit?.snippet).toContain("hidden in the pitch");
  });

  it("finds a script body and names the revision, its kind and its idea", async () => {
    const t = token();
    const owner = await idea("The owner of a script");
    const saved = await script(owner.id, `# Intro\n\nToday we talk about ${t} for a while.`);
    const hits = await search(t);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      entityType: "script",
      id: saved.id,
      ideaId: owner.id,
      kind: "script",
      version: 1,
      title: "The owner of a script",
    });
    expect(highlighted(hits[0]?.snippet ?? "")).toEqual([t]);
    expect(hits[0]?.snippet).toContain("Today we talk about");
  });

  it("returns the script and the packaging doc of one idea as separate hits", async () => {
    const t = token();
    const owner = await idea("Two documents");
    const body = await script(owner.id, `The script mentions ${t}.`);
    const packaging = await script(owner.id, `The packaging mentions ${t} too.`, "packaging");
    const hits = await search(t, ["scripts"]);
    expect(hits.map((hit) => [hit.kind, hit.id]).toSorted()).toEqual(
      [
        ["script", body.id],
        ["packaging", packaging.id],
      ].toSorted(),
    );
  });

  it("searches only the latest revision of each (idea, kind)", async () => {
    const [oldWord, newWord] = [token(), token()];
    const owner = await idea("Revised idea");
    await script(owner.id, `Version one talks about ${oldWord}.`);
    const second = await script(owner.id, `Version two talks about ${newWord} instead.`);
    expect((await search(oldWord)).map((hit) => hit.id)).toEqual([]);
    const hits = await search(newWord);
    expect(hits.map((hit) => [hit.id, hit.version])).toEqual([[second.id, 2]]);
    // A third revision that drops the word makes it unfindable again.
    await script(owner.id, "Version three says something else entirely.");
    expect(await search(newWord)).toEqual([]);
  });

  it("returns one hit per document however many revisions mention the word", async () => {
    const t = token();
    const owner = await idea("Always the same word");
    await script(owner.id, `First: ${t}`);
    await script(owner.id, `Second: ${t}`);
    const third = await script(owner.id, `Third: ${t}`);
    const hits = await search(t);
    expect(hits.map((hit) => [hit.id, hit.version])).toEqual([[third.id, 3]]);
  });

  it("leaves out archived ideas and their scripts, and finds them nowhere else either", async () => {
    const t = token();
    const kept = await idea(`Kept ${t}`);
    const gone = await idea(`Gone ${t}`);
    await script(gone.id, `A script of the archived idea: ${t}`);
    expect(await search(t)).toHaveLength(3);
    await act(db, alice, (tx) => archiveIdea(tx, { id: gone.id }));
    const hits = await search(t);
    expect(hits.map((hit) => hit.id)).toEqual([kept.id]);
    expect(await search(t, ["scripts"])).toEqual([]);
  });

  it("includes dropped and published ideas (they are live, just finished)", async () => {
    const t = token();
    const dropped = await idea(`Dropped ${t}`);
    await withActor(db.admin, alice, (tx) =>
      tx.query("UPDATE ideas SET status = 'dropped' WHERE id = $1", [dropped.id]),
    );
    expect((await search(t)).map((hit) => hit.id)).toEqual([dropped.id]);
  });

  it("uses the english configuration: stemming, case folding, stop words", async () => {
    const t = token();
    await idea(`Testing ${t} thumbnails`, "Retention curves for the audience");
    expect(await search(`${t} THUMBNAIL`)).toHaveLength(1); // plural vs singular, case
    expect(await search(`${t} thumbnailed`)).toHaveLength(1); // same stem
    expect(await search(`${t} retentions`)).toHaveLength(1); // the pitch word, plural
    expect(await search("the of and")).toEqual([]); // only stop words
  });

  it("understands the web-search syntax: phrases, or, and exclusion", async () => {
    const [a, b] = [token(), token()];
    const both = await idea(`${a} ${b}`);
    const onlyA = await idea(`${a} alone`);
    const onlyB = await idea(`${b} alone`);
    const reversed = await idea(`${b} then ${a}`);
    expect(ids(await search(`${a} ${b}`))).toEqual([both.id, reversed.id].toSorted()); // and
    expect(ids(await search(`${a} or ${b}`))).toEqual(
      [both.id, onlyA.id, onlyB.id, reversed.id].toSorted(),
    );
    expect(ids(await search(`${a} -${b}`))).toEqual([onlyA.id]); // exclusion
    expect(ids(await search(`"${a} ${b}"`))).toEqual([both.id]); // phrase, in order
  });

  it("finds unicode text and treats a missing pitch as empty", async () => {
    const t = token();
    const created = await idea(`Café 日本語 ${t}`); // no pitch
    expect((await search(t)).map((hit) => hit.id)).toEqual([created.id]);
    expect((await search("café"))[0]?.entityType).toBe("idea");
  });

  it("answers the same through both service roles", async () => {
    const t = token();
    await idea(`Both roles ${t}`);
    const viaMcp = await searchAll(db.pool("ytw_mcp"), { query: t, resources: BOTH });
    const viaWeb = await search(t);
    expect(viaMcp).toEqual(viaWeb);
    expect(viaWeb).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe("ranking", () => {
  it("puts a title match above a pitch match above a script body match", async () => {
    const t = token();
    const inBody = await idea("Gamma entry");
    await script(inBody.id, `Only the script says ${t}`);
    const inPitch = await idea("Beta entry", `Only the pitch says ${t}`);
    const inTitle = await idea(`Alpha entry ${t}`);
    const hits = await search(t);
    expect(hits.map((hit) => hit.id)).toEqual([
      inTitle.id,
      inPitch.id,
      hits.find((hit) => hit.entityType === "script")?.id,
    ]);
    const [first, second, third] = hits.map((hit) => hit.rank);
    expect(first).toBeGreaterThan(second ?? Infinity);
    expect(second).toBeGreaterThan(third ?? Infinity);
    expect(third).toBeGreaterThan(0);
  });

  it("puts more occurrences above fewer in a field of the same weight and length", async () => {
    const t = token();
    const once = await idea("Once", `${t} filler filler filler filler filler`);
    const thrice = await idea("Thrice", `${t} ${t} ${t} filler filler filler`);
    const hits = await search(t);
    expect(hits.map((hit) => hit.id)).toEqual([thrice.id, once.id]);
    expect(hits[0]?.rank).toBeGreaterThan(hits[1]?.rank ?? Infinity);
  });

  it("orders equal ranks the same way every time (entity type, then id)", async () => {
    const t = token();
    const [a, b, c] = [await idea(`Twin ${t}`), await idea(`Twin ${t}`), await idea(`Twin ${t}`)];
    const expected = [a.id, b.id, c.id].toSorted();
    for (let round = 0; round < 3; round += 1) {
      const hits = await search(t);
      expect(hits.map((hit) => hit.id)).toEqual(expected);
      expect(new Set(hits.map((hit) => hit.rank)).size).toBe(1);
    }
  });

  it("breaks ties by id, whatever the order the rows were written in, also at the limit", async () => {
    const t = token();
    const prefix = "00000000-0000-7000-8000-0000000000";
    const tied = ["c5", "c4", "c3", "c2", "c1"].map((suffix) => `${prefix}${suffix}`);
    // Written in descending id order, so the order on disk is the opposite of the expected one.
    await withActor(db.admin, alice, (tx) =>
      tx.query(`INSERT INTO ideas (id, title) SELECT unnest($1::uuid[]), $2`, [tied, `Tie ${t}`]),
    );
    const expected = tied.toReversed();
    expect((await search(t)).map((hit) => hit.id)).toEqual(expected);
    // A limit that cuts through the tie keeps the smallest ids, not an arbitrary subset.
    expect((await search(t, BOTH, 3)).map((hit) => hit.id)).toEqual(expected.slice(0, 3));
  });

  it("returns the best matches first, with ranks that never increase", async () => {
    const t = token();
    await idea(`${t}`, `${t} ${t}`);
    await idea("Only a pitch", `${t}`);
    await idea("Another", `no match here but ${t} ${t} ${t} ${t}`);
    const ranks = (await search(t)).map((hit) => hit.rank);
    expect(ranks).toEqual(ranks.toSorted((x, y) => y - x));
    expect(ranks.every((rank) => rank > 0 && rank < 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the resources the caller may read", () => {
  it("searches ideas only, scripts only, or both, and nothing for an empty list", async () => {
    const t = token();
    const withBoth = await idea(`Restricted ${t}`, `pitch ${t}`);
    const saved = await script(withBoth.id, `body ${t}`);
    expect(kinds(await search(t, ["ideas"]))).toEqual(["idea"]);
    expect(kinds(await search(t, ["scripts"]))).toEqual(["script"]);
    expect(kinds(await search(t, ["scripts", "ideas"]))).toEqual(["idea", "script"]);
    expect(kinds(await search(t, ["ideas", "ideas", "scripts"]))).toEqual(["idea", "script"]);
    expect(await search(t, [])).toEqual([]);
    expect((await search(t, ["scripts"]))[0]?.id).toBe(saved.id);
  });

  it("does not hand out idea data to a caller that may read scripts only", async () => {
    const t = token();
    const secretTitle = `Confidential title ${token()}`;
    const secretPitch = `Confidential pitch ${token()}`;
    const owner = await idea(secretTitle, secretPitch);
    await script(owner.id, `The script itself talks about ${t}.`);
    const hits = await search(t, ["scripts"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.title).toBeNull();
    const everything = JSON.stringify(hits);
    expect(everything).not.toContain(secretTitle);
    expect(everything).not.toContain(secretPitch);
    // Searching the pitch with scripts only finds nothing: that text is idea data.
    expect(await search(secretPitch, ["scripts"])).toEqual([]);
    // With ideas allowed too, the title is there.
    expect((await search(t, BOTH))[0]?.title).toBe(secretTitle);
  });

  it("does not return script bodies to a caller that may read ideas only", async () => {
    const t = token();
    const owner = await idea("An idea with a secret script");
    await script(owner.id, `Hidden ${t}`);
    expect(await search(t, ["ideas"])).toEqual([]);
  });

  it("refuses a missing, unknown or malformed list with the valid names", async () => {
    const bad: unknown[] = [
      undefined,
      null,
      "ideas",
      ["videos"],
      ["Ideas"],
      ["ideas", "notes"],
      [null],
      [""],
      [1],
    ];
    for (const resources of bad) {
      const err = await rejectedWith(
        searchAll(db.pool("ytw_web"), { query: "x", resources: resources as never }),
        ValidationError,
      );
      expect(err.field).toBe("resources");
      expect(err.allowed).toEqual([...SEARCH_RESOURCES]);
      expect(err.message).toContain('"ideas"');
      expect(err.message).toContain('"scripts"');
    }
    // The database says the same when it is called directly (a service that skipped the wrapper).
    expect(await sqlstate(db.pool("ytw_web").query("SELECT * FROM search_all('x', 5, NULL)"))).toBe(
      "YT001",
    );
    expect(
      await sqlstate(
        db.pool("ytw_web").query("SELECT * FROM search_all('x', 5, ARRAY['ideas', 'videos'])"),
      ),
    ).toBe("YT001");
    expect(
      await sqlstate(
        db.pool("ytw_web").query("SELECT * FROM search_all('x', 5, ARRAY['ideas', NULL])"),
      ),
    ).toBe("YT001");
  });

  it("does not echo a hostile resource name in full", async () => {
    const hostile = `ideas'; DROP TABLE ideas; --${"y".repeat(500)}`;
    const failure = await db
      .pool("ytw_web")
      .query("SELECT * FROM search_all('x', 5, ARRAY[$1::text])", [hostile])
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "YT001" });
    const message = (failure as Error).message;
    expect(message.length).toBeLessThan(300);
    expect(message).not.toContain("y".repeat(100));
    // And nothing was dropped.
    const { rows } = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM ideas");
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  it("names exactly the searchable resources of RESOURCES", () => {
    for (const resource of SEARCH_RESOURCES) {
      expect(RESOURCES).toContain(resource);
    }
    expect(SEARCH_RESOURCES).toEqual(["ideas", "scripts"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("garbage and hostile query text", () => {
  const long = "word ".repeat(30_000); // 150 000 characters

  const queries: Record<string, string> = {
    empty: "",
    spaces: "     ",
    "tabs and newlines": "\t\n\r\n",
    bang: "!!!",
    "single quote": "'",
    "double quote": '"',
    "empty quotes": '""',
    "unclosed phrase": '"never closed',
    backslash: "\\",
    "open paren": "(",
    "close paren": ")",
    "many parens": "((((((((((((",
    ampersands: "&&&&",
    pipes: "||||",
    "operators only": "& | ! <-> :*",
    "operator soup": "a & | b !! c <-> <-> d",
    "prefix match": "foo:*",
    "bare prefix": ":*",
    dashes: "- - - --",
    minus: "-",
    or: "or",
    "many or": "OR OR OR OR",
    "stop words": "the and of to a",
    "sql injection": "'; DROP TABLE ideas; --",
    "sql injection 2": "x') OR 1=1; DELETE FROM scripts; --",
    percent: "%",
    underscore: "_",
    wildcards: "%_%",
    "like escape": "\\%\\_",
    emoji: "\u{1F600}\u{1F680}",
    rtl: "שלום مرحبا",
    "zero width": "a​b⁠c",
    digits: "1 2 3 4 5",
    "tsquery syntax": "'a' & 'b' | !'c'",
    "very long": long,
    "one huge token": "x".repeat(100_000),
    "5000 terms": Array.from({ length: 5000 }, (_, i) => `term${String(i)}`).join(" "),
    html: "<script>alert(1)</script>",
    control: "\u0001\u0002\u001f",
    "line separator": "a b c",
  };

  for (const [name, query] of Object.entries(queries)) {
    it(`answers without an error: ${name}`, async () => {
      const hits = await search(query);
      expect(Array.isArray(hits)).toBe(true);
      for (const hit of hits) {
        expectWellFormed(hit.snippet);
      }
      // The same through the raw function as the MCP role.
      const { rows } = await db
        .pool("ytw_mcp")
        .query("SELECT * FROM public.search_all($1, 50, ARRAY['ideas', 'scripts'])", [query]);
      expect(rows.length).toBeLessThanOrEqual(SEARCH_LIMIT_MAX);
    });
  }

  it("treats NULL like an empty query", async () => {
    const { rows } = await db
      .pool("ytw_web")
      .query("SELECT * FROM search_all(NULL, 20, ARRAY['ideas'])");
    expect(rows).toEqual([]);
  });

  it("keeps working after all of that: nothing was dropped or deleted", async () => {
    const t = token();
    const created = await idea(`Still here ${t}`);
    expect((await search(t)).map((hit) => hit.id)).toEqual([created.id]);
    for (const table of ["ideas", "scripts", "events"]) {
      const { rows } = await db.admin.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table}`,
      );
      expect(rows[0]?.n).toBeGreaterThan(0);
    }
  });

  it("refuses text the database cannot store with a validation error instead of a driver error", async () => {
    const err = await rejectedWith(search("a\u0000b"), ValidationError);
    expect(err.field).toBe("query");
    const notText = await rejectedWith(
      searchAll(db.pool("ytw_web"), { query: 42 as never, resources: BOTH }),
      ValidationError,
    );
    expect(notText.field).toBe("query");
  });

  it("uses only the first characters of a very long query", async () => {
    const t = token();
    await idea(`Findable ${t}`);
    const inside = `${" ".repeat(SEARCH_QUERY_MAX_CHARS - t.length)}${t}`; // ends at the limit
    expect(inside).toHaveLength(SEARCH_QUERY_MAX_CHARS);
    expect(await search(inside)).toHaveLength(1);
    const outside = `${" ".repeat(SEARCH_QUERY_MAX_CHARS - t.length + 1)}${t}`; // its last character is cut
    expect(await search(outside)).toEqual([]);
    const huge = `${t} ${"filler ".repeat(1_000_000)}`; // 7 MB
    const started = performance.now();
    expect(await search(huge)).toEqual([]); // 'filler' is not in any document
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("never lets a query reach the SQL text: the function is parameterized end to end", async () => {
    const before = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM ideas");
    await search("'); UPDATE ideas SET title = 'pwned'; --");
    const { rows } = await db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM ideas WHERE title = 'pwned'",
    );
    expect(rows[0]?.n).toBe(0);
    const after = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM ideas");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the limit", () => {
  it("returns at most the limit, the best first, 20 by default and 50 at most", async () => {
    const t = token();
    await withActor(db.admin, alice, (tx) =>
      tx.query(
        `INSERT INTO ideas (title, pitch)
         SELECT $1 || ' number ' || g, CASE WHEN g <= 3 THEN $1 || ' ' || $1 || ' ' || $1 END
           FROM generate_series(1, 60) g`,
        [t],
      ),
    );
    expect(await search(t)).toHaveLength(SEARCH_LIMIT_DEFAULT);
    expect(await search(t, BOTH, 5)).toHaveLength(5);
    expect(await search(t, BOTH, 1)).toHaveLength(1);
    expect(await search(t, BOTH, SEARCH_LIMIT_MAX)).toHaveLength(SEARCH_LIMIT_MAX);
    // The best three (the ones that also have the word in the pitch) come first.
    const top = await search(t, BOTH, 5);
    const numbers = top.slice(0, 3).map((hit) => Number(/number (\d+)/.exec(hit.title ?? "")?.[1]));
    expect(numbers.toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(top[2]?.rank).toBeGreaterThan(top[3]?.rank ?? Infinity);
  });

  it("refuses limits outside 1 to 50 and says what is valid", async () => {
    for (const limit of [0, -1, 51, 1000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      const err = await rejectedWith(search("x", BOTH, limit), ValidationError);
      expect(err.field).toBe("limit");
      expect(err.message).toContain("1 to 50");
    }
    // Straight to the database: the same rule, with the bounds in DETAIL for programs.
    const failure = await db
      .pool("ytw_web")
      .query("SELECT * FROM search_all('x', 51, ARRAY['ideas'])")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "YT001" });
    expect(JSON.parse((failure as { detail: string }).detail)).toMatchObject({
      field: "limit",
      value: 51,
      min: 1,
      max: SEARCH_LIMIT_MAX,
    });
    expect(
      await sqlstate(db.pool("ytw_web").query("SELECT * FROM search_all('x', 0, ARRAY['ideas'])")),
    ).toBe("YT001");
    expect(
      await sqlstate(db.pool("ytw_web").query("SELECT * FROM search_all('x', -5, ARRAY['ideas'])")),
    ).toBe("YT001");
  });

  it("treats a NULL limit as the default", async () => {
    const t = token();
    await withActor(db.admin, alice, (tx) =>
      tx.query("INSERT INTO ideas (title) SELECT $1 || ' ' || g FROM generate_series(1, 30) g", [
        t,
      ]),
    );
    const { rows } = await db
      .pool("ytw_web")
      .query("SELECT * FROM search_all($1, NULL, ARRAY['ideas'])", [t]);
    expect(rows).toHaveLength(SEARCH_LIMIT_DEFAULT);
  });
});

// ---------------------------------------------------------------------------------------------
describe("the snippet", () => {
  it("wraps the matched words, in their original spelling, in the two marker characters", async () => {
    const t = token();
    const owner = await idea("Snippet owner");
    await script(
      owner.id,
      `Some text before. The ${t} is discussed here, and ${t.toUpperCase()} again.`,
    );
    const [hit] = await search(t, ["scripts"]);
    expect(hit?.snippet).toContain(SEARCH_HIGHLIGHT_START);
    expect(hit?.snippet).toContain(SEARCH_HIGHLIGHT_STOP);
    const words = highlighted(hit?.snippet ?? "");
    expect(words.length).toBeGreaterThanOrEqual(2);
    expect(words.map((word) => word.toLowerCase())).toEqual(words.map(() => t));
    expectWellFormed(hit?.snippet ?? "");
    // The constants of the TypeScript side are the characters the database uses.
    expect(SEARCH_HIGHLIGHT_START).toBe("⟦");
    expect(SEARCH_HIGHLIGHT_STOP).toBe("⟧");
  });

  it("is plain text: whitespace and control characters collapse to single spaces", async () => {
    const t = token();
    const owner = await idea("Whitespace owner");
    await script(owner.id, `Line one\n\n\tline   two\r\n${t}\u0007 bell\u000b and more\u0085text.`);
    const [hit] = await search(t, ["scripts"]);
    expectWellFormed(hit?.snippet ?? "");
    expect(hit?.snippet).toContain(`${SEARCH_HIGHLIGHT_START}${t}${SEARCH_HIGHLIGHT_STOP}`);
    expect(hit?.snippet).not.toContain("\n");
  });

  it("is at most 400 characters, markers included, for any text", async () => {
    const t = token();
    const owner = await idea("Length owner");
    await script(
      owner.id,
      `${"lorem ipsum dolor sit amet ".repeat(1500)} ${t} ${"consectetur ".repeat(5000)}`,
    );
    const hits = await search(t, ["scripts"]);
    expect(hits).toHaveLength(1);
    expectWellFormed(hits[0]?.snippet ?? "");
    expect([...(hits[0]?.snippet ?? "")].length).toBeLessThanOrEqual(SEARCH_SNIPPET_MAX_CHARS);
    expect(highlighted(hits[0]?.snippet ?? "")).toEqual([t]);
  });

  it("cuts a passage of enormous words at 400 characters and still closes the highlight", async () => {
    const huge = `q${"z".repeat(899)}`; // one 900 character word: indexable, and the whole query
    const owner = await idea("Huge word owner");
    await script(owner.id, `before ${huge} after`);
    const [hit] = await search(huge, ["scripts"]);
    expect(hit).toBeDefined();
    expectWellFormed(hit?.snippet ?? "");
    // It was cut inside the highlighted word, so the database appended the missing closing marker.
    expect([...(hit?.snippet ?? "")]).toHaveLength(SEARCH_SNIPPET_MAX_CHARS);
    expect(hit?.snippet.endsWith(SEARCH_HIGHLIGHT_STOP)).toBe(true);
    expect(highlighted(hit?.snippet ?? "")).toHaveLength(1);
  });

  it("cannot be forged: marker characters in the author's text are removed", async () => {
    const t = token();
    const owner = await idea(
      `Forger ${SEARCH_HIGHLIGHT_START}fake title${SEARCH_HIGHLIGHT_STOP}`,
      `Pitch ${SEARCH_HIGHLIGHT_STOP}${SEARCH_HIGHLIGHT_START} ${t}`,
    );
    await script(
      owner.id,
      `Body with ${SEARCH_HIGHLIGHT_START}forged${SEARCH_HIGHLIGHT_STOP} marks and ${t}${SEARCH_HIGHLIGHT_STOP}${SEARCH_HIGHLIGHT_START}.`,
    );
    for (const hit of await search(t)) {
      expectWellFormed(hit.snippet);
      expect(highlighted(hit.snippet)).toEqual([t]);
      expect(hit.snippet).not.toContain("forged⟧"); // the author's pair is gone
    }
    // Searching for the forged words finds the texts, but the markers around them are the database's.
    const forged = await search("forged", ["scripts"]);
    expect(forged.flatMap((hit) => highlighted(hit.snippet))).toEqual(["forged"]);
  });

  it("leaves markup in the author's text as text: the UI escapes, the snippet does not pretend to", async () => {
    const t = token();
    const owner = await idea("Markup owner");
    await script(
      owner.id,
      `Plain & <b>bold</b> and a lone < sign, then ${t} &amp; "quotes" 'single'.`,
    );
    const [hit] = await search(t, ["scripts"]);
    expectWellFormed(hit?.snippet ?? "");
    expect(hit?.snippet).toContain("&");
    expect(highlighted(hit?.snippet ?? "")).toEqual([t]);
    // snippetSegments hands back raw text pieces: rendering them is the caller's escaping job.
    expect(
      snippetSegments(hit?.snippet ?? "").every((segment) => !segment.text.includes("⟦")),
    ).toBe(true);
  });

  it("shows a match beyond the first 100 000 characters as found and ranked, but not highlighted", async () => {
    const t = token();
    const owner = await idea("Deep match owner");
    await script(owner.id, `${"filler words fill the opening of this script. ".repeat(2500)}${t}`); // ~112 000 chars
    const hits = await search(t, ["scripts"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).not.toContain(SEARCH_HIGHLIGHT_START);
    expect(hits[0]?.snippet.startsWith("filler words fill")).toBe(true);
    expect(hits[0]?.rank).toBeGreaterThan(0);
  });

  it("highlights the title of an idea whose title matched, with the pitch as context", async () => {
    const t = token();
    await idea(`${t} in the title`, "A pitch that does not repeat the word but gives context.");
    const [hit] = await search(t);
    expect(hit?.snippet.startsWith(`${SEARCH_HIGHLIGHT_START}${t}${SEARCH_HIGHLIGHT_STOP}`)).toBe(
      true,
    );
    expect(hit?.snippet).toContain("gives context");
  });

  it("copes with a 1 MiB script body, even one that fills the vector limit, quickly", async () => {
    const t = token();
    const owner = await idea("Large owner");
    const prose = `${t} ${"The quick brown fox jumps over the lazy dog. ".repeat(23_000)}`.slice(
      0,
      1_048_000,
    );
    await script(owner.id, prose);
    // Distinct words fill the tsvector limit: only the first 100 000 characters are indexed (T11).
    const distinct = await idea("Distinct owner");
    const words =
      `needle ${Array.from({ length: 140_000 }, (_, i) => `w${String(i)}`).join(" ")}`.slice(
        0,
        1_048_000,
      );
    await script(distinct.id, words);
    const started = performance.now();
    const found = await search(t, ["scripts"]);
    const needle = await search("needle", ["scripts"]);
    expect(performance.now() - started).toBeLessThan(5000);
    expect(found).toHaveLength(1);
    expect(needle).toHaveLength(1);
    expectWellFormed(found[0]?.snippet ?? "");
    expectWellFormed(needle[0]?.snippet ?? "");
  });
});

// ---------------------------------------------------------------------------------------------
describe("snippetSegments", () => {
  const [start, stop] = [SEARCH_HIGHLIGHT_START, SEARCH_HIGHLIGHT_STOP];

  it("splits at the markers", () => {
    expect(snippetSegments(`a ${start}b${stop} c ${start}d e${stop}`)).toEqual([
      { text: "a ", highlight: false },
      { text: "b", highlight: true },
      { text: " c ", highlight: false },
      { text: "d e", highlight: true },
    ]);
  });

  it("handles no markers, an empty snippet and adjacent highlights", () => {
    expect(snippetSegments("plain")).toEqual([{ text: "plain", highlight: false }]);
    expect(snippetSegments("")).toEqual([]);
    expect(snippetSegments(`${start}a${stop}${start}b${stop}`)).toEqual([
      { text: "a", highlight: true },
      { text: "b", highlight: true },
    ]);
  });

  it("ignores unbalanced markers and keeps astral characters whole", () => {
    expect(snippetSegments(`${stop}x${stop}y`)).toEqual([
      { text: "x", highlight: false },
      { text: "y", highlight: false },
    ]);
    expect(snippetSegments(`${start}\u{1F600}${stop}\u{1F680}`)).toEqual([
      { text: "\u{1F600}", highlight: true },
      { text: "\u{1F680}", highlight: false },
    ]);
    expect(snippetSegments(`${start}open only`)).toEqual([{ text: "open only", highlight: true }]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("privileges and the caller's own rights", () => {
  it("is executable by ytw_web and ytw_mcp only, is a pinned, stable, invoker function", async () => {
    const privileges = await functionPrivileges(db, "search_all");
    const entries = Object.values(privileges);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      roles: ["ytw_mcp", "ytw_web"],
      publicExecute: false,
      definer: false,
      searchPath: "search_path=pg_catalog, public, pg_temp",
    });
    const { rows } = await db.admin.query<{ volatility: string; definer: boolean }>(
      "SELECT provolatile AS volatility, prosecdef AS definer FROM pg_proc WHERE proname = 'search_all'",
    );
    expect(rows).toEqual([{ volatility: "s", definer: false }]);
    expect(
      await sqlstate(
        db.pool("ytw_readonly").query("SELECT * FROM search_all('x', 1, ARRAY['ideas'])"),
      ),
    ).toBe("42501");
  });

  it("runs with the caller's rights: no SELECT on a table, no search", async () => {
    for (const [role, table] of [
      ["ytw_web", "scripts"],
      ["ytw_mcp", "ideas"],
    ] as const) {
      const run = () => searchAll(db.pool(role), { query: token(), resources: BOTH });
      expect(await run()).toEqual([]);
      await db.admin.query(`REVOKE SELECT ON public.${table} FROM ${role}`);
      try {
        const err = await run().catch((error: unknown) => error);
        expect(err).toMatchObject({ code: "42501" });
      } finally {
        await db.admin.query(`GRANT SELECT ON public.${table} TO ${role}`);
      }
      expect(await run()).toEqual([]);
    }
  });

  it("only reads: it works in a read-only transaction and writes no audit event", async () => {
    const before = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
    const client = await db.pool("ytw_web").connect();
    try {
      await client.query("BEGIN READ ONLY");
      const { rows } = await client.query(
        "SELECT * FROM search_all('anything', 5, ARRAY['ideas', 'scripts'])",
      );
      expect(Array.isArray(rows)).toBe(true);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    await search("anything");
    const after = await db.admin.query<{ n: number }>("SELECT count(*)::int AS n FROM events");
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it("treats a NULL query or limit as 'nothing' and 'default' and a NULL resource list as an error", async () => {
    const spec: FunctionSpec = {
      name: "search_all",
      types: ["text", "integer", "text[]"],
      valid: () => Promise.resolve(["x", 5, ["ideas"]]),
      optional: [0, 1],
    };
    const outcomes = await nullArgumentOutcomes(db, spec);
    expect(outcomes).toEqual(expectedNullOutcomes(spec));
    expect(outcomes).toEqual({ 0: "ok", 1: "ok", 2: "validation" });
  });

  it("is not callable by any other role than the services' (all three roles checked against the grant list)", async () => {
    const { rows } = await db.admin.query<{ role: string; allowed: boolean }>(
      `SELECT r AS role, has_function_privilege(r, 'public.search_all(text, integer, text[])', 'EXECUTE') AS allowed
         FROM unnest($1::text[]) AS r`,
      [[...APP_ROLES]],
    );
    expect(Object.fromEntries(rows.map((row) => [row.role, row.allowed]))).toEqual({
      ytw_web: true,
      ytw_mcp: true,
      ytw_readonly: false,
    });
  });
});
