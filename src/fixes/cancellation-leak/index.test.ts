import { describe, expect, it } from "vitest";
import type { AcpStreamMessage } from "../../core/types.js";
import { setFixData } from "../../core/session-cache.js";
import { createMockContext } from "../../test-utils/e2e-harness.js";
import {
  DEFAULT_CANCELLATION_TIMEOUT_MS,
  createCancellationLeakFix,
  extractMessageChunkText,
  interruptionCleanupFix,
  isCancellationText,
} from "./index.js";

describe("isCancellationText", () => {
  it("detects concatenated upstream cancellation error text", () => {
    expect(isCancellationText("context canceledThe request was cancelled by the client.")).toBe(
      true,
    );
  });

  it("detects Python client-cancellation exception text", () => {
    expect(isCancellationText("The request was cancelled by the client.")).toBe(true);
    expect(isCancellationText("The request was cancelled by the client")).toBe(true);
  });

  it("detects Go context-cancellation error text", () => {
    expect(isCancellationText("context canceled")).toBe(true);
  });

  it("detects cancellation text even with surrounding whitespace padding", () => {
    expect(
      isCancellationText("   context canceledThe request was cancelled by the client.   \n"),
    ).toBe(true);
  });

  it("detects concurrent receive_steps lost connection error text", () => {
    expect(
      isCancellationText(
        "Agent connection was lost and could not be re-established: Concurrent receive_steps() calls are not supported on this connection.",
      ),
    ).toBe(true);
  });

  it("preserves legitimate assistant messages that discuss cancellation topics", () => {
    expect(isCancellationText("Here is the explanation for context cancellation in Go.")).toBe(
      false,
    );
    expect(isCancellationText("Done!")).toBe(false);
    expect(isCancellationText("")).toBe(false);
  });
});

describe("extractMessageChunkText", () => {
  it("extracts string payload from object-based message chunks", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    } as unknown as AcpStreamMessage;
    expect(extractMessageChunkText(msg)).toBe("hello");
  });

  it("extracts concatenated string payload from multi-part array chunks", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: [
            { type: "text", text: "foo" },
            { type: "text", text: "bar" },
          ],
        },
      },
    } as unknown as AcpStreamMessage;
    expect(extractMessageChunkText(msg)).toBe("foobar");
  });

  it("ignores non-message update variants", () => {
    const msg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "tool_call",
        },
      },
    } as unknown as AcpStreamMessage;
    expect(extractMessageChunkText(msg)).toBeNull();
  });
});

