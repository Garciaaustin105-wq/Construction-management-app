"use client";
import { useRouter, useSearchParams } from "next/navigation";
export default function ChangeOrderFilters({ jobs, currentJob, currentStatus }: { jobs:{id:string;name:string}[]; currentJob:string; currentStatus:string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  function go(job: string, status: string) {
    // Start from the current params so the list's `?view=` (cards/table) — and
    // anything else on the URL — survives a filter change.
    const p = new URLSearchParams(searchParams.toString());
    if (job) p.set("job", job); else p.delete("job");
    if (status) p.set("status", status); else p.delete("status");
    const qs = p.toString();
    router.push(qs ? `/change-orders?${qs}` : "/change-orders");
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">Job</span>
        <select value={currentJob} onChange={e=>go(e.target.value,currentStatus)} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="">All jobs</option>{jobs.map(j=><option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">Status</span>
        <select value={currentStatus} onChange={e=>go(currentJob,e.target.value)} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="">All</option>
          <option value="draft">Draft</option>
          <option value="submitted">Submitted</option>
          <option value="sent">Sent</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
          <option value="void">Void</option>
        </select>
      </label>
    </div>
  );
}