import assert from "node:assert/strict";
import { test } from "node:test";

import {
  Client,
  DatagramFraming,
  FRAMING_DATAGRAM,
  Handshake,
  JsonCodec,
  JsonRpcFraming,
  type Codec,
  type Dispatch,
  type Envelope,
  type Framing,
  type Kind,
  Reply,
  RuntimeError,
  Server,
  duplex,
} from "../src/index.js";

// A hand-written stand-in for what the generator will emit, mirroring the Rust
// end-to-end test's `Chat`:
//
//   protocol Chat {
//     function send(text: str) -> Message ! Rejected;   // ordinal 0, error ord 0
//     function note(text: str);                          // ordinal 1, one-way
//   }
interface Message {
  body: string;
  seq: number;
}
interface Rejected {
  reason: string;
}

interface Chat {
  send(text: string): Promise<Message>; // rejects with { app: Rejected } | { runtime }
  note(text: string): Promise<void>;
}

const CHAT_CALLS = ["send", "note"] as const;

class ChatDispatcher implements Dispatch {
  constructor(private readonly svc: Chat) {}

  calls(): readonly string[] {
    return CHAT_CALLS;
  }

  async dispatch(call: Kind, params: Uint8Array, codec: Codec, reply: Reply): Promise<void> {
    switch ("id" in call ? call.id : -1) {
      case 0: {
        const { text } = codec.decode<{ text: string }>(params);
        try {
          reply.ok(codec.encode(await this.svc.send(text)));
        } catch (e) {
          if (e instanceof RejectedError) reply.err(0, codec.encode(e.data));
          else throw e;
        }
        return;
      }
      case 1: {
        const { text } = codec.decode<{ text: string }>(params);
        await this.svc.note(text);
        return; // one-way: leave the reply as `none`
      }
      default:
        throw RuntimeError.unknownCall();
    }
  }
}

class RejectedError extends Error {
  constructor(readonly data: Rejected) {
    super(data.reason);
  }
}

class ChatClient {
  constructor(private readonly client: Client) {}

  async send(text: string): Promise<Message> {
    const env: Envelope = await this.client.call({ id: 0, name: "send" }, { text });
    if ("ok" in env) return this.client.codec.decode<Message>(env.ok);
    if (env.err.id === 0) throw new RejectedError(this.client.codec.decode<Rejected>(env.err.body));
    throw RuntimeError.remote(env.err.id);
  }

  async note(text: string): Promise<void> {
    await this.client.notify({ id: 1, name: "note" }, { text });
  }
}

const IR_HASH = 0xbdbe5c6fd7420bd0n;

function stack(framing: () => Framing): { codec: Codec; framing: Framing; hs: Handshake } {
  const codec = new JsonCodec();
  const f = framing();
  return {
    codec,
    framing: f,
    hs: new Handshake({ irHash: IR_HASH, wireFormat: codec.name, framing: f.name }),
  };
}

for (const [label, mkFraming] of [
  ["datagram", () => new DatagramFraming()],
  ["jsonrpc", () => new JsonRpcFraming()],
] as const) {
  test(`${label}: a client ⇆ provider round-trip over duplex()`, async () => {
    const [clientSide, providerSide] = duplex();
    const notes: string[] = [];

    const svc: Chat = {
      async send(text) {
        if (text === "") throw new RejectedError({ reason: "empty" });
        return { body: `echo: ${text}`, seq: 1 };
      },
      async note(text) {
        notes.push(text);
      },
    };

    const s = stack(mkFraming);
    const provider = new Server(new ChatDispatcher(svc), s.codec, s.framing).serveHandshaked(
      providerSide,
      s.hs,
    );

    const c = stack(mkFraming);
    const chat = new ChatClient(await Client.connect(clientSide, c.codec, c.hs, c.framing));

    assert.equal((await chat.send("hi")).body, "echo: hi");

    await assert.rejects(
      chat.send(""),
      (e: unknown) => e instanceof RejectedError && e.data.reason === "empty",
    );

    await chat.note("saved"); // one-way

    clientSide.close();
    await provider;
    assert.deepEqual(notes, ["saved"]);
  });
}

test("connect refuses a peer on a wire-format mismatch", async () => {
  const [clientSide, providerSide] = duplex();

  // provider speaks a differently-named codec
  const providerHs = new Handshake({
    irHash: IR_HASH,
    wireFormat: "msgpack",
    framing: FRAMING_DATAGRAM,
  });
  void providerSide.send(providerHs.encode()); // just the handshake frame
  void providerSide.recv();

  await assert.rejects(
    Client.connect(clientSide, new JsonCodec(), new Handshake({
      irHash: IR_HASH,
      wireFormat: "json",
      framing: FRAMING_DATAGRAM,
    })),
    (e: unknown) => e instanceof RuntimeError && e.is("handshake"),
  );
});
