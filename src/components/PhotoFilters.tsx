"use client";

import { useRouter } from "next/navigation";

// Filter controls for the /photos browse page. Two selects (job + uploader)
// that push the selection into the URL so the server component re-renders with
// the filtered set. "All" = empty value.
export default function PhotoFilters({
  jobs,
  uploaders,
  currentJob,
  currentUploader,
}: {
  jobs: { id: string; name: string }[];
  uploaders: { id: string; name: string }[];
  currentJob: string;
  currentUploader: string;
}) {
  const router = useRouter();

  function go(job: string, uploader: string) {
    const params = new URLSearchParams();
    if (job) params.set("job", job);
    if (uploader) params.set("uploader", uploader);
    const qs = params.toString();
    router.push(qs ? `/photos?${qs}` : "/photos");
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <label className="block">
        <span className="text-[10px] uppercase font-semibold text-gray-500">Job</span>
        <select
          value={currentJob}
          onChange={(e) => go(e.target.value, currentUploader)}
          className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white"
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
        <span className="text-[10px] uppercase font-semibold text-gray-500">Uploader</span>
        <select
          value={currentUploader}
          onChange={(e) => go(currentJob, e.target.value)}
          className="mt-0.5 block w-full px-2 py-2 border border-gray-300 rounded-lg text-sm bg-white"
        >
          <option value="">Everyone</option>
          {uploaders.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}