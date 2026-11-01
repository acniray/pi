import crypto from "node:crypto";
import type { ApiKeyAuth, OAuthAuth, OAuthCredential, ProviderAuthInteraction } from "../../../auth/types.ts";
import { getMachineId } from "../cosy.ts";
import {
  getQoderDeviceLoginURL,
  getQoderDevicePollURL,
  getQoderRefreshURL,
  getQoderRegionConfig,
  getQoderUserInfoURL,
  type QoderMode,
} from "../region.ts";
import { credentialsFromPat, decodePatRefresh, fetchUserInfo, isPatRefresh } from "./pat.ts";

/**
 * Native Pi auth adapter. The coding agent owns credential storage and refresh
 * locking. No extension registration or direct auth.json writes are needed.
 */
export interface QoderIdentity {
  userID: string;
  name: string;
  email: string;
  machineID: string;
}

const identities = new Map<string, QoderIdentity>();
const exchangedPat = new Map<string, { access: string; expires: number }>();

function remember(access: string, credential: Record<string, unknown>, mode: QoderMode): void {
  const region = getQoderRegionConfig(mode);
  const userID = typeof credential.userID === "string" ? credential.userID : "";
  if (!userID) return;
  identities.set(mode + ":" + access, {
    userID,
    name: typeof credential.name === "string" ? credential.name : region.userNameFallback,
    email: typeof credential.email === "string" ? credential.email : region.userEmailFallback,
    machineID: typeof credential.machineID === "string" ? credential.machineID : getMachineId(),
  });
}

/** Retrieve the identity required by Qoder COSY without reading Pi's private auth storage. */
export async function resolveQoderIdentity(
  accessToken: string,
  _providerID: string,
  mode: QoderMode,
): Promise<QoderIdentity> {
  const key = mode + ":" + accessToken;
  const saved = identities.get(key);
  if (saved) return saved;
  const info = await fetchUserInfo(accessToken, mode);
  if (!info.userID) {
    throw new Error("Qoder user identity could not be resolved; please log in again.");
  }
  const region = getQoderRegionConfig(mode);
  const resolved = {
    userID: info.userID,
    name: info.name || region.userNameFallback,
    email: info.email || region.userEmailFallback,
    machineID: getMachineId(),
  };
  identities.set(key, resolved);
  return resolved;
}

async function credentialsForPat(pat: string, mode: QoderMode): Promise<OAuthCredential> {
  const creds = (await credentialsFromPat(pat, mode)) as OAuthCredential;
  remember(creds.access, creds, mode);
  return { ...creds, type: "oauth" };
}

/** Api-key credentials and QODER_* env vars may contain a PAT or a job token. */
export async function resolveQoderJobToken(token: string, mode: QoderMode): Promise<string> {
  const value = token.trim();
  if (!value) throw new Error("Qoder token is empty");
  if (!value.startsWith("pt-")) return value;
  const cacheKey = mode + ":" + value;
  const previous = exchangedPat.get(cacheKey);
  if (previous && Date.now() + 60_000 < previous.expires) return previous.access;
  const creds = await credentialsForPat(value, mode);
  exchangedPat.set(cacheKey, { access: creds.access, expires: creds.expires });
  return creds.access;
}

export function qoderApiKeyAuth(mode: QoderMode): ApiKeyAuth {
  const region = getQoderRegionConfig(mode);
  return {
    name: region.loginName + " API token",
    login: async (interaction) => {
      const key = (await interaction.prompt({
        type: "secret",
        message: "Enter Qoder Personal Access Token (pt-...) or job token (jt-...)",
      })).trim();
      interaction.signal.throwIfAborted();
      if (!key) throw new Error("Qoder token is required");
      return { type: "api_key", key };
    },
    resolve: async ({ ctx, credential, signal }) => {
      let rawToken = credential?.key;
      let source = rawToken ? "stored credential" : undefined;
      if (!rawToken) {
        for (const key of region.patEnvNames) {
          rawToken = await ctx.env(key);
          signal.throwIfAborted();
          if (rawToken) {
            source = key;
            break;
          }
        }
      }
      if (!rawToken) return undefined;
      const access = await resolveQoderJobToken(rawToken, mode);
      signal.throwIfAborted();
      return { auth: { apiKey: access }, source };
    },
  };
}

function parseExpiry(expiresAt?: string, expiresIn?: number): number {
  if (expiresAt) {
    const stamp = Date.parse(expiresAt);
    if (Number.isFinite(stamp)) return stamp;
    const raw = Number(expiresAt);
    if (Number.isFinite(raw) && raw > 0) return raw;
  }
  return Date.now() + (typeof expiresIn === "number" && expiresIn > 0 ? expiresIn * 1000 : 30 * 86400000);
}

