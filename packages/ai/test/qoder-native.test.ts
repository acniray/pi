import { describe, expect, it } from "vitest";
import { builtinProviders } from "../src/providers/all.ts";
import { qoderProvider } from "../src/providers/qoder.ts";
import { qoderCnProvider } from "../src/providers/qoder-cn.ts";
import { parseModelBusyRejection } from "../src/providers/qoder/protocol/stream.ts";
import { qoderApiKeyAuth } from "../src/providers/qoder/auth/oauth.ts";
import { createQoderToolCallIdMapper } from "../src/providers/qoder/protocol/tool-call-id.ts";

function nestedQueue(queued: boolean): string {
  return JSON.stringify({
    code: "403",
    message: JSON.stringify({
      code: "10605",
      subCode: "CALL_COUNT_LIMIT",
      message: JSON.stringify({
        isQueued: queued,
        serviceAvailable: true,
        modelKey: "dfmodel",
        queueType: "p2",
        queueCount: 1259,
        retryAfterSeconds: 30,
        waitTime: 249,
      }),
    }),
  });
}

describe("native Qoder provider integration", () => {
  it("is registered using the normal Pi provider registry", () => {
    const byId = new Map(builtinProviders().map((p) => [p.id, p]));
    expect(byId.has("qoder")).toBe(true);
    expect(byId.has("qoder-cn")).toBe(true);
    expect(byId.get("qoder")?.auth.oauth).toBeDefined();
    expect(byId.get("qoder-cn")?.auth.apiKey).toBeDefined();
  });

  it("offers independent regional catalogs with the same custom wire API", () => {
    const global = qoderProvider();
    const cn = qoderCnProvider();
    expect(global.id).toBe("qoder");
    expect(cn.id).toBe("qoder-cn");
    expect(global.getModels().length).toBeGreaterThan(0);
    expect(cn.getModels().length).toBeGreaterThan(0);
    expect(global.getModels().every((model) => model.api === "qoder-api" && model.provider === "qoder")).toBe(true);
    expect(cn.getModels().every((model) => model.api === "qoder-api" && model.provider === "qoder-cn")).toBe(true);
  });

  it("parses Qoder's real queued limit without converting it into an auth error", () => {
    expect(parseModelBusyRejection(nestedQueue(true))).toMatchObject({
      kind: "queued",
      waitMs: 249000,
      queueCount: 1259,
      queueType: "p2",
    });
    expect(parseModelBusyRejection(nestedQueue(false))).toMatchObject({
      kind: "ready",
      retryAfterMs: 30000,
    });
  });

  it("keeps tool-call ids within Qoder's allowed alphabet", () => {
    const map = createQoderToolCallIdMapper();
    const toolId = map("nested|tool/call=42");
    expect(toolId).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(map("nested|tool/call=42")).toBe(toolId);
  });

  it("uses native Pi ApiKeyAuth for a job token from the environment", async () => {
    const auth = qoderApiKeyAuth("cn");
    const result = await auth.resolve({
      ctx: {
        env: async (name) => name === "QODERCN_PAT" ? "jt-example" : undefined,
        fileExists: async () => false,
      },
      signal: new AbortController().signal,
    });
    expect(result?.auth.apiKey).toBe("jt-example");
    expect(result?.source).toBe("QODERCN_PAT");
  });
});
