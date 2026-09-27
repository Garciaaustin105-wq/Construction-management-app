/**
 * Claim codes: the human-typed string shown on the NVR's setup screen that
 * lets an installer take ownership of a device (CLOUD-B1-SPEC.md section 7,
 * "box identity and telemetry"; cloud/CLOUD-SLICE1-SPEC.md section 1). Pure:
 * no fs, no clock, no network -- the caller supplies `nowMs` and holds the
 * device record.
 *
 * See cloud/CLOUD-SLICE1-SPEC.md section 1 for the full
 * contract each one must satisfy, and cloud/harness/claimCode.harness.mjs for
 * the checks it must pass.
 */

/** Crockford base32, minus I, L, O and U -- all easily confused when
 *  handwritten or read off a screen. Used for the 8 data symbols. */
export const CLAIM_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A device's claim state, exactly as stored on its record. */
export interface ClaimDevice {
  state: "unclaimed" | "claimed" | "revoked";
  code: string | null;
  codeExpiresMs: number | null;
  installerId: string | null;
}

/** The three actions claimStep() accepts. */
export type ClaimAction =
  | { type: "claim"; code: string; installerId: string }
  | { type: "revoke" }
  | { type: "reissue"; code: string; codeExpiresMs: number };

/** Why parseClaimCode() refused an input. */
export type ParseClaimCodeReason = "not_text" | "wrong_length" | "bad_symbol" | "bad_check";

/** Why claimStep() refused an action. */
export type ClaimStepReason = "wrong_state" | "code_mismatch" | "code_expired" | "no_code" | "bad_action";

export type ParseClaimCodeResult = { ok: true; code: string } | { ok: false; reason: ParseClaimCodeReason };

export type ClaimStepResult = { ok: true; device: ClaimDevice } | { ok: false; reason: ClaimStepReason };

/**
 * Render 8 Crockford base32 values (0..31 each) plus a computed check symbol
 * as the canonical claim code shown on the setup screen.
 *
 * Contract:
 * - `values` must be exactly 8 integers, each in 0..31. Any other shape --
 *   wrong length, a non-integer, a value out of range, or a non-array --
 *   is a CALLER BUG: `formatClaimCode` throws rather than guessing (build
 *   rule 10), not a `{ ok: false }` result.
 * - The check value is `(sum over i of values[i] * (i + 1)) mod 37`, drawn
 *   from `CLAIM_ALPHABET + "*~$=U"` -- a distinct 37-symbol alphabet, so a
 *   mistyped check symbol can never also be mistaken for a data symbol.
 * - The result is always exactly `"XXXX-XXXX-C"`: the 8 data symbols as two
 *   hyphen-separated groups of 4 (`CLAIM_ALPHABET[values[i]]`), then a
 *   hyphen, then the one check symbol. No other separators or whitespace.
 */
export function formatClaimCode(values: number[]): string {
  if (!Array.isArray(values)) {
    throw new Error("not an array");
  }
  if (values.length !== 8) {
    throw new Error(values.length === 0 ? "wrong length" : values.length < 8 ? "too short" : "too long");
  }
  let sum = 0;
  let data = "";
  for (let i = 0; i < 8; i++) {
    const v = values[i];
    if (typeof v !== "number" || !Number.isInteger(v)) {
      throw new Error("non-integer value");
    }
    if (v < 0) {
      throw new Error("negative value");
    }
    if (v > 31) {
      throw new Error("value out of range");
    }
    data += CLAIM_ALPHABET.charAt(v);
    sum += v * (i + 1);
  }
  const checkSymbol = (CLAIM_ALPHABET + "*~$=U").charAt(sum % 37);
  return `${data.slice(0, 4)}-${data.slice(4, 8)}-${checkSymbol}`;
}

/**
 * Parse a human-typed claim code back into its canonical `"XXXX-XXXX-C"`
 * form. Never throws: however malformed `input` is, the result is
 * `{ ok: false, reason }`, never an exception (build rule 10 -- a refusal is
 * a value here, because the caller is a person typing at a keyboard, not a
 * programmer).
 *
 * Contract:
 * - Case-insensitive; spaces and hyphens are stripped before parsing.
 * - `O` maps to `0`; `I` and `L` map to `1`.
 * - `reason` is:
 *   - `"not_text"` when `input` is not a string;
 *   - `"wrong_length"` when, after stripping separators, case-folding and
 *     applying the O/I/L mapping, the result is not exactly 9 symbols;
 *   - `"bad_symbol"` when one of the first 8 (data) characters is not in
 *     `CLAIM_ALPHABET`, or the 9th (check) character is not in
 *     `CLAIM_ALPHABET + "*~$=U"` -- the data symbols and the check symbol
 *     are drawn from two different alphabets (see `formatClaimCode`), so a
 *     data position holding one of the check-only symbols (`*~$=U`) is a
 *     `bad_symbol`, not a value to decode;
 *   - `"bad_check"` when the 9th symbol does not equal the check value
 *     `formatClaimCode` would have computed for the first 8.
 * - On success, `code` is the canonical `"XXXX-XXXX-C"` form (uppercase,
 *   hyphenated as formatClaimCode would render it) -- never the raw input
 *   text.
 */
