// A stand-in for a third-party package implementing a framing, a codec and a
// handshake, which `acme.ts` and `hello/` (generated with them mapped onto
// it) import from as `acme-encodings`: `tsconfig.generated.json` points that
// name here. The framing and codec re-export runtime classes under its own
// names, which is all the generator can tell apart: it names the mapped
// classes and never looks inside them.
import { RuntimeError, type Facts, type Handshake, type Transport } from "@comline/runtime";

export { JsonRpcFraming as LinesFraming, JsonCodec as CborCodec } from "@comline/runtime";

const HELLO = new TextEncoder().encode("hello");

/**
 * `com.acme.hello@1`: each end sends `hello` and wants it back. Counts the
 * times it ran, on either side, in {@link HelloHandshake.ran}.
 */
export class HelloHandshake implements Handshake {
  static ran = 0;
  readonly name = "com.acme.hello@1";

  initiate(transport: Transport, _local: Facts): Promise<void> {
    return this.exchange(transport);
  }

  respond(transport: Transport, _local: Facts): Promise<void> {
    return this.exchange(transport);
  }

  private async exchange(transport: Transport): Promise<void> {
    HelloHandshake.ran += 1;
    await transport.send(HELLO);
    const peer = await transport.recv();
    if (peer.length !== HELLO.length || !peer.every((b, i) => b === HELLO[i])) {
      throw RuntimeError.handshake();
    }
  }
}
