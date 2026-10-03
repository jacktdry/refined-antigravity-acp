import { describe, expect, it } from "vitest";
import type { AcpStreamMessage, InboundContext } from "../../core/types.js";
import { missingSessionCloseFix } from "./index.js";

async function apply(msg: AcpStreamMessage): Promise<AcpStreamMessage> {
  const out = await missingSessionCloseFix.onInbound?.(msg, {} as InboundContext);
  if (!out || out.length !== 1) throw new Error("expected one inbound message");
  return out[0]!;
}

function sessionCapabilities(msg: AcpStreamMessage): Record<string, unknown> {
  if (!("result" in msg) || !msg.result || typeof msg.result !== "object") {
    throw new Error("expected result");
  }
  const result = msg.result as Record<string, unknown>;
  const agentCapabilities = result.agentCapabilities as Record<string, unknown> | undefined;
  const sessions = agentCapabilities?.sessionCapabilities;
  if (!sessions || typeof sessions !== "object") {
    throw new Error("expected session capabilities");
  }
  return sessions as Record<string, unknown>;
}

function initializeResponse(sessionCaps: Record<string, unknown>): AcpStreamMessage {
  return {
    jsonrpc: "2.0",
    id: 1,
    result: {
      protocolVersion: 1,
      agentInfo: { name: "antigravity-acp", version: "1.2.1" },
      agentCapabilities: {
        sessionCapabilities: sessionCaps,
      },
    },
  } as unknown as AcpStreamMessage;
}

describe("missing-session-close", () => {
  it("adds close to Antigravity initialize capabilities", async () => {
    const normalized = await apply(initializeResponse({ list: {}, resume: {} }));

    expect(sessionCapabilities(normalized)).toEqual({
      list: {},
      resume: {},
      close: {},
    });
  });

  it("does not advertise unsupported session/delete", async () => {
    const normalized = await apply(initializeResponse({ list: {}, resume: {} }));

    expect(sessionCapabilities(normalized).delete).toBeUndefined();
  });

  it("preserves an upstream close capability", async () => {
    const close = { reason: "upstream" };
    const normalized = await apply(initializeResponse({ close }));

    expect(sessionCapabilities(normalized).close).toBe(close);
  });

  it("leaves non-initialize responses unchanged", async () => {
    const message = {
      jsonrpc: "2.0",
      id: 2,
      result: {
        agentInfo: { name: "antigravity-acp" },
        agentCapabilities: { sessionCapabilities: { list: {} } },
      },
    } as unknown as AcpStreamMessage;

    await expect(apply(message)).resolves.toBe(message);
  });
});
