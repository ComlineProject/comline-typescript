// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/**
 * Bounds on types (core#98): the checks the codecs and generated code run
 * while encoding and decoding, and the single `char`. The TypeScript mirror
 * of `comline-runtime`'s `bounds` module.
 *
 * A bound is a maximum: a string (`char[max N]`) holds at most N
 * characters, a dynamic array (`T[max N]`) at most N items, and a type that
 * can contain itself (`@max_depth = D`) nests at most D levels deep. A value
 * over it isn't a value of that type: a decoder refuses it like malformed
 * input, and an encoder refuses to write it. Either way the error is
 * {@link RuntimeError.boundExceeded}, naming the {@link Measure}.
 *
 * - **Strings count characters** (Unicode scalar values), never bytes or
 *   UTF-16 units, and are never normalized. A string of at most N UTF-16
 *   units (or N UTF-8 bytes) has at most N characters, so it's never
 *   counted; one of more than 2 × N units (or 4 × N bytes) has more, so it's
 *   refused uncounted. Only in between are characters counted.
 * - **Arrays** are refused at a count above N, before anything is read.
 * - **Depth** counts the values of the recursive type on the way down: the
 *   outermost is level 1, and a value at level D + 1 is refused.
 *
 * Bounds checks are always on: they're part of the type. Validators
 * (`validate_on_decode`) are a separate, later pass.
 */

import { RuntimeError } from "./contract.js";

/** What a bound limits: a string's characters, an array's items, a recursive type's levels. */
export type Measure = "chars" | "items" | "depth";

/** How many Unicode scalar values `s` holds: its UTF-16 units less the second half of each pair. */
export function countChars(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const unit = s.charCodeAt(i);
    if (unit >= 0xdc00 && unit <= 0xdfff && i > 0) {
      const prev = s.charCodeAt(i - 1);
      if (prev >= 0xd800 && prev <= 0xdbff) n--;
    }
  }
  return n;
}

/**
 * Refuses `s` unless it holds at most `max` characters. Free for a string
 * of at most `max` UTF-16 units; refused uncounted above 2 × `max`.
 */
export function checkChars(s: string, max: number): void {
  if (s.length <= max) return;
  if (s.length > 2 * max || countChars(s) > max) throw RuntimeError.boundExceeded("chars");
}

/**
 * Refuses `s` unless it holds exactly `length` characters (`char[N]`): more
 * is over the bound, fewer isn't a value of the type at all.
 */
export function checkCharsExact(s: string, length: number): void {
  if (s.length < length) throw RuntimeError.serialization();
  if (s.length > 2 * length) throw RuntimeError.boundExceeded("chars");
  const n = s.length === length ? length : countChars(s);
  if (n > length) throw RuntimeError.boundExceeded("chars");
  if (n < length) throw RuntimeError.serialization();
}

/** Refuses an array of `count` items over a maximum of `max`. */
export function checkItems(count: number, max: number): void {
  if (count > max) throw RuntimeError.boundExceeded("items");
}

/**
 * Whether `value` is a single `char`: a string of exactly one Unicode scalar
 * value (one UTF-16 unit that isn't a surrogate, or one surrogate pair).
 */
export function isChar(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value.length === 1) {
    const u = value.charCodeAt(0);
    return u < 0xd800 || u > 0xdfff;
  }
  if (value.length !== 2) return false;
  const hi = value.charCodeAt(0);
  const lo = value.charCodeAt(1);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff;
}

/** Refuses anything but a single `char` (see {@link isChar}). */
export function checkChar(value: unknown): asserts value is string {
  if (!isChar(value)) throw RuntimeError.serialization();
}

/**
 * The nesting of each recursive type while one value is encoded or decoded:
 * how many values of it are open, keyed by the type's layout.
 */
export class Depths {
  private readonly open = new Map<object, number>();

  /** Enters one more value of `type`, refusing level `max + 1`. */
  enter(type: object, max: number): void {
    const level = this.open.get(type) ?? 0;
    if (level >= max) throw RuntimeError.boundExceeded("depth");
    this.open.set(type, level + 1);
  }

  leave(type: object): void {
    this.open.set(type, (this.open.get(type) ?? 1) - 1);
  }
}
