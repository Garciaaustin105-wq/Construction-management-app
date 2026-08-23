// Presentational AI-usage meter: "12 / 100 actions this month" + a bar.
//
// Pure props → markup, no data fetching and no server imports, so it is safe in
// both server and client trees. The caller owns where `used`/`max` come from
// (GET /api/ai/quota via src/lib/aiClient.ts).
//
// `max` semantics mirror src/lib/plans.ts `maxAiActionsPerMonth`:
//   null → unlimited (no bar; a plan with no cap)
//   0    → AI disabled on this tier (free / starter / expired / canceled)
//   n    → n actions per calendar month
//
// NOTE: the handoff said a separate LOCAL-AI task was building this component
// and to assume it exists. It did not exist on origin/main, so it is written
// here against the exact prop signature that was specified — {used, max,
// label?} — so either implementation drops in without a call-site change.

const BAR_BASE = "h-1.5 rounded-full transition-all";

export default function AiUsageMeter({
  used,
  max,
  label = "AI actions this month",
}: {
  used: number;
  max: number | null;
  label?: string;
}) {
  const unlimited = max === null;
  const disabled = max === 0;
  // Guard against a divide-by-zero and against a cap the org has overshot
  // (record_ai_action can land one over in a race).
  const pct = unlimited || disabled ? 0 : Math.min(100, Math.round((used / max) * 100));

  // Tone tracks headroom, not raw volume — the number only matters relative to
  // the cap. Amber at 80% is the "you should notice" point, red once spent.
  const tone =
    pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-500" : "bg-blue-600";

  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide">
          {label}
        </p>
        <p className="text-sm font-semibold text-gray-900 tabular-nums">
          {unlimited ? (
            <>
              {used} <span className="font-normal text-gray-400">/ unlimited</span>
            </>
          ) : (
            <>
              {used} <span className="font-normal text-gray-400">/ {max}</span>
            </>
          )}
        </p>
      </div>
      {!unlimited && !disabled && (
        <div className="mt-2 h-1.5 w-full rounded-full bg-gray-100">
          <div className={`${BAR_BASE} ${tone}`} style={{ width: `${pct}%` }} />
        </div>
      )}
      {disabled && (
        <p className="mt-1 text-xs text-gray-500">
          Not included on your current plan.
        </p>
      )}
    </div>
  );
}
