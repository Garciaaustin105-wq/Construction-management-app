// What to do with settleable visits when a crew presses End shift.
//
// End shift is the primary settlement trigger, and the reason is behavioural
// rather than technical: it is the one button crews reliably press, because it
// is how they get paid. A timer on the phone would not fire — the app is
// backgrounded, the screen is off, sometimes the battery is dead — and the
// nightly cron deliberately never emails, because it runs unattended.
//
// So this is the moment a real session exists and the ordinary status route can
// do the completing and the emailing. One email path, always.
//
// Pure: decides, executes nothing. The caller performs the calls.

export type SettleableRow = {
  visit_id: string;
  completion_mode: string;
  already_queued: boolean;
};

export type FlushAction =
  | { kind: "complete"; visitId: string }
  | { kind: "queue"; visitId: string };

/**
 * Two rules, and the second is a safety property rather than a convenience.
 *
 * ALREADY QUEUED IS SKIPPED — a human already has it, and re-stamping would
 * reorder the office's queue and make an old item look new.
 *
 * ANYTHING THAT IS NOT EXACTLY "auto" QUEUES. Not a switch on known modes with
 * a send-by-default fallback: an unrecognised value — a typo, a mode added
 * later, a column read before a migration lands — must never cause a customer
 * to be emailed. Queuing is always recoverable; a sent email is not.
 */
export function planFlush(rows: SettleableRow[]): FlushAction[] {
  const actions: FlushAction[] = [];
  for (const r of rows) {
    if (r.already_queued) continue;
    actions.push(
      r.completion_mode === "auto"
        ? { kind: "complete", visitId: r.visit_id }
        : { kind: "queue", visitId: r.visit_id }
    );
  }
  return actions;
}

/** One sentence for the toast. Says what happened to the customer, not what
 *  happened to the database — "sent" is the part a crew member cares about. */
export function summariseFlush(
  actions: FlushAction[],
  failed: number
): string | null {
  const sent = actions.filter((a) => a.kind === "complete").length;
  const queued = actions.filter((a) => a.kind === "queue").length;
  if (sent === 0 && queued === 0 && failed === 0) return null;

  const parts: string[] = [];
  if (sent > 0) parts.push(`${sent} customer${sent === 1 ? "" : "s"} notified`);
  if (queued > 0) parts.push(`${queued} sent to the office to approve`);
  if (failed > 0) parts.push(`${failed} could not be settled`);
  return parts.join(", ");
}
