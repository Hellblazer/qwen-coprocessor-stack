// SPDX-License-Identifier: MIT
//
// Error-message support for `Backend.pin_only` (bead 9jui). Kept out of
// backends.ts so pool.ts and server.ts can import it without touching the
// module their tests mock wholesale.

import type { Backend } from "./types.js";

type Modality = NonNullable<Backend["modality"]>;

/**
 * The sentence fragment appended to a "no backend available" error when the
 * pool holds `pin_only` backends that automatic selection skipped: names them
 * and says how to select one. Returns "" when there is nothing to say, so
 * callers can concatenate unconditionally. `how` is the entry point's own
 * selector wording (e.g. "opts.backend"); `modalities` limits the hint to
 * backends the calling tool could have used (default: chat-capable ones).
 */
export function pinOnlyHint(
  pool: readonly Backend[],
  how: string,
  modalities: readonly Modality[] = ["text", "multimodal"],
): string {
  const ids = pool
    .filter((b) => b.pin_only === true && modalities.includes(b.modality ?? "text"))
    .map((b) => b.id);
  if (ids.length === 0) return "";
  return `; pin-only backends exist [${ids.join(", ")}] and are never chosen automatically: select one with ${how}`;
}
