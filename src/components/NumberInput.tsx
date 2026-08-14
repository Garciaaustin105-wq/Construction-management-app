"use client";

import { useState } from "react";

// Controlled numeric text input that fixes the "stuck leading zero" bug you get
// with <input type="number" value={numberState}>. A number input bound to a
// number state renders a forced "0" when the value is 0; appending to it can
// leave a leading zero in the DOM ("0900") because the browser's number-input
// `.value` normalizes "09"→"9" and React then thinks the DOM already matches
// and skips the update. This component instead:
//   - renders type="text" + inputMode="decimal" (numeric keyboard, fully
//     controlled so React always writes the exact displayed string — no quirk),
//   - shows an EMPTY field when the value is 0 (nothing to append a leading
//     zero to),
//   - keeps a local string draft so partial decimals like "0." and "12.5" type
//     naturally (parseFloat-on-every-keystroke would eat the trailing dot),
//   - sanitizes to digits + a single dot,
//   - calls onChange(number) on every change so the parent's NUMBER state stays
//     the source of truth (compute/save logic is untouched).
// External value changes (template load, history autofill, reset) are synced
// into the draft during render — React's supported "adjust state when a prop
// changes" pattern — using a prevValue state (no refs/refs-in-render, no
// effect/set-state-in-effect). The override fires only when the parsed draft
// diverges from the incoming value, which naturally distinguishes an external
// change (override) from the user's own typing (Number(draft) === value, so
// the draft is preserved as-is, including partial forms like "12.").
export default function NumberInput({
  value,
  onChange,
  disabled,
  placeholder,
  className,
  id,
}: {
  value: number;
  onChange: (n: number) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  // Show empty for 0 so there's never a forced "0" to append to (the root of
  // the stuck-zero bug). Any non-zero number renders its plain string form.
  const toStr = (n: number) => (n === 0 ? "" : String(n));
  const [draft, setDraft] = useState<string>(() => toStr(value));
  // Tracks the value the draft was last synced from. Stored in state (not a
  // ref) so it can be read/written during render under the strict hooks rules.
  const [prevValue, setPrevValue] = useState(value);

  // Sync from an incoming value change (template load, history autofill,
  // programmatic reset). During typing, value changes alongside draft and
  // Number(draft) === value, so the override is skipped and partial forms
  // ("12.", "0.5") are preserved. A genuine external change makes the parsed
  // draft differ from value, so we refresh the draft to match.
  if (prevValue !== value) {
    setPrevValue(value);
    const parsed = draft === "" ? 0 : Number(draft);
    if (parsed !== value) {
      setDraft(toStr(value));
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    // Digits + a single dot only (all these fields are min 0, no minus).
    let v = e.target.value.replace(/[^0-9.]/g, "");
    const parts = v.split(".");
    if (parts.length > 2) v = parts[0] + "." + parts.slice(1).join("");
    setDraft(v);
    const n = v === "" ? 0 : Number(v);
    onChange(Number.isNaN(n) ? 0 : n);
  }

  function handleBlur() {
    // Normalize the display to the canonical number string (drops a trailing
    // dot like "12." → "12", keeps "" empty for 0).
    const n = draft === "" ? 0 : Number(draft);
    setDraft(toStr(Number.isNaN(n) ? 0 : n));
  }

  return (
    <input
      id={id}
      type="text"
      inputMode="decimal"
      value={draft}
      onChange={handleChange}
      onBlur={handleBlur}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
    />
  );
}