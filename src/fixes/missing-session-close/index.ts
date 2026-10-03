/**
 * Problem:
 * Upstream Antigravity implements session/close but omits the corresponding
 * capability from initialize. ACP clients that correctly gate methods by
 * advertised capabilities therefore never call a working lifecycle method.
 *
 * Solution:
 * Normalize only Antigravity initialize responses and preserve an upstream
 * close capability if it is eventually added.
 */
import type { AcpFix, AcpStreamMessage, InboundContext } from "../../core/types.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function isAntigravityInitialize(
  result: Record<string, unknown> | undefined,
): result is Record<string, unknown> {
  if (!result) return false;
  if (typeof result.protocolVersion !== "number") return false;
  return asRecord(result.agentInfo)?.name === "antigravity-acp";
}

function withCloseCapability(msg: AcpStreamMessage): AcpStreamMessage {
  if (!("result" in msg)) return msg;

  const result = asRecord(msg.result);
  if (!isAntigravityInitialize(result)) return msg;

  const capabilities = asRecord(result.agentCapabilities);
  if (!capabilities) return msg;

  const sessions = asRecord(capabilities.sessionCapabilities);
  if (!sessions || sessions.close !== undefined) return msg;

  return {
    ...msg,
    result: {
      ...result,
      agentCapabilities: {
        ...capabilities,
        sessionCapabilities: {
          ...sessions,
          close: {},
        },
      },
    },
  } as AcpStreamMessage;
}

export const missingSessionCloseFix: AcpFix = {
  name: "missing-session-close",
  description: "Advertise Antigravity's implemented session/close capability.",
  onInbound(msg: AcpStreamMessage, _context: InboundContext): AcpStreamMessage[] {
    return [withCloseCapability(msg)];
  },
};
