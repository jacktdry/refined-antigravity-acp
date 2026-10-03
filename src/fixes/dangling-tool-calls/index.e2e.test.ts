import { afterEach, describe, expect, it } from "vitest";
import { spawnRawAgy, spawnWrapped, type AcpTestClient } from "../../test-utils/index.js";
import type { SessionUpdateParams, SessionUpdatePayload } from "../../core/types.js";

describe("dangling-tool-calls & stream-stability e2e", () => {
  const activeClients: AcpTestClient[] = [];

  afterEach(async () => {
    while (activeClients.length > 0) {
      const client = activeClients.pop();
      if (client) {
        await client.close().catch(() => {});
      }
    }
  });

  it("problem: raw agy omits messageId on agent_message_chunk updates", async () => {
    const client = await spawnRawAgy();
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession({ modeId: "yolo" });

    const p = await client.prompt(sessionId, "Reply with 'Hello world' and nothing else.");
    await client.waitForResponse(p.id, 45000);

    const messageChunks = client
      .allMessages()
      .filter((m) => "method" in m && m.method === "session/update")
      .map((m) =>
        "params" in m ? (m.params as SessionUpdateParams | undefined)?.update : undefined,
      )
      .filter((u): u is SessionUpdatePayload => u?.sessionUpdate === "agent_message_chunk");

    expect(messageChunks.length).toBeGreaterThan(0);
    // Raw agy never includes messageId on agent_message_chunk
    for (const chunk of messageChunks) {
      expect(chunk.messageId).toBeUndefined();
    }
  }, 60000);

  it("solution: wrapped connector attaches stable messageId to all agent_message_chunks in turn", async () => {
    const client = await spawnWrapped();
    activeClients.push(client);
    await client.initialize();
    const { sessionId } = await client.newSession({ modeId: "yolo" });

    const p = await client.prompt(sessionId, "Reply with 'Hello world' and nothing else.");
    await client.waitForResponse(p.id, 45000);

    const messageChunks = client
      .allMessages()
      .filter((m) => "method" in m && m.method === "session/update")
      .map((m) =>
        "params" in m ? (m.params as SessionUpdateParams | undefined)?.update : undefined,
      )
      .filter((u): u is SessionUpdatePayload => u?.sessionUpdate === "agent_message_chunk");

    expect(messageChunks.length).toBeGreaterThan(0);
    const firstMessageId = messageChunks[0]?.messageId;
    expect(firstMessageId).toBeDefined();
    expect(typeof firstMessageId).toBe("string");
    expect(firstMessageId).toMatch(/^msg_[0-9a-f-]{36}$/);

    // All chunks in the same turn must share the exact same messageId
    for (const chunk of messageChunks) {
      expect(chunk.messageId).toBe(firstMessageId);
    }
  }, 60000);
});
