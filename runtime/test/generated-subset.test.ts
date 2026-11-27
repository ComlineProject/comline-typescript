// Exercises a side that provides a subset: the package from
// `generated/subset/`, written by `comline-codegen-typescript`'s
// `generated_subset_matches_the_runtime_test_fixture` test. Two applications
// in one package: `Chat` (0) and `Admin` (2) are the server's, `Events` (1)
// and `Alerts` (3) the client's.
//
// The Hello each end sends lists what it provides and what it calls, so what
// an end leaves out is out of its Hello, and a connection provides nothing the
// handshake didn't accept.

import assert from "node:assert/strict";
import { test } from "node:test";

import { Connection, Datagram3Framing, duplex, RuntimeError, type Peer } from "../src/index.js";
import {
  CONNECTION_IR_HASH,
  Format,
  SERVICES_HELLO,
  accept,
  connect,
  handshake,
  negotiated,
  provideServices,
} from "./generated/subset/connection.js";
import { AdminDispatcher, AdminSender, type Admin } from "./generated/subset/admin.js";
import { ChatSender, type Chat } from "./generated/subset/public.js";

const chat: Chat = {
  async send(_peer: Peer, { text }): Promise<number> {
    return text.length;
  },
};

const admin: Admin = {
  async kick(): Promise<void> {},
};

const framing = () => new Datagram3Framing();

/** The protocols the handshake of `conn` accepted, by wire number. */
const accepted = (conn: Peer, numbers: number[]): number[] => {
  const agreed = negotiated(conn);
  assert.ok(agreed);
  return numbers.filter((n) => agreed.accepts(n));
};

test("a server provides a subset, and the client calls the rest in vain", async () => {
  const [dialler, acceptor] = duplex();
  const served = accept(acceptor, { chat });
  const conn = await connect(dialler);
  const server = await served;

  // The client lists `Chat` and `Admin` (what it calls), the server `Chat`
  // (what it provides) and the client's `Events` and `Alerts` (what it calls).
  // `Admin` isn't in the server's Hello, and `Alerts` isn't in the client's.
  assert.deepEqual(accepted(conn, [0, 1, 2, 3]), [0]);
  assert.deepEqual(accepted(server, [0, 1, 2, 3]), [0]);
  assert.deepEqual(negotiated(conn)?.protocols.get(2), { accepted: false, reason: "unknown_protocol" });

  assert.equal(await new ChatSender(conn).send({ text: "hey" }), 3);
  await assert.rejects(new AdminSender(conn).kick({ user: 1 }), (e: unknown) => {
    assert.ok(e instanceof RuntimeError && e.is("unavailable"));
    assert.deepEqual(e.unavailable, { protocol: "admin::Admin", function: "kick", refused: "unknown_protocol" });
    return true;
  });

  dialler.close();
  await server.closed;
});

test("every protocol provided is the package's whole Hello", async () => {
  const [dialler, acceptor] = duplex();
  const served = accept(acceptor, { chat, admin });
  const conn = await connect(dialler, { events: { async shown() { return true; } }, alerts: { async raised() {} } });
  const server = await served;
  assert.deepEqual(accepted(conn, [0, 1, 2, 3]), [0, 1, 2, 3]);
  assert.deepEqual(accepted(server, [0, 1, 2, 3]), [0, 1, 2, 3]);
  await new AdminSender(conn).kick({ user: 7 });
  dialler.close();
  await server.closed;
});

test("dialling with nothing provided takes no services", async () => {
  const [dialler, acceptor] = duplex();
  const served = accept(acceptor, { chat });
  await connect(dialler);
  const server = await served;
  dialler.close();
  await server.closed;
});

test("provide refuses a protocol the Hello didn't list", async () => {
  // An end whose Hello lists `Chat` alone, as a hand-written one might.
  const [dialler, acceptor] = duplex();
  const served = Connection.accept(acceptor, Format, CONNECTION_IR_HASH, framing(), handshake([SERVICES_HELLO.chat], []));
  const dialled = connect(dialler);
  const server = await served;
  await dialled;

  assert.throws(
    () => new AdminDispatcher(admin).provideOn(server),
    (e: unknown) => {
      assert.ok(e instanceof RuntimeError && e.is("unavailable"));
      assert.deepEqual(e.unavailable, { protocol: "#2", refused: "unknown_protocol" });
      assert.equal(e.message, "`#2` wasn't provided: the handshake didn't accept it (unknown_protocol)");
      return true;
    },
  );
  // What it listed goes through, and nothing was registered for `Admin`.
  assert.doesNotThrow(() => server.provide(0, { calls: () => [], dispatch: async () => {} }));
  dialler.close();
});

test("a protocol the peer refused is skipped, and calling it fails locally", async () => {
  // An older client: its Hello leaves `Admin` out, so the server's `Admin` is refused.
  const [dialler, acceptor] = duplex();
  const agreed = handshake([], [SERVICES_HELLO.chat]);
  const dialled = Connection.connect(dialler, Format, CONNECTION_IR_HASH, framing(), agreed);
  const served = accept(acceptor, { chat, admin });
  const [client, server] = await Promise.all([dialled, served]);
  client.extensions.set(agreed.negotiated!);

  // The connection is up, with `Chat` provided and `Admin` skipped, not failed.
  assert.deepEqual(negotiated(server)?.protocols.get(2), { accepted: false, reason: "unknown_protocol" });
  assert.equal(await new ChatSender(client).send({ text: "hey" }), 3);
  await assert.rejects(new AdminSender(client).kick({ user: 1 }), (e: unknown) => {
    assert.ok(e instanceof RuntimeError && e.is("unavailable"));
    assert.deepEqual(e.unavailable, { protocol: "admin::Admin", function: "kick", refused: "unknown_protocol" });
    return true;
  });
  // Wired by hand, `provide` still refuses it.
  assert.throws(
    () => new AdminDispatcher(admin).provideOn(server),
    (e: unknown) => e instanceof RuntimeError && e.is("unavailable"),
  );
  dialler.close();
  await server.closed;
});

test("a connection with no Hello provides anything", async () => {
  const [dialler, acceptor] = duplex();
  const served = Connection.accept(acceptor, Format, CONNECTION_IR_HASH);
  const dialled = Connection.connect(dialler, Format, CONNECTION_IR_HASH);
  const server = await served;
  await dialled;
  // `comline@1` carries no Hello: there's nothing to check against.
  assert.doesNotThrow(() => provideServices(server, { chat, admin }));
  dialler.close();
});
