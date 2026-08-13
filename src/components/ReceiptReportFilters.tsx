"use client";

import { useRouter } from "next/navigation";

// Filter controls for the office Receipts report. Pushes the selection into the
// URL so the server component re-renders with the filtered set. "All" = empty
// value. Mirrors src/components/PhotoFilters.tsx.
export default function ReceiptReportFilters({
  jobs,
  workers,
  costCodes,
  current,
}: {
  jobs: { id: string; name: string }[];
  workers: { id: string; name: string }[];
  costCodes: { id: string; label: string }[];
  current: {
    job: string;
    worker: string;
    code: string;
    from: string;
    to: string;
  };
}) {
  const router = useRouter();

  function go(patch: Partial<typeof current>) {
    const next = { ...current, ...patch };
    const params = new URLSearchParams();
    if (next.job) params.set("job", next.job);
    if (next.worker) params.set("worker", next.worker);
    if (next.code) params.set("code", next.code);
    if (next.from) params.set("from", next.from);
    if (next.to) params.set("to", next.to);
    const qs = params.toString();
    router.push(qs ? `/admin/reports/receipts?${qs}` : "/admin/reports/receipts");
  }

  const selectCls =
    "mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase font-semibold text-gray-500">Job</span>
          <select
            value={current.job}
            onChange={(e) => go({ job: e.target.value })}
            className={selectCls}
          >
            <option value="">All jobs</option>
            {jobs.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[10px] uppercase font-semibold text-gray-500">Worker</span>
          <select
            value={current.worker}
            onChange={(e) => go({ worker: e.target.value })}
            className={selectCls}
          >
            <option value="">Everyone</option>
            {workers.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase font-semibold text-gray-500">Cost code</span>
          <select
            value={current.code}
            onChange={(e) => go({ code: e.target.value })}
            className={selectCls}
          >
            <option value="">All codes</option>
            {costCodes.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">From</span>
            <input
              type="date"
              value={current.from}
              onChange={(e) => go({ from: e.target.value })}
              className={selectCls}
            />
          </label>
          <label className="block">
            <span className="text-[10px] uppercase font-semibold text-gray-500">To</span>
            <input
              type="date"
              value={current.to}
              onChange={(e) => go({ to: e.target.value })}
              className={selectCls}
            />
          </label>
        </div>
      </div>
    </div>
  );
}