import test from "node:test";
import { once } from "node:events";
import { startHeadlessServer } from "./helpers/admin-harness.js";
import { authSection } from "./helpers/admin-auth.js";
import { roomsSection } from "./helpers/admin-rooms.js";
import { accessSection } from "./helpers/admin-access.js";
import { adminSection } from "./helpers/admin-admin.js";
import { cliTokensSection } from "./helpers/admin-cli-tokens.js";
import {
  cliAuthSection,
  passwordSection,
} from "./helpers/admin-cli-auth.js";

test("headless owner API: manager token scopes, folders, archive, admin, password and CLI", async () => {
  const ctx = await startHeadlessServer();
  const { child } = ctx;
  try {
    const state = await authSection(ctx);
    await roomsSection(ctx, state);
    await accessSection(ctx, state);
    await adminSection(ctx, state);
    await cliTokensSection(ctx, state);
    await cliAuthSection(ctx, state);
    await passwordSection(ctx, state);
  } finally {
    if (child.exitCode === null) {
      const ended = once(child, "exit");
      child.kill();
      await ended;
    }
  }
});
