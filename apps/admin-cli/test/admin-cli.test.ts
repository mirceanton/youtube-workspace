import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@ytw/db/testing";
import { runCli } from "../src/cli.js";

describe("@ytw/admin-cli", () => {
  let db: TestDb;
  let webUrl: string;

  beforeAll(async () => {
    db = await createTestDb();
    webUrl = db.url("ytw_web");
  });

  afterAll(async () => {
    await db.drop();
  });

  async function execute(
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const result = await runCli(args, {
      databaseUrl: webUrl,
      stdout: (msg) => {
        stdout += msg + "\n";
      },
      stderr: (msg) => {
        stderr += msg + "\n";
      },
    });
    return { exitCode: result.exitCode, stdout, stderr };
  }

  it("shows help text when requested or when no arguments passed", async () => {
    const res1 = await execute([]);
    expect(res1.exitCode).toBe(0);
    expect(res1.stdout).toContain("ytw-admin - YouTube Workspace Admin CLI");

    const res2 = await execute(["--help"]);
    expect(res2.exitCode).toBe(0);
    expect(res2.stdout).toContain("ytw-admin - YouTube Workspace Admin CLI");
  });

  it("fails gracefully if database URL is missing", async () => {
    let stdout = "";
    let stderr = "";
    const result = await runCli(["user", "list"], {
      databaseUrl: "",
      env: { ...process.env, DATABASE_URL: "" },
      stdout: (msg) => {
        stdout += msg + "\n";
      },
      stderr: (msg) => {
        stderr += msg + "\n";
      },
    });
    expect(result.exitCode).toBe(2);
    expect(stderr).toContain("DATABASE_URL is not set");
  });

  describe("complete administration and token lifecycle flow", () => {
    let aliceId: string;
    let bobId: string;
    let bobTokenId: string;
    let bobTokenSecret: string;

    it("bootstraps the first user as admin with full permissions", async () => {
      const res = await execute([
        "user",
        "create",
        "--username",
        "alice",
        "--email",
        "alice@example.com",
        "--display-name",
        "Alice Admin",
        "--json",
      ]);

      expect(res.exitCode).toBe(0);
      const data = JSON.parse(res.stdout);
      expect(data.username).toBe("alice");
      expect(data.isAdmin).toBe(true);
      expect(data.created).toBe(true);
      expect(data.levels.ideas).toBe("write");
      expect(data.levels.scripts).toBe("write");
      expect(data.levels.activity).toBe("read"); // activity max is read

      aliceId = data.id;
      expect(aliceId).toBeDefined();
    });

    it("creates a second user starting with none on all resources", async () => {
      const res = await execute([
        "user",
        "create",
        "--username",
        "bob",
        "--email",
        "bob@example.com",
      ]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('User "bob"');
      expect(res.stdout).toContain("Admin:        false");
      expect(res.stdout).toContain("ideas=none");
      expect(res.stdout).toContain("scripts=none");
    });

    it("lists users with default admin or explicit admin", async () => {
      // With explicit --as
      const resExplicit = await execute(["user", "list", "--as", "alice", "--json"]);
      expect(resExplicit.exitCode).toBe(0);
      const list = JSON.parse(resExplicit.stdout);
      expect(list.length).toBe(2);
      const bob = list.find((u: { username: string }) => u.username === "bob");
      expect(bob).toBeDefined();
      expect(bob.isAdmin).toBe(false);
      bobId = bob.id;

      // Without --as (should auto-detect alice as active admin)
      const resDefault = await execute(["user", "list"]);
      expect(resDefault.exitCode).toBe(0);
      expect(resDefault.stdout).toContain("Users (2) [listed as alice]");
      expect(resDefault.stdout).toContain("alice");
      expect(resDefault.stdout).toContain("bob");
    });

    it("refuses user list when acting user is not an admin", async () => {
      const res = await execute(["user", "list", "--as", "bob"]);
      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('Acting user "bob" is not an active admin');
    });

    it("grants levels to a collaborator user", async () => {
      const res = await execute([
        "user",
        "set-level",
        "--as",
        "alice",
        bobId,
        "ideas=write",
        "scripts=read",
      ]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Updated access levels for user "bob"');
      expect(res.stdout).toContain("ideas: none -> write");
      expect(res.stdout).toContain("scripts: none -> read");
    });

    it("rejects illegal grants (e.g. activity=write)", async () => {
      const res = await execute(["user", "set-level", "--as", "alice", "bob", "activity=write"]);

      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain('Level "write" is not allowed on "activity"');
    });

    it("creates an API token within the owner's permitted levels", async () => {
      const res = await execute([
        "token",
        "create",
        "--owner",
        "bob",
        "--name",
        "bob-agent-token",
        "--grant",
        "ideas=write,scripts=read",
        "--expires-in",
        "30d",
      ]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Created API token "bob-agent-token"');
      expect(res.stdout).toContain("Token Secret (show once):");

      const match = res.stdout.match(/Token Secret \(show once\):\s*\n\s*(ytw_[A-Za-z0-9_-]+)/);
      expect(match).not.toBeNull();
      bobTokenSecret = match![1]!;
      expect(bobTokenSecret.startsWith("ytw_")).toBe(true);
      expect(bobTokenSecret.length).toBeGreaterThan(20);

      // Verify prefix is in token info
      expect(res.stdout).toContain(`Prefix:           ${bobTokenSecret.slice(0, 12)}`);
    });

    it("fails when attempting to create a token above the owner's current level", async () => {
      // Bob only has scripts=read. Trying to create scripts=write must fail with readable error!
      const res = await execute([
        "token",
        "create",
        "--owner",
        "bob",
        "--name",
        "over-ceiling-token",
        "--grant",
        "scripts=write",
      ]);

      expect(res.exitCode).toBe(1);
      expect(res.stderr).toContain("above the owner's own level");
      expect(res.stderr).toContain("scripts");
    });

    it("lists tokens for an owner without leaking secrets", async () => {
      const res = await execute(["token", "list", "--owner", "bob", "--json"]);
      expect(res.exitCode).toBe(0);
      const tokens = JSON.parse(res.stdout);
      expect(tokens.length).toBe(1);
      const tok = tokens[0];
      expect(tok.name).toBe("bob-agent-token");
      expect(tok.status).toBe("active");
      expect(tok.effectiveLevels.ideas).toBe("write");
      expect(tok.effectiveLevels.scripts).toBe("read");
      bobTokenId = tok.id;

      // Secret must NEVER appear in list output
      expect(res.stdout).not.toContain(bobTokenSecret);
    });

    it("updates permissions on an existing token", async () => {
      const res = await execute([
        "token",
        "update",
        "--owner",
        "bob",
        "--token",
        bobTokenId,
        "--grant",
        "ideas=read,scripts=read",
      ]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Updated API token "bob-agent-token"');
      expect(res.stdout).toContain("ideas=read");
    });

    it("rotates an API token, invalidating old secret and issuing a new one", async () => {
      const res = await execute([
        "token",
        "rotate",
        "--owner",
        "bob",
        "--token",
        bobTokenId,
        "--expires-in",
        "60d",
      ]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Rotated API token "bob-agent-token"');
      expect(res.stdout).toContain("New Token Secret (show once):");

      const match = res.stdout.match(/ytw_[A-Za-z0-9_-]+/);
      expect(match).not.toBeNull();
      const newSecret = match![0];
      expect(newSecret).not.toBe(bobTokenSecret);
      expect(newSecret.startsWith("ytw_")).toBe(true);

      // Old secret must not appear anywhere in rotation output
      expect(res.stdout).not.toContain(bobTokenSecret);
    });

    it("revokes an API token", async () => {
      const res = await execute(["token", "revoke", "--owner", "bob", "--token", bobTokenId]);

      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('Revoked API token "bob-agent-token"');

      // Verify list shows revoked status
      const listRes = await execute(["token", "list", "--owner", "bob", "--json"]);
      const tokens = JSON.parse(listRes.stdout);
      expect(tokens[0].status).toBe("revoked");
      expect(tokens[0].effectiveLevels.ideas).toBe("none");
    });

    it("promotes and demotes admins while enforcing last-admin protection", async () => {
      // Promote bob
      const promoteRes = await execute(["user", "set-admin", "--as", "alice", "bob"]);
      expect(promoteRes.exitCode).toBe(0);
      expect(promoteRes.stdout).toContain('Promoted "bob" to admin');

      // Now bob can demote alice because bob is also admin
      const demoteAliceRes = await execute([
        "user",
        "set-admin",
        "--as",
        "bob",
        "alice",
        "--demote",
      ]);
      expect(demoteAliceRes.exitCode).toBe(0);
      expect(demoteAliceRes.stdout).toContain('Demoted "alice" from admin');

      // Trying to demote bob now MUST fail because bob is the last active admin!
      const demoteLastAdminRes = await execute([
        "user",
        "set-admin",
        "--as",
        "bob",
        "bob",
        "--demote",
      ]);
      expect(demoteLastAdminRes.exitCode).toBe(1);
      expect(demoteLastAdminRes.stderr).toContain("last admin");

      // Restore alice as admin
      const restoreAliceAdmin = await execute(["user", "set-admin", "--as", "bob", "alice"]);
      expect(restoreAliceAdmin.exitCode).toBe(0);
    });

    it("revokes and restores user access", async () => {
      const revokeRes = await execute(["user", "revoke-access", "--as", "alice", "bob"]);
      expect(revokeRes.exitCode).toBe(0);
      expect(revokeRes.stdout).toContain('Revoked access for user "bob"');

      // Bob's access is revoked; checking user list reflects this
      const listRes = await execute(["user", "list", "--as", "alice"]);
      expect(listRes.stdout).toContain("bob");
      expect(listRes.stdout).toContain("[ACCESS REVOKED]");

      // Restore bob's access
      const restoreRes = await execute(["user", "restore-access", "--as", "alice", "bob"]);
      expect(restoreRes.exitCode).toBe(0);
      expect(restoreRes.stdout).toContain('Restored access for user "bob"');
    });
  });
});