describe("interruptionCleanupFix", () => {
  it("suppresses raw combined cancellation error string from reaching the client", () => {
    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "context canceledThe request was cancelled by the client.",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = interruptionCleanupFix.onInbound?.(cancelMsg, createMockContext());
    expect(res).toEqual([]);
  });

  it("suppresses raw Python cancellation error string from reaching the client", () => {
    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "The request was cancelled by the client.",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = interruptionCleanupFix.onInbound?.(cancelMsg, createMockContext());
    expect(res).toEqual([]);
  });

  it("suppresses raw Go context canceled string from reaching the client", () => {
    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "context canceled",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = interruptionCleanupFix.onInbound?.(cancelMsg, createMockContext());
    expect(res).toEqual([]);
  });

  it("forwards legitimate assistant message chunks untouched", () => {
    const normalMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "Hello! How can I help you?",
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const res = interruptionCleanupFix.onInbound?.(normalMsg, createMockContext());
    expect(res).toEqual([normalMsg]);
  });

  it("forwards upstream cancelled prompt response to client and unblocks next prompt", async () => {
    const fix = createCancellationLeakFix();
    const mockCtx = createMockContext();

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 201,
      method: "session/prompt",
      params: { sessionId: "sess-cancel-test", prompt: [{ type: "text", text: "slow tool" }] },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(promptMsg, mockCtx);

    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sess-cancel-test" },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(cancelMsg, mockCtx);

    // Stream update chunk arriving during cancel -> dropped
    const cancelChunk: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-cancel-test",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "tool output during cancel" },
        },
      },
    } as unknown as AcpStreamMessage;
    expect(fix.onInbound?.(cancelChunk, mockCtx)).toEqual([]);

    const upstreamCancelResponse: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 201,
      result: { stopReason: "cancelled" },
    } as unknown as AcpStreamMessage;

    const res = fix.onInbound?.(upstreamCancelResponse, mockCtx);
    expect(res).toEqual([upstreamCancelResponse]);
  });

  it("synthesizes fallback cancelled prompt response when upstream times out on cancel", async () => {
    const fix = createCancellationLeakFix({ timeoutMs: 50 });
    let forwardedInbound: AcpStreamMessage | null = null;
    const mockCtx = {
      ...createMockContext(),
      forwardInbound: (msg: AcpStreamMessage) => {
        forwardedInbound = msg;
      },
    };

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 202,
      method: "session/prompt",
      params: { sessionId: "sess-timeout-test", prompt: [{ type: "text", text: "slow tool" }] },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(promptMsg, mockCtx);

    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sess-timeout-test" },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(cancelMsg, mockCtx);

    // Wait for timeout fallback
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(forwardedInbound).toEqual({
      jsonrpc: "2.0",
      id: 202,
      result: { stopReason: "cancelled" },
    });

    // Session cache should have needsRecycle flagged so supervisor can recycle process before next prompt
    expect(mockCtx.sessionCache.sessions.get("sess-timeout-test")?.needsRecycle).toBe(true);

    // Late response arriving after fallback is dropped
    const lateResponse: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 202,
      result: { stopReason: "cancelled" },
    } as unknown as AcpStreamMessage;
    const lateRes = fix.onInbound?.(lateResponse, mockCtx);
    expect(lateRes).toEqual([]);
  });

  it("inbound server request (e.g. session/request_permission) with colliding id does not clear prompt tracking and allows fallback cancellation to settle", async () => {
    let forwardedInbound: AcpStreamMessage | null = null;
    let recycleSession: unknown = null;
    const mockCtx = createMockContext({
      forwardInbound: (msg) => {
        forwardedInbound = msg;
      },
      triggerRecycle: async (session) => {
        recycleSession = session;
      },
    });

    const fix = createCancellationLeakFix({ timeoutMs: 40 });

    // Client sends session/prompt with id: 1
    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/prompt",
      params: {
        sessionId: "sess-perm-collision",
        prompt: [{ type: "text", text: "run bash command" }],
      },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(promptMsg, mockCtx);

    // Upstream server sends session/request_permission with id: 1 (server-to-client request!)
    const permReqMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 1,
      method: "session/request_permission",
      params: { sessionId: "sess-perm-collision", options: [] },
    } as unknown as AcpStreamMessage;

    // This inbound request must NOT clear prompt tracking or cancel fallback timers
    const permResult = fix.onInbound?.(permReqMsg, mockCtx);
    expect(permResult).toEqual([permReqMsg]);

    // Now client issues session/cancel (e.g. user interrupted in Paseo)
    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sess-perm-collision" },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(cancelMsg, mockCtx);

    // Wait for fallback timer (40ms)
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Fallback cancellation must have synthesized the prompt response with id: 1
    expect(forwardedInbound).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { stopReason: "cancelled" },
    });

    // Process recycling must be flagged and triggered
    expect(mockCtx.sessionCache.sessions.get("sess-perm-collision")?.needsRecycle).toBe(true);
    expect(recycleSession).toBe(mockCtx.sessionCache.sessions.get("sess-perm-collision"));
  });

  it("sets DEFAULT_CANCELLATION_TIMEOUT_MS strictly below Paseo's 2000ms interrupt watchdog", () => {
    // Paseo's agent-manager.js uses const INTERRUPT_SESSION_TIMEOUT_MS = 2000;
    // Our timeout must be significantly lower (e.g. 800ms) to ensure prompt settlement before Paseo crashes
    expect(DEFAULT_CANCELLATION_TIMEOUT_MS).toBe(800);
    expect(DEFAULT_CANCELLATION_TIMEOUT_MS).toBeLessThan(2000);
  });

  it("delays subsequent outbound prompt until in-flight cancellation has settled", async () => {
    const fix = createCancellationLeakFix();
    const mockCtx = createMockContext();

    const prompt1: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 204,
      method: "session/prompt",
      params: { sessionId: "sess-queue-test", prompt: [{ type: "text", text: "cmd 1" }] },
    } as unknown as AcpStreamMessage;
    await fix.onOutbound?.(prompt1, mockCtx);

    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sess-queue-test" },
    } as unknown as AcpStreamMessage;
    await fix.onOutbound?.(cancelMsg, mockCtx);

    const prompt2: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 205,
      method: "session/prompt",
      params: { sessionId: "sess-queue-test", prompt: [{ type: "text", text: "cmd 2" }] },
    } as unknown as AcpStreamMessage;

    let p2Settled = false;
    const p2Promise = Promise.resolve(fix.onOutbound?.(prompt2, mockCtx)).then(() => {
      p2Settled = true;
      return undefined;
    });

    // Microtask wait: prompt2 must be awaiting cancellation
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(p2Settled).toBe(false);

    // Upstream settles prompt 1
    const p1Response: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 204,
      result: { stopReason: "cancelled" },
    } as unknown as AcpStreamMessage;
    fix.onInbound?.(p1Response, mockCtx);

    await p2Promise;
    expect(p2Settled).toBe(true);
  });

  it("preserves terminal tool_call_update for cancelled turns so client UI completes tool state", () => {
    const fix = interruptionCleanupFix;
    const mockCtx = createMockContext();

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 203,
      method: "session/prompt",
      params: { sessionId: "sess-tool-cancel-test", prompt: [{ type: "text", text: "run tool" }] },
    } as unknown as AcpStreamMessage;

    fix.onOutbound?.(promptMsg, mockCtx);

    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sess-tool-cancel-test" },
    } as unknown as AcpStreamMessage;

    fix.onOutbound?.(cancelMsg, mockCtx);

    const toolCallUpdate: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess-tool-cancel-test",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "failed",
        },
      },
    } as unknown as AcpStreamMessage;

    const res = fix.onInbound?.(toolCallUpdate, mockCtx);
    expect(res).toEqual([toolCallUpdate]);
  });

  it("immediately aborts background subagents and settles prompt on session cancel when active tasks exist", async () => {
    const fix = createCancellationLeakFix();
    let recycledSession: unknown = null;
    let forwardedInbound: AcpStreamMessage | null = null;

    const session = {
      sessionId: "sess-subagent-cancel",
      lastConfigOptions: new Map(),
      fixData: new Map(),
    };
    setFixData(session, "hadActiveTasksOnCancel", true);

    const mockCtx = {
      ...createMockContext(),
      session,
      triggerRecycle: async (sess: unknown) => {
        recycledSession = sess;
      },
      forwardInbound: (msg: AcpStreamMessage) => {
        forwardedInbound = msg;
      },
    };

    const promptMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 501,
      method: "session/prompt",
      params: {
        sessionId: "sess-subagent-cancel",
        prompt: [{ type: "text", text: "launch 14 subagents" }],
      },
    } as unknown as AcpStreamMessage;

    await fix.onOutbound?.(promptMsg, mockCtx);

    const cancelMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: "sess-subagent-cancel" },
    } as unknown as AcpStreamMessage;

    const cancelResult = await fix.onOutbound?.(cancelMsg, mockCtx);

    // Cancel must return null so outbound cancel is not sent down to recycled/dying child
    expect(cancelResult).toBeNull();

    // Must immediately forward cancelled prompt response to client UI
    expect(forwardedInbound).toEqual({
      jsonrpc: "2.0",
      id: 501,
      result: { stopReason: "cancelled" },
    });

    // Must trigger process recycle to kill all active subagent worker processes
    expect(recycledSession).toBe(session);

    // Late upstream prompt response must be suppressed
    const lateUpstreamResponse: AcpStreamMessage = {
      jsonrpc: "2.0",
      id: 501,
      result: { stopReason: "end_turn" },
    } as unknown as AcpStreamMessage;
    const inboundRes = fix.onInbound?.(lateUpstreamResponse, mockCtx);
    expect(inboundRes).toEqual([]);
  });
});