async function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(new Error("Qoder login cancelled"));
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Browser device authorization is only available on the global Qoder endpoint. */
async function browserLogin(interaction: ProviderAuthInteraction): Promise<OAuthCredential> {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const nonce = crypto.randomUUID();
  const machineID = getMachineId();
  interaction.notify({
    type: "auth_url",
    url: getQoderDeviceLoginURL(challenge, machineID, nonce),
    instructions: "Sign in to Qoder in the browser, then return to Pi.",
  });
  const pollUrl = getQoderDevicePollURL(nonce, verifier);
  for (let attempt = 0; attempt < 90; attempt++) {
    await waitFor(2000, interaction.signal);
    const response = await fetch(pollUrl, {
      headers: { Accept: "application/json", "User-Agent": "pi-qoder-native" },
      signal: interaction.signal,
    });
    if (response.status === 202 || response.status === 404) continue;
    if (!response.ok) throw new Error("Qoder device login failed: HTTP " + response.status);
    const data = (await response.json()) as {
      token?: string;
      refresh_token?: string;
      user_id?: string;
      expires_at?: string;
      expires_in?: number;
    };
    if (!data.token || !data.refresh_token) throw new Error("Qoder device login returned incomplete credentials");
    const info = await fetchUserInfo(data.token, "global");
    const credential: OAuthCredential = {
      type: "oauth",
      access: data.token,
      refresh: data.refresh_token + "|" + (data.user_id || info.userID) + "|" + machineID,
      expires: parseExpiry(data.expires_at, data.expires_in) - 300000,
      userID: data.user_id || info.userID,
      email: info.email,
      name: info.name,
      machineID,
    };
    remember(credential.access, credential, "global");
    return credential;
  }
  throw new Error("Qoder device login timed out");
}

async function refreshDeviceCredential(
  credential: OAuthCredential,
  mode: QoderMode,
  signal: AbortSignal,
): Promise<OAuthCredential> {
  const parts = credential.refresh.split("|");
  const response = await fetch(getQoderRefreshURL(mode), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + credential.access,
      Accept: "application/json",
      "User-Agent": "pi-qoder-native",
    },
    body: JSON.stringify({ refreshToken: parts[0] }),
    signal,
  });
  if (!response.ok) throw new Error("Qoder session refresh failed: HTTP " + response.status);
  const data = (await response.json()) as {
    token?: string;
    refresh_token?: string;
    expires_at?: string;
    expires_in?: number;
  };
  if (!data.token) throw new Error("Qoder session refresh returned no job token");
  const next: OAuthCredential = {
    ...credential,
    access: data.token,
    refresh: (data.refresh_token || parts[0]) + "|" + parts.slice(1).join("|"),
    expires: parseExpiry(data.expires_at, data.expires_in) - 300000,
  };
  remember(next.access, next, mode);
  return next;
}

export function qoderOAuth(mode: QoderMode): OAuthAuth {
  const region = getQoderRegionConfig(mode);
  return {
    name: region.loginName,
    isSubscription: true,
    loginLabel: region.loginName,
    login: async (interaction) => {
      const method = region.supportsBrowserLogin
        ? await interaction.prompt({
            type: "select",
            message: "Qoder sign-in method",
            options: [
              { id: "pat", label: "Personal Access Token" },
              { id: "browser", label: "Browser login" },
            ],
          })
        : "pat";
      interaction.signal.throwIfAborted();
      if (method === "browser" && region.supportsBrowserLogin) {
        return browserLogin(interaction);
      }
      const pat = (await interaction.prompt({
        type: "secret",
        message: "Paste a Qoder Personal Access Token from " + region.patManageUrl,
      })).trim();
      interaction.signal.throwIfAborted();
      if (!pat) throw new Error("Qoder PAT is required");
      interaction.notify({ type: "progress", message: "Exchanging Qoder PAT..." });
      return credentialsForPat(pat, mode);
    },
    refresh: async (credential, signal) => {
      signal.throwIfAborted();
      if (isPatRefresh(credential.refresh)) {
        const pat = decodePatRefresh(credential.refresh).pat;
        if (!pat) throw new Error("Qoder PAT refresh credential is incomplete");
        const next = await credentialsForPat(pat, mode);
        signal.throwIfAborted();
        return next;
      }
      return refreshDeviceCredential(credential, mode, signal);
    },
    toAuth: async (credential) => {
      remember(credential.access, credential, mode);
      return { apiKey: credential.access };
    },
  };
}
