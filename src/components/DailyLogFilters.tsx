"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

export default function DailyLogFilters({ jobs, currentJob, currentStatus, currentFrom, currentTo }: { jobs: { id: string; name: string }[]; currentJob: string; currentStatus: string; currentFrom: string; currentTo: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [job, setJob] = useState(currentJob);
  const [status, setStatus] = useState(currentStatus);
  const [from, setFrom] = useState(currentFrom);
  const [to, setTo] = useState(currentTo);

  function go() {
    // Seed from the current URL so the list's `?view=` (cards/table) survives.
    const p = new URLSearchParams(searchParams.toString());
    if (job) p.set("job", job); else p.delete("job");
    if (status) p.set("status", status); else p.delete("status");
    if (from) p.set("from", from); else p.delete("from");
    if (to) p.set("to", to); else p.delete("to");
    const qs = p.toString();
    router.push(qs ? `/daily-logs?${qs}` : "/daily-logs");
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">Job</span>
        <select value={job} onChange={e => { setJob(e.target.value); go(); }} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="">All jobs</option>
          {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">Status</span>
        <select value={status} onChange={e => { setStatus(e.target.value); go(); }} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="">All</option>
          <option value="submitted">Submitted</option>
          <option value="reviewed">Reviewed</option>
        </select>
      </label>
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">From</span>
        <input type="date" value={from} onChange={e => { setFrom(e.target.value); go(); }} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white" />
      </label>
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">To</span>
        <input type="date" value={to} onChange={e => { setTo(e.target.value); go(); }} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white" />
      </label>
    </div>
  );
}