export function parseClaimCode(input: unknown): ParseClaimCodeResult {
  if (typeof input !== "string") {
    return { ok: false, reason: "not_text" };
  }
  const checkAlphabet = CLAIM_ALPHABET + "*~$=U";
  const upper = input.toUpperCase();
  let flat = "";
  for (let i = 0; i < upper.length; i++) {
    const raw = upper.charAt(i);
    if (raw === " " || raw === "-") continue;
    if (raw === "O") {
      flat += "0";
    } else if (raw === "I" || raw === "L") {
      flat += "1";
    } else {
      flat += raw;
    }
  }
  if (flat.length !== 9) {
    return { ok: false, reason: "wrong_length" };
  }
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const value = CLAIM_ALPHABET.indexOf(flat.charAt(i));
    if (value < 0) {
      return { ok: false, reason: "bad_symbol" };
    }
    sum += value * (i + 1);
  }
  const expectedCheck = checkAlphabet.charAt(sum % 37);
  const actualCheck = flat.charAt(8);
  if (checkAlphabet.indexOf(actualCheck) < 0) {
    return { ok: false, reason: "bad_symbol" };
  }
  if (actualCheck !== expectedCheck) {
    return { ok: false, reason: "bad_check" };
  }
  return { ok: true, code: `${flat.slice(0, 4)}-${flat.slice(4, 8)}-${expectedCheck}` };
}

/**
 * Advance a device's claim state machine by one action. Pure and total:
 * never mutates `device`, and never throws on a well-typed but disallowed
 * action -- a refusal is a value (build rule 10). `"bad_action"` covers an
 * `action.type` this function does not recognize.
 *
 * Contract:
 * - `{ type: "claim", code, installerId }` is allowed only from
 *   `"unclaimed"`. It requires `device.code` to be set, `code` to exactly
 *   match the canonical code on file, and `nowMs < device.codeExpiresMs`
 *   (equal counts as expired). On success the device moves to `"claimed"`,
 *   records `installerId`, and clears `code` and `codeExpiresMs` -- the
 *   code is single-use.
 * - `{ type: "revoke" }` is allowed only from `"claimed"`; it moves the
 *   device to `"revoked"`.
 * - `{ type: "reissue", code, codeExpiresMs }` is allowed from
 *   `"unclaimed"` or `"revoked"`; it moves the device to `"unclaimed"` with
 *   the given `code` and `codeExpiresMs`, and clears `installerId`.
 * - Refusal reasons: `"wrong_state"` (the action is not allowed from the
 *   device's current state), `"no_code"` (a claim was attempted but
 *   `device.code` is null), `"code_expired"` (a claim was attempted at or
 *   after `device.codeExpiresMs`), `"code_mismatch"` (a claim's `code` does
 *   not match the one on file), `"bad_action"` (an unrecognized
 *   `action.type`).
 * - Returns `{ ok: true, device }` with a brand-new object on success, or
 *   `{ ok: false, reason }` on refusal. The input `device` object is never
 *   mutated either way.
 */
export function claimStep(device: ClaimDevice, action: ClaimAction, nowMs: number): ClaimStepResult {
  switch (action.type) {
    case "claim": {
      if (device.state !== "unclaimed") return { ok: false, reason: "wrong_state" };
      if (device.code === null) return { ok: false, reason: "no_code" };
      if (device.codeExpiresMs === null || nowMs >= device.codeExpiresMs) {
        return { ok: false, reason: "code_expired" };
      }
      if (action.code !== device.code) return { ok: false, reason: "code_mismatch" };
      return {
        ok: true,
        device: { state: "claimed", code: null, codeExpiresMs: null, installerId: action.installerId },
      };
    }
    case "revoke": {
      if (device.state !== "claimed") return { ok: false, reason: "wrong_state" };
      return {
        ok: true,
        device: { state: "revoked", code: null, codeExpiresMs: null, installerId: device.installerId },
      };
    }
    case "reissue": {
      if (device.state === "claimed") return { ok: false, reason: "wrong_state" };
      return {
        ok: true,
        device: { state: "unclaimed", code: action.code, codeExpiresMs: action.codeExpiresMs, installerId: null },
      };
    }
    default:
      return { ok: false, reason: "bad_action" };
  }
}
