#!/usr/bin/env node
// a2ahub — manager CLI for a running A2Ahub (full or --headless).
// Talks to the loopback owner API at /api/v1 with a scoped manager token.
//
// Command handlers live in scripts/cli/*.js and are registered here against
// the shared context (api, post, print, table, when, pick, findRoom, flags…).
import { makeContext } from "./cli/context.js";
import { registerAuth, readPassword, revokeSelf } from "./cli/auth.js";
import { registerRooms } from "./cli/rooms.js";
import { registerAccess } from "./cli/access.js";
import { registerAdmin } from "./cli/admin.js";

const HELP = `a2ahub — manage a local A2Ahub from the command line

Setup
  a2ahub login [--name NAME] [--scopes read,chat,admin] [--password-file FILE]
  a2ahub logout [--local]            Revoke and forget this CLI's token
                                     (--local forgets it even if the Hub
                                     cannot be reached to revoke it)

Overview
  a2ahub status                      Hub health, activity and attention items
  a2ahub admin                       Full admin summary (same as the Admin page)
  a2ahub audit [--limit N]           Recent administrative actions

Conversations (ROOM = id, title, or a unique part of either)
  a2ahub rooms [--archived]          List conversations
  a2ahub show ROOM [--last N]        Print recent messages
  a2ahub new [TITLE] [--folder F]    Create a conversation
  a2ahub say ROOM TEXT... [--watch]  Send a message (starts a bounded burst)
  a2ahub continue ROOM [--watch]     Continue the current topic
  a2ahub watch ROOM                  Follow a conversation live (Ctrl+C detaches)
  a2ahub stop ROOM | stop --all      Stop agents (attempts remote cancellation)
  a2ahub resume ROOM                 Unpause without starting work
  a2ahub archive ROOM | restore ROOM
  a2ahub move ROOM FOLDER|none
  a2ahub folders                     List folders
  a2ahub folder create NAME [--color C] | folder delete NAME

Agents and access
  a2ahub agents                      Directory with live status
  a2ahub access                      Pending requests and approved agents
  a2ahub access approve REQUEST --code CODE [--room ROOM]
  a2ahub access deny REQUEST
  a2ahub access revoke AGENT

Pipeline
  a2ahub events ROOM [--cursor N]   Show conversation event activity

Data
  a2ahub backup                      Write a workspace backup (no credentials)
  a2ahub tokens                      List manager tokens

Options: --json for machine-readable output (with --watch: one JSON object
per line), --url to choose a loopback Hub address.
Put -- before text that starts with "--": a2ahub say ROOM -- "--compare plans"
Environment: A2AHUB_URL, A2AHUB_MANAGER_TOKEN, A2AHUB_CLI_HOME.
Ctrl+C while watching only detaches; agents keep running until you stop them.`;

const ctx = makeContext(process.argv.slice(2));
const { flags, positional, json, fail } = ctx;

// Wire the auth helpers that live in cli/auth.js into the shared context so
// login/logout can use them without duplicating the implementations.
ctx.readPassword = (f) => readPassword(f || flags, fail);
ctx.revokeSelf = (config) => revokeSelf(ctx.hubOrigin, config);

const auth = registerAuth(ctx);
const rooms = registerRooms(ctx);
const access = registerAccess(ctx);
const admin = registerAdmin(ctx);

async function main() {
  const [command, sub, ...rest] = positional;
  if (!command || flags.help || command === "help") return console.log(HELP);
  switch (command) {
    case "login":
      return auth.login();
    case "logout":
      return auth.logout();
    case "status":
      return admin.status();
    case "admin":
      return admin.admin();
    case "audit":
      return admin.audit();
    case "rooms":
      return rooms.rooms();
    case "show":
      return rooms.show(sub);
    case "new":
      return rooms.create(sub, rest);
    case "say":
      return rooms.say(sub, rest);
    case "continue":
      return rooms.continue(sub);
    case "watch":
      return rooms.watch(sub);
    case "stop":
      return rooms.stop(sub);
    case "resume":
    case "archive":
    case "restore":
      return rooms.lifecycle(command, sub);
    case "move":
      return rooms.move(sub, rest);
    case "folders":
      return rooms.folders();
    case "folder":
      return rooms.folder(sub, rest);
    case "agents":
      return access.agents();
    case "access":
      return access.access(sub, rest);
    case "events":
      return rooms.events(positional);
    case "backup":
      return admin.backup();
    case "tokens":
      return admin.tokens();
    default:
      fail(`Unknown command "${command}". Run: a2ahub help`);
  }
}

main().catch((error) => {
  if (json) console.error(JSON.stringify({ error: error.message }));
  else console.error(`a2ahub: ${error.message}`);
  process.exit(error.exitCode || 1);
});
