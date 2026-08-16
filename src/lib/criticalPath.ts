// CPM critical-path calculation for the hand-rolled Gantt.
//
// Pure, dependency-free (no date-fns): all date math uses plain Date in UTC
// (project scheduling is date-based, not time-based -> no DST drift). Given a
// list of job_tasks, runs a forward pass (earliest start/finish) and a backward
// pass (latest start/finish), computes total float, and flags the critical
// path (float === 0). Dependencies are FS only in v1 (dependency_type is stored
// for future SS/FF/SF support but the calc treats every link as Finish-to-Start).
//
// Convention: a task with start_date S and end_date E (inclusive) occupies days
// S..E, so duration = dayIndex(E) - dayIndex(S) + 1 and earliestFinish =
// earliestStart + duration (the next available day for a successor). A
// milestone has end_date = null and duration 0 (an instantaneous point).
//
// Cycle detection via Kahn's topological sort: if not every task is ordered,
// the predecessor graph has a cycle (the UI rejects the link with a toast).

export interface CpmTask {
  id: string;
  start_date: string; // 'YYYY-MM-DD'
  end_date: string | null; // null = milestone (point in time)
  predecessor_ids: string[] | null;
}

export interface CpmEntry {
  isCritical: boolean;
  float: number; // total float in days
  earliestStart: number;
  earliestFinish: number;
  latestStart: number;
  latestFinish: number;
}

export interface CpmResult {
  ok: boolean;
  cycleError: boolean;
  entries: Map<string, CpmEntry>;
}

// Day index from epoch (UTC) for a 'YYYY-MM-DD' string.
export function dayIndex(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

// 'YYYY-MM-DD' from a day index.
export function fromDayIndex(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

export function computeCriticalPath(tasks: CpmTask[]): CpmResult {
  const empty: CpmResult = { ok: true, cycleError: false, entries: new Map() };
  if (tasks.length === 0) return empty;

  const ids = new Set(tasks.map((t) => t.id));

  // successors[predId] = list of successor task ids; inDegree[succId] = #preds.
  const successors = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const t of tasks) {
    successors.set(t.id, []);
    inDegree.set(t.id, 0);
  }
  for (const t of tasks) {
    const preds = t.predecessor_ids ?? [];
    for (const p of preds) {
      // Skip self-links and references to ids not in this set (app validates,
      // but be defensive so a stale id can't crash the calc).
      if (p === t.id || !ids.has(p)) continue;
      successors.get(p)!.push(t.id);
      inDegree.set(t.id, inDegree.get(t.id)! + 1);
    }
  }

  // Kahn's topological sort -> cycle detection.
  const order: string[] = [];
  const queue: string[] = [];
  for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
  const deg = new Map(inDegree);
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const s of successors.get(id) ?? []) {
      deg.set(s, deg.get(s)! - 1);
      if (deg.get(s) === 0) queue.push(s);
    }
  }
  if (order.length !== tasks.length) {
    return { ok: false, cycleError: true, entries: new Map() };
  }

  const duration = (t: CpmTask): number =>
    t.end_date ? dayIndex(t.end_date) - dayIndex(t.start_date) + 1 : 0;

  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Forward pass (topological order): earliestStart = max(own start, pred earliestFinish).
  const es = new Map<string, number>(); // earliestStart
  const ef = new Map<string, number>(); // earliestFinish
  for (const id of order) {
    const t = byId.get(id)!;
    let start = dayIndex(t.start_date);
    for (const p of t.predecessor_ids ?? []) {
      if (!ids.has(p) || p === id) continue;
      start = Math.max(start, ef.get(p) ?? start);
    }
    es.set(id, start);
    ef.set(id, start + duration(t));
  }

  // Project end = latest earliestFinish.
  let projectEnd = 0;
  for (const f of ef.values()) projectEnd = Math.max(projectEnd, f);

  // Backward pass (reverse topological order): latestFinish = min(successor latestStart),
  // or projectEnd for tasks with no successors.
  const ls = new Map<string, number>(); // latestStart
  const lf = new Map<string, number>(); // latestFinish
  for (const id of [...order].reverse()) {
    const succs = successors.get(id) ?? [];
    let finish = projectEnd;
    for (const s of succs) finish = Math.min(finish, ls.get(s) ?? finish);
    lf.set(id, finish);
    ls.set(id, finish - duration(byId.get(id)!));
  }

  const entries = new Map<string, CpmEntry>();
  for (const t of tasks) {
    const e = es.get(t.id)!;
    const f = ef.get(t.id)!;
    const lst = ls.get(t.id)!;
    const lft = lf.get(t.id)!;
    const float = lst - e;
    entries.set(t.id, {
      isCritical: float === 0,
      float,
      earliestStart: e,
      earliestFinish: f,
      latestStart: lst,
      latestFinish: lft,
    });
  }

  return { ok: true, cycleError: false, entries };
}