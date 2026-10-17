import assert from "node:assert/strict";

export async function roomsSection(ctx, state) {
  const { request } = ctx;
  const { fullToken } = state;

  // Folders and filing.
  const folder = await request(
    "/api/v1/folders",
    { name: "Home lab", color: "teal" },
    { token: fullToken },
  );
  assert.equal(folder.status, 200, JSON.stringify(folder.data));
  assert.equal(
    (
      await request(
        "/api/v1/folders",
        { name: "Bad", color: "neon" },
        { token: fullToken },
      )
    ).status,
    400,
  );
  const room = (
    await request(
      "/api/v1/rooms",
      { folderId: folder.data.id },
      { token: fullToken },
    )
  ).data;
  assert.equal(room.folderId, folder.data.id);
  assert.equal(
    (
      await request(
        `/api/v1/rooms/${room.id}`,
        { pinned: true },
        { method: "PATCH", token: fullToken },
      )
    ).data.pinned,
    true,
  );
  await request(`/api/v1/folders/${folder.data.id}`, undefined, {
    method: "DELETE",
    token: fullToken,
  });
  const unfiled = (
    await request(`/api/v1/rooms/${room.id}`, undefined, { token: fullToken })
  ).data;
  assert.equal(unfiled.folderId, null);

  // Archive is read-only and paused; restore stays paused; delete needs archive.
  assert.equal(
    (
      await request(`/api/v1/rooms/${room.id}`, undefined, {
        method: "DELETE",
        token: fullToken,
      })
    ).status,
    400,
  );
  const archived = (
    await request(
      `/api/v1/rooms/${room.id}/archive`,
      {},
      { token: fullToken },
    )
  ).data;
  assert.equal(archived.archived, true);
  assert.equal(archived.paused, true);
  for (const route of [
    `/rooms/${room.id}/messages`,
    `/rooms/${room.id}/continue`,
    `/rooms/${room.id}/resume`,
  ]) {
    const blocked = await request(
      `/api/v1${route}`,
      { text: "hello" },
      { token: fullToken },
    );
    assert.equal(blocked.status, 400, route);
    assert.match(blocked.data.error, /archived/i);
  }
  assert.equal(
    (
      await request(
        `/api/v1/rooms/${room.id}`,
        { replyLimit: 3 },
        { method: "PATCH", token: fullToken },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await request(
        `/api/v1/rooms/${room.id}`,
        { title: "Old notes" },
        { method: "PATCH", token: fullToken },
      )
    ).status,
    200,
  );
  const restored = (
    await request(
      `/api/v1/rooms/${room.id}/unarchive`,
      {},
      { token: fullToken },
    )
  ).data;
  assert.equal(restored.archived, false);
  assert.equal(restored.paused, true, "restoring must not resume agents");
  await request(`/api/v1/rooms/${room.id}/archive`, {}, { token: fullToken });
  assert.equal(
    (
      await request(`/api/v1/rooms/${room.id}`, undefined, {
        method: "DELETE",
        token: fullToken,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/api/v1/rooms/${room.id}`, undefined, {
        token: fullToken,
      })
    ).status,
    400,
  );
}
