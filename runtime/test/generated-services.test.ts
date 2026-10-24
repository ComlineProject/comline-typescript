// Exercises the package-level output: `Services`, `serve` and `connect` from
// `generated/services/connection.ts`, with every protocol on one connection
// over `packed@1`. Written by `comline-codegen-typescript`'s
// `generated_services_match_the_runtime_test_fixture` test.

import assert from "node:assert/strict";
import { test } from "node:test";

import { duplex, type Peer } from "../src/index.js";
import { Format, connect, serve } from "./generated/services/connection.js";
import { AccountSender, PlayerSender, type Account, type Player } from "./generated/services/game.js";
import {
  EventsSender,
  InventorySender,
  type Events,
  type Inventory,
  type Item,
} from "./generated/services/items.js";

const account: Account = {
  async login(_peer: Peer, { name }): Promise<number> {
    return name.length;
  },
};

const player: Player = {
  async level(_peer: Peer, { id }): Promise<bigint> {
    return BigInt(id) * 10n;
  },
};

/** Tells the client how many items there are before answering. */
const inventory: Inventory = {
  async items(peer: Peer, { id }): Promise<Item[]> {
    const items = Array.from({ length: id }, (_, i) => ({ name: `item${i}`, count: i + 1 }));
    await new EventsSender(peer).changed({ count: items.length });
    return items;
  },
};

test("one connection carries every protocol, over packed@1", async () => {
  assert.equal(Format.name, "packed@1");
  const [dialler, acceptor] = duplex();
  const seen: number[] = [];
  const events: Events = {
    async changed(_peer: Peer, { count }): Promise<void> {
      seen.push(count);
    },
  };

  const served = serve(acceptor, { account, player, inventory });
  const conn = await connect(dialler, { events });

  assert.equal(await new AccountSender(conn).login({ name: "ana" }), 3);
  assert.equal(await new PlayerSender(conn).level({ id: 3 }), 30n);
  assert.deepEqual(await new InventorySender(conn).items({ id: 2 }), [
    { name: "item0", count: 1 },
    { name: "item1", count: 2 },
  ]);
  assert.deepEqual(seen, [2]);

  dialler.close();
  await served;
});
