"use client";
import { useRouter } from "next/navigation";

export default function PunchFilters({ jobs, currentJob, currentStatus, currentPriority }: { jobs: { id: string; name: string }[]; currentJob: string; currentStatus: string; currentPriority: string }) {
  const router = useRouter();
  function go(job: string, status: string, priority: string) {
    const p = new URLSearchParams();
    if (job) p.set("job", job);
    if (status) p.set("status", status);
    if (priority) p.set("priority", priority);
    const qs = p.toString();
    router.push(qs ? `/punch?${qs}` : "/punch");
  }
  return (
    <div className="grid grid-cols-3 gap-2">
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">Job</span>
        <select value={currentJob} onChange={e => go(e.target.value, currentStatus, currentPriority)} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="">All jobs</option>
          {jobs.map(j => <option key={j.id} value={j.id}>{j.name}</option>)}
        </select>
      </label>
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">Status</span>
        <select value={currentStatus} onChange={e => go(currentJob, e.target.value, currentPriority)} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="">All</option>
          <option value="open">Open</option>
          <option value="in_progress">In Progress</option>
          <option value="complete">Complete</option>
          <option value="void">Void</option>
        </select>
      </label>
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">Priority</span>
        <select value={currentPriority} onChange={e => go(currentJob, currentStatus, e.target.value)} className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white">
          <option value="">All</option>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
        </select>
      </label>
    </div>
  );
}