const mode = process.env.E2E_IDP ?? "mock";
const keycloakUrl = (process.env.KEYCLOAK_URL ?? "http://localhost:8080").replace(/\/$/, "");
const realmName = "youtube-workspace";
const groupName = "youtube-workspace-users";
const issuer = process.env.OIDC_ISSUER_URL ?? `${keycloakUrl}/realms/${realmName}`;
let keycloakAdmin: KeycloakAdmin | undefined;

interface KeycloakUser {
  id: string;
  username: string;
}

interface KeycloakGroup {
  id: string;
  name: string;
  path?: string;
}

class KeycloakAdmin {
  private accessToken: string | undefined;
  private tokenExpiresAt = 0;
  private originalAccessTokenLifespan: number | undefined;
  private readonly originalGroupMembership = new Map<string, boolean | null>();

  async request<T = undefined>(path: string, init: RequestInit = {}): Promise<T | undefined> {
    const token = await this.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(`${keycloakUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new Error(`Keycloak admin ${init.method ?? "GET"} request failed (${response.status})`);
    }
    if (response.status === 204) return undefined;
    const body: unknown = await response.json();
    return body as T;
  }

  async prepareForTests(): Promise<void> {
    const path = `/admin/realms/${realmName}`;
    const representation = await this.request<Record<string, unknown>>(path);
    if (representation === undefined || typeof representation.accessTokenLifespan !== "number") {
      throw new Error("Keycloak realm has no access-token lifespan");
    }
    this.originalAccessTokenLifespan = representation.accessTokenLifespan;
    const group = await this.findAccessGroup();
    for (const username of ["owner", "outsider", "collaborator"]) {
      const user = await this.findUserOrNull(username);
      if (user === null) {
        this.originalGroupMembership.set(username, null);
        continue;
      }
      const groups = await this.request<KeycloakGroup[]>(
        `/admin/realms/${realmName}/users/${encodeURIComponent(user.id)}/groups`,
      );
      this.originalGroupMembership.set(
        username,
        (groups ?? []).some((item) => item.id === group.id),
      );
    }

    try {
      await this.setAccessTokenLifespan(15);
      await this.ensureGroupMembership("owner", true);
      await this.ensureGroupMembership("outsider", false);
      await this.ensureCollaborator();
    } catch (error) {
      await this.restoreAfterTests().catch(() => undefined);
      throw error;
    }
  }

  async restoreAfterTests(): Promise<void> {
    if (this.originalAccessTokenLifespan === undefined) return;
    const originalAccessTokenLifespan = this.originalAccessTokenLifespan;
    try {
      for (const [username, wasMember] of this.originalGroupMembership) {
        if (wasMember === null && username === "collaborator") {
          const user = await this.findUserOrNull(username);
          if (user !== null) {
            await this.request(`/admin/realms/${realmName}/users/${encodeURIComponent(user.id)}`, {
              method: "DELETE",
            });
          }
        } else if (wasMember !== null) {
          await this.ensureGroupMembership(username, wasMember);
        }
      }
    } finally {
      await this.setAccessTokenLifespan(originalAccessTokenLifespan);
      this.originalAccessTokenLifespan = undefined;
      this.originalGroupMembership.clear();
    }
  }

  private async setAccessTokenLifespan(accessTokenLifespan: number): Promise<void> {
    const path = `/admin/realms/${realmName}`;
    const representation = await this.request<Record<string, unknown>>(path);
    if (representation === undefined) throw new Error("Keycloak realm is unavailable");
    await this.request(path, {
      method: "PUT",
      body: JSON.stringify({ ...representation, accessTokenLifespan }),
    });
  }

  async ensureGroupMembership(username: string, shouldBeMember: boolean): Promise<void> {
    const user = await this.findUser(username);
    const group = await this.findAccessGroup();
    const current = await this.request<KeycloakGroup[]>(
      `/admin/realms/${realmName}/users/${encodeURIComponent(user.id)}/groups`,
    );
    const isMember = (current ?? []).some((item) => item.id === group.id);
    if (shouldBeMember === isMember) return;
    await this.request(
      `/admin/realms/${realmName}/users/${encodeURIComponent(user.id)}/groups/${encodeURIComponent(group.id)}`,
      { method: shouldBeMember ? "PUT" : "DELETE" },
    );
  }

  async removeFromAccessGroup(username: string): Promise<void> {
    await this.ensureGroupMembership(username, false);
  }

  async ensureCollaborator(): Promise<void> {
    let user = await this.findUserOrNull("collaborator");
    if (user === null) {
      const response = await fetch(`${keycloakUrl}/admin/realms/${realmName}/users`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await this.getAccessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          username: "collaborator",
          enabled: true,
          email: "collaborator@youtube-workspace.test",
          emailVerified: true,
          firstName: "Dev",
          lastName: "Collaborator",
          credentials: [{ type: "password", value: "collaborator-dev-pass", temporary: false }],
        }),
      });
      if (!response.ok) {
        throw new Error(`Keycloak collaborator creation failed (${response.status})`);
      }
      user = await this.findUserOrNull("collaborator");
    }
    if (user === null) throw new Error("Keycloak collaborator was not created");
    await this.ensureGroupMembership("collaborator", true);
  }

  private async findUser(username: string): Promise<KeycloakUser> {
    const user = await this.findUserOrNull(username);
    if (user === null) throw new Error(`Keycloak user ${username} was not found`);
    return user;
  }

  private async findUserOrNull(username: string): Promise<KeycloakUser | null> {
    const query = new URLSearchParams({ username, exact: "true" });
    const users = await this.request<KeycloakUser[]>(
      `/admin/realms/${realmName}/users?${query.toString()}`,
    );
    return (users ?? []).find((user) => user.username === username) ?? null;
  }

  private async findAccessGroup(): Promise<KeycloakGroup> {
    const query = new URLSearchParams({ search: groupName });
    const groups = await this.request<KeycloakGroup[]>(
      `/admin/realms/${realmName}/groups?${query.toString()}`,
    );
    const group = (groups ?? []).find(
      (item) => item.name === groupName || item.path === `/${groupName}`,
    );
    if (group === undefined) throw new Error("The Keycloak workspace access group was not found");
    return group;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken !== undefined && Date.now() < this.tokenExpiresAt - 5_000) {
      return this.accessToken;
    }
    const response = await fetch(`${keycloakUrl}/realms/master/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: "admin-cli",
        username: process.env.KEYCLOAK_ADMIN_USERNAME ?? "admin",
        password: process.env.KEYCLOAK_ADMIN_PASSWORD ?? "admin",
      }),
    });
    if (!response.ok) throw new Error(`Keycloak admin authentication failed (${response.status})`);
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body === null ||
      typeof (body as { access_token?: unknown }).access_token !== "string"
    ) {
      throw new Error("Keycloak admin authentication returned no access token");
    }
    this.accessToken = (body as { access_token: string }).access_token;
    this.tokenExpiresAt =
      Date.now() + Number((body as { expires_in?: unknown }).expires_in ?? 60) * 1000;
    return this.accessToken;
  }
}

export async function prepareIdentityProvider(): Promise<void> {
  if (mode === "mock") {
    // Restore the identities for each independent browser scenario. The login flow deliberately
    // removes the collaborator's group, and later story files reuse the same running provider.
    for (const username of ["owner", "collaborator", "outsider"]) {
      const response = await fetch(`${new URL(issuer).origin}/_e2e/users/${username}/groups`, {
        method: "PUT",
        headers: {
          authorization: `Bearer ${process.env.E2E_MOCK_ADMIN_TOKEN ?? "ytw-e2e-local-mock-admin"}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ groups: username === "outsider" ? [] : [groupName] }),
      });
      if (!response.ok) throw new Error(`Mock identity preparation failed (${response.status})`);
    }
    return;
  }
  if (mode !== "keycloak") throw new Error("E2E_IDP must be either mock or keycloak");
  keycloakAdmin = new KeycloakAdmin();
  await keycloakAdmin.prepareForTests();
}

export async function restoreIdentityProvider(): Promise<void> {
  await keycloakAdmin?.restoreAfterTests();
}

export async function removeUserFromAccessGroup(username: string): Promise<void> {
  if (mode === "keycloak") {
    await new KeycloakAdmin().removeFromAccessGroup(username);
    return;
  }

  const response = await fetch(
    `${new URL(issuer).origin}/_e2e/users/${encodeURIComponent(username)}/groups/${encodeURIComponent(groupName)}`,
    {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${process.env.E2E_MOCK_ADMIN_TOKEN ?? "ytw-e2e-local-mock-admin"}`,
      },
    },
  );
  if (!response.ok) throw new Error(`Mock identity group removal failed (${response.status})`);
}

export { issuer };
