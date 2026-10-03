import { describe, expect, it } from "vitest";
import type { AcpStreamMessage, StderrContext } from "../../core/types.js";
import { createBackgroundTasksFix } from "./index.js";

describe("silent-background-tasks e2e", () => {
  it("problem: raw agy stderr emits STATE_WAITING_FOR_TASKS without stdout plan notifications", () => {
    const line =
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_1","state":"STATE_WAITING_FOR_TASKS"}}';
    expect(line).toContain("STATE_WAITING_FOR_TASKS");
  });

  it("solution: wrapped connector synthesizes session/update plan notifications for background tasks", () => {
    const fix = createBackgroundTasksFix();
    const emitted: AcpStreamMessage[] = [];
    const stderrContext: StderrContext = {
      sessionCache: {
        sessions: new Map(),
        pendingSessionMetadata: new Map(),
        pendingRequestSessions: new Map(),
      },
      forwardInbound: (msg) => {
        emitted.push(msg);
      },
      writeToChild: async () => {},
      sendInternalRequest: async () => ({}) as AcpStreamMessage,
      triggerRecycle: async () => {},
      declareHang: () => {},
    };

    fix.onStderrLine?.(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_test","state":"STATE_WAITING_FOR_TASKS"}}',
      stderrContext,
    );

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_test",
        update: {
          sessionUpdate: "plan",
          entries: [
            {
              content: "Running background subagents and tasks",
              priority: "high",
              status: "in_progress",
            },
          ],
        },
      },
    });

    fix.onStderrLine?.(
      'RAW WS MSG: {"trajectoryStateUpdate":{"trajectoryId":"sess_test","state":"STATE_RUNNING"}}',
      stderrContext,
    );

    expect(emitted).toHaveLength(2);
    const secondMsg = emitted[1] as {
      params: { update: { entries: Array<{ status: string }> } };
    };
    expect(secondMsg.params.update.entries[0]?.status).toBe("completed");
  });

  it("problem: raw agy passes Subagents as a string-encoded JSON array in invoke_subagent args", () => {
    const rawArgs = {
      Subagents: JSON.stringify([
        { Role: "Worker 1", Prompt: "Task 1" },
        { Role: "Worker 2", Prompt: "Task 2" },
      ]),
    };
    expect(typeof rawArgs.Subagents).toBe("string");
    expect(Array.isArray(rawArgs.Subagents)).toBe(false);
  });

  it("solution: wrapped connector parses string-encoded Subagents array and synthesizes plan notifications", async () => {
    const fix = createBackgroundTasksFix();
    const inboundContext = {
      sessionCache: {
        sessions: new Map(),
        pendingSessionMetadata: new Map(),
        pendingRequestSessions: new Map(),
      },
      forwardInbound: () => {},
      writeToChild: async () => {},
      sendInternalRequest: async () => ({}) as AcpStreamMessage,
      triggerRecycle: async () => {},
      declareHang: () => {},
    };

    const toolCallMsg: AcpStreamMessage = {
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "sess_subagents",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call_sub_1",
          name: "invoke_subagent",
          rawInput: {
            Subagents: JSON.stringify([
              { Role: "Research Agent", Prompt: "Investigate module A" },
              { Role: "Verification Agent", Prompt: "Run tests on module B" },
            ]),
          },
        },
      },
    } as unknown as AcpStreamMessage;

    const msgs = (await fix.onInbound?.(toolCallMsg, inboundContext)) ?? [];
    expect(msgs).toHaveLength(2);

    const planMsg = msgs[1] as {
      params: {
        update: {
          sessionUpdate: string;
          entries: Array<{ content: string; status: string; priority: string }>;
        };
      };
    };
    expect(planMsg.params.update.sessionUpdate).toBe("plan");
    expect(planMsg.params.update.entries).toHaveLength(2);
    expect(planMsg.params.update.entries[0]?.content).toBe("Subagent: Research Agent");
    expect(planMsg.params.update.entries[0]?.status).toBe("in_progress");
    expect(planMsg.params.update.entries[1]?.content).toBe("Subagent: Verification Agent");
    expect(planMsg.params.update.entries[1]?.status).toBe("in_progress");
  });
});
