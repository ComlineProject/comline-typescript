// A stand-in for a third-party package implementing a framing and a codec,
// which `acme.ts` (generated with both mapped onto it) imports from as
// `acme-encodings`: `tsconfig.generated.json` points that name here. It
// re-exports runtime classes under its own names, which is all the generator
// can tell apart: it names the mapped classes and never looks inside them.
export { JsonRpcFraming as LinesFraming, JsonCodec as CborCodec } from "@comline/runtime";
