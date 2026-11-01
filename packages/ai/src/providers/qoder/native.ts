import { createProvider, type Provider, type RefreshModelsContext } from "../../models.ts";
import type { Api, Model, ProviderStreams } from "../../types.ts";
import { getCachedModels, staticCnModels, staticModels, updateQoderModelsCache } from "./catalog.js";
import { qoderApiKeyAuth, qoderOAuth, resolveQoderIdentity, resolveQoderJobToken } from "./auth/oauth.js";
import { streamQoder } from "./protocol/stream.js";
import { getQoderRegionConfig, type QoderMode } from "./region.js";

const QODER_API = "qoder-api" as Api;

function nativeModelList(mode: QoderMode): Model<Api>[] {
  return getCachedModels(mode).map((model) => ({
    ...model,
    provider: getQoderRegionConfig(mode).providerID,
  })) as Model<Api>[];
}

/** Native Pi's model-store persists the dynamic overlay; no extension lifecycle hook is needed. */
async function refreshModels(mode: QoderMode, context: RefreshModelsContext): Promise<readonly Model<Api>[]> {
  if (!context.allowNetwork || context.signal.aborted) return nativeModelList(mode);
  const credential = context.credential;
  let token: string | undefined;
  if (credential?.type === "oauth") {
    token = credential.access;
  } else if (credential?.type === "api_key" && credential.key) {
    token = await resolveQoderJobToken(credential.key, mode);
  } else {
    const env = typeof process !== "undefined" ? process.env : {};
    for (const name of getQoderRegionConfig(mode).patEnvNames) {
      const value = env[name];
      if (value) {
        token = await resolveQoderJobToken(value, mode);
        break;
      }
    }
  }
  if (!token || context.signal.aborted) return nativeModelList(mode);
  const identity = await resolveQoderIdentity(token, getQoderRegionConfig(mode).providerID, mode);
  context.signal.throwIfAborted();
  await updateQoderModelsCache(token, identity.userID, identity.name, identity.email, mode);
  context.signal.throwIfAborted();
  return nativeModelList(mode);
}

/** Both Qoder regions share one native wire protocol and differ only in endpoints/auth/catalog. */
export function createQoderProvider(mode: QoderMode): Provider<Api> {
  const region = getQoderRegionConfig(mode);
  const api: ProviderStreams = {
    stream: (model, context, options) => streamQoder(model, context, options),
    streamSimple: (model, context, options) => streamQoder(model, context, options),
  };
  return createProvider<Api>({
    id: region.providerID,
    name: mode === "cn" ? "Qoder CN" : "Qoder",
    baseUrl: region.baseUrl,
    auth: { apiKey: qoderApiKeyAuth(mode), oauth: qoderOAuth(mode) },
    models: (mode === "cn" ? staticCnModels : staticModels) as Model<Api>[],
    fetchModels: (ctx) => refreshModels(mode, ctx),
    api,
  });
}
