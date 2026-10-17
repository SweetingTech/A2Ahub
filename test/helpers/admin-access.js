import assert from "node:assert/strict";

export async function accessSection(ctx, state) {
  const { request, origin } = ctx;
  const { fullToken } = state;

  // Device approval from a screenless client must echo the verification code.
  const device = await request("/auth/device", { name: "Helper" });
  assert.equal(device.status, 201);
  const pending = (
    await request("/api/v1/access", undefined, { token: fullToken })
  ).data.requests[0];
  assert.equal(
    (
      await request(
        `/api/v1/access/${pending.id}/decision`,
        { approved: true, userCode: "WRONG" },
        { token: fullToken },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `/api/v1/access/${pending.id}/decision`,
        { approved: true, userCode: pending.userCode.toLowerCase() },
        { token: fullToken },
      )
    ).status,
    200,
  );

  // An approval for a room that is archived before the agent collects its
  // credential falls back to directory-only; archived rooms can't be chosen.
  const raceRoom = (await request("/api/v1/rooms", {}, { token: fullToken }))
    .data;
  const racer = (await request("/auth/device", { name: "Racer" })).data;
  const racerRequest = (
    await request("/api/v1/access", undefined, { token: fullToken })
  ).data.requests.find((r) => r.name === "Racer");
  assert.equal(
    (
      await request(
        `/api/v1/access/${racerRequest.id}/decision`,
        { approved: true, roomId: raceRoom.id },
        { token: fullToken },
      )
    ).status,
    200,
  );
  await request(
    `/api/v1/rooms/${raceRoom.id}/archive`,
    {},
    {
      token: fullToken,
    },
  );
  const collected = await request("/auth/token", {
    device_code: racer.device_code,
  });
  assert.equal(collected.status, 200, JSON.stringify(collected.data));
  const afterRace = (
    await request(`/api/v1/rooms/${raceRoom.id}`, undefined, {
      token: fullToken,
    })
  ).data;
  assert.equal(afterRace.archived, true);
  assert.deepEqual(afterRace.agentIds, []);
  const racerAccount = (
    await request("/api/v1/access", undefined, { token: fullToken })
  ).data.accounts.find((a) => a.name === "Racer");
  assert.ok(!Object.hasOwn(racerAccount.bindings, raceRoom.id));

  // An archived room delivers no history to a member agent.
  const readRoom = async (roomId) => {
    const response = await fetch(origin + "/a2a/jsonrpc", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "A2A-Version": "1.0",
        Authorization: `Bearer ${collected.data.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "read",
        method: "SendMessage",
        params: {
          message: {
            messageId: `read-${Date.now()}`,
            role: "ROLE_USER",
            contextId: roomId,
            parts: [{ data: { action: "read_messages", roomId } }],
          },
        },
      }),
    });
    return JSON.stringify(await response.json());
  };
  const memberRoom = (
    await request("/api/v1/rooms", {}, { token: fullToken })
  ).data;
  await request(
    `/api/v1/rooms/${memberRoom.id}`,
    { agentIds: [racerAccount.id] },
    { method: "PATCH", token: fullToken },
  );
  assert.match(await readRoom(memberRoom.id), /next_cursor/);
  await request(
    `/api/v1/rooms/${memberRoom.id}/archive`,
    {},
    {
      token: fullToken,
    },
  );
  const archivedRead = await readRoom(memberRoom.id);
  assert.match(archivedRead, /archived/);
  assert.doesNotMatch(archivedRead, /next_cursor/);
  await request("/auth/device", { name: "Late" });
  const late = (
    await request("/api/v1/access", undefined, { token: fullToken })
  ).data.requests.find((r) => r.name === "Late");
  const lateDecision = await request(
    `/api/v1/access/${late.id}/decision`,
    { approved: true, roomId: raceRoom.id },
    { token: fullToken },
  );
  assert.equal(lateDecision.status, 400);
  assert.match(lateDecision.data.error, /archived/);
}
