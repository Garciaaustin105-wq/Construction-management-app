"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import { validateUpload } from "@/lib/uploadValidate";
import {
  Loader2,
  Save,
  Trash2,
  Upload,
  Eye,
  Plus,
  X,
  Phone,
  Mail,
  Briefcase,
} from "lucide-react";

export type SubDetail = {
  id: string;
  company: string;
  contact_name: string | null;
  trade: string | null;
  phone: string | null;
  email: string | null;
  notes: string | null;
};

export type SubAttachment = {
  id: string;
  filename: string;
  storage_path: string;
  created_at: string;
};

export type AttachedJob = {
  job_id: string;
  job_name: string;
  role_on_job: string | null;
};

type Tab = "info" | "files" | "jobs";

export default function SubcontractorDetail({
  sub,
  attachments,
  attachedJobs,
  allJobs,
  canEdit = true,
}: {
  sub: SubDetail;
  attachments: SubAttachment[];
  attachedJobs: AttachedJob[];
  allJobs: { id: string; name: string }[];
  canEdit?: boolean;
}) {
  const supabase = createClient();
  const toast = useToast();
  const router = useRouter();

  const [tab, setTab] = useState<Tab>("info");

  // Info form state
  const [company, setCompany] = useState(sub.company);
  const [contactName, setContactName] = useState(sub.contact_name ?? "");
  const [trade, setTrade] = useState(sub.trade ?? "");
  const [phone, setPhone] = useState(sub.phone ?? "");
  const [email, setEmail] = useState(sub.email ?? "");
  const [notes, setNotes] = useState(sub.notes ?? "");
  const [savingInfo, setSavingInfo] = useState(false);

  // Files state
  const [files, setFiles] = useState<SubAttachment[]>(attachments);
  const [uploading, setUploading] = useState(false);
  const [fileBusy, setFileBusy] = useState<string | null>(null);

  // Jobs state
  const [jobs, setJobs] = useState<AttachedJob[]>(attachedJobs);
  const [pickJob, setPickJob] = useState("");
  const [pickRole, setPickRole] = useState("");
  const [attaching, setAttaching] = useState(false);
  const [jobBusy, setJobBusy] = useState<string | null>(null);

  async function saveInfo(e: React.FormEvent) {
    e.preventDefault();
    if (!company.trim()) {
      toast.warning("Company name is required");
      return;
    }
    setSavingInfo(true);
    const { error } = await supabase
      .from("subcontractors")
      .update({
        company: company.trim(),
        contact_name: contactName.trim() || null,
        trade: trade.trim() || null,
        phone: phone.trim() || null,
        email: email.trim() || null,
        notes: notes.trim() || null,
      })
      .eq("id", sub.id);
    setSavingInfo(false);
    if (error) toast.error(`Failed: ${error.message}`);
    else toast.success("Saved");
  }

  async function uploadFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const v = validateUpload(file, "blueprint");
    if (!v.ok) {
      toast.error(v.error);
      e.target.value = "";
      return;
    }
    setUploading(true);
    const safe = file.name.replace(/[^a-z0-9.\-]+/gi, "_");
    const path = `${sub.id}/${crypto.randomUUID()}-${safe}`;
    const { error: upErr } = await supabase.storage
      .from("subcontractor-files")
      .upload(path, file);
    if (upErr) {
      toast.error(`Upload failed: ${upErr.message}`);
      setUploading(false);
      e.target.value = "";
      return;
    }
    const {
      data: { user },
    } = await supabase.auth.getUser();
    const { data: row, error: dbErr } = await supabase
      .from("subcontractor_attachments")
      .insert({
        subcontractor_id: sub.id,
        filename: file.name,
        storage_path: path,
        uploaded_by: user?.id ?? null,
      })
      .select("id, filename, storage_path, created_at")
      .single();
    setUploading(false);
    e.target.value = "";
    if (dbErr || !row) {
      toast.error(`Save failed: ${dbErr?.message ?? "error"}`);
      return;
    }
    setFiles((prev) => [row as SubAttachment, ...prev]);
    toast.success("File added");
  }

  async function viewFile(path: string) {
    const { data } = await supabase.storage
      .from("subcontractor-files")
      .createSignedUrl(path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
    else toast.error("Could not open file");
  }

  async function deleteFile(att: SubAttachment) {
    if (!confirm(`Delete ${att.filename}?`)) return;
    setFileBusy(att.id);
    await supabase.storage.from("subcontractor-files").remove([att.storage_path]);
    await supabase.from("subcontractor_attachments").delete().eq("id", att.id);
    setFiles((prev) => prev.filter((f) => f.id !== att.id));
    setFileBusy(null);
    toast.success("File deleted");
  }

  async function attachJob(e: React.FormEvent) {
    e.preventDefault();
    if (!pickJob) {
      toast.warning("Pick a job");
      return;
    }
    setAttaching(true);
    const { error } = await supabase.from("job_subcontractors").insert({
      job_id: pickJob,
      subcontractor_id: sub.id,
      role_on_job: pickRole.trim() || null,
    });
    setAttaching(false);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    const jobName = allJobs.find((j) => j.id === pickJob)?.name ?? "—";
    setJobs((prev) => [
      ...prev,
      { job_id: pickJob, job_name: jobName, role_on_job: pickRole.trim() || null },
    ]);
    setPickJob("");
    setPickRole("");
    toast.success("Attached to job");
    router.refresh();
  }

  async function detachJob(jobId: string) {
    if (!confirm("Remove this sub from the job?")) return;
    setJobBusy(jobId);
    const { error } = await supabase
      .from("job_subcontractors")
      .delete()
      .eq("job_id", jobId)
      .eq("subcontractor_id", sub.id);
    setJobBusy(null);
    if (error) {
      toast.error(`Failed: ${error.message}`);
      return;
    }
    setJobs((prev) => prev.filter((j) => j.job_id !== jobId));
    toast.success("Removed from job");
    router.refresh();
  }

  const TABS: { key: Tab; label: string }[] = [
    { key: "info", label: "Info" },
    { key: "files", label: `Files (${files.length})` },
    { key: "jobs", label: `Jobs (${jobs.length})` },
  ];

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="bg-white rounded-lg p-4 shadow-sm">
        <p className="font-bold text-gray-900 flex items-center gap-1">
          <Briefcase className="w-4 h-4 text-gray-400" />
          {sub.company}
        </p>
        {sub.trade && <p className="text-sm text-blue-600">{sub.trade}</p>}
        <div className="flex flex-col gap-0.5 mt-1">
          {sub.phone && (
            <a href={`tel:${sub.phone}`} className="text-xs text-gray-600 inline-flex items-center gap-1">
              <Phone className="w-3 h-3" /> {sub.phone}
            </a>
          )}
          {sub.email && (
            <a href={`mailto:${sub.email}`} className="text-xs text-gray-600 inline-flex items-center gap-1">
              <Mail className="w-3 h-3" /> {sub.email}
            </a>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex-1 py-2 text-sm font-medium ${
              tab === t.key
                ? "text-blue-600 border-b-2 border-blue-600"
                : "text-gray-500"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Info tab */}
      {tab === "info" && (
        canEdit ? (
        <form onSubmit={saveInfo} className="bg-white rounded-lg p-4 shadow-sm space-y-3">
          <input
            type="text"
            placeholder="Company name *"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              type="text"
              placeholder="Contact name"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              type="text"
              placeholder="Trade"
              value={trade}
              onChange={(e) => setTrade(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="tel"
              placeholder="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
          </div>
          <textarea
            placeholder="Notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
          />
          <button
            type="submit"
            disabled={savingInfo}
            className="w-full bg-blue-600 text-white py-3 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {savingInfo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save changes
          </button>
        </form>
        ) : (
        <div className="bg-white rounded-lg p-4 shadow-sm space-y-2 text-sm text-gray-700">
          {sub.contact_name && <p><span className="text-gray-400">Contact:</span> {sub.contact_name}</p>}
          {sub.trade && <p><span className="text-gray-400">Trade:</span> {sub.trade}</p>}
          {sub.phone && <p><span className="text-gray-400">Phone:</span> {sub.phone}</p>}
          {sub.email && <p><span className="text-gray-400">Email:</span> {sub.email}</p>}
          {sub.notes && <p className="whitespace-pre-wrap"><span className="text-gray-400">Notes:</span> {sub.notes}</p>}
          {!sub.contact_name && !sub.trade && !sub.phone && !sub.email && !sub.notes && (
            <p className="text-gray-400">No additional info.</p>
          )}
        </div>
        )
      )}

      {/* Files tab */}
      {tab === "files" && (
        <div className="space-y-3">
          {canEdit && (
          <label className="block bg-white rounded-lg p-4 shadow-sm">
            <span className="text-sm font-medium text-gray-700 flex items-center gap-1">
              <Upload className="w-4 h-4" /> Upload file (PDF or image)
            </span>
            <input
              type="file"
              accept="image/*,.pdf"
              onChange={uploadFile}
              disabled={uploading}
              className="mt-2 block w-full text-sm text-gray-900 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-blue-50 file:text-blue-700 file:font-semibold"
            />
            {uploading && (
              <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Uploading…
              </p>
            )}
          </label>
          )}

          {files.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">
              No files yet. Upload insurance, license, or contract docs.
            </p>
          ) : (
            <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
              {files.map((f) => (
                <div key={f.id} className="p-3 flex items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-gray-900 truncate">{f.filename}</p>
                    <p className="text-xs text-gray-400">
                      {new Date(f.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <button
                    onClick={() => viewFile(f.storage_path)}
                    className="text-blue-600 p-2 rounded hover:bg-blue-50"
                    title="View"
                  >
                    {fileBusy === f.id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                  {canEdit && (
                  <button
                    onClick={() => deleteFile(f)}
                    className="text-red-600 p-2 rounded hover:bg-red-50"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Jobs tab */}
      {tab === "jobs" && (
        <div className="space-y-3">
          {canEdit && (
          <form
            onSubmit={attachJob}
            className="bg-white rounded-lg p-4 shadow-sm space-y-2"
          >
            <span className="text-sm font-medium text-gray-700 flex items-center gap-1">
              <Plus className="w-4 h-4" /> Attach to a job
            </span>
            <select
              value={pickJob}
              onChange={(e) => setPickJob(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white"
            >
              <option value="">Select job…</option>
              {allJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Role on this job (optional)"
              value={pickRole}
              onChange={(e) => setPickRole(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
            />
            <button
              type="submit"
              disabled={attaching}
              className="w-full bg-blue-600 text-white py-2 rounded-lg font-semibold text-sm active:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {attaching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              Attach
            </button>
          </form>
          )}

          {jobs.length === 0 ? (
            <p className="text-sm text-gray-500 text-center py-6">
              Not attached to any jobs yet.
            </p>
          ) : (
            <div className="bg-white rounded-lg shadow-sm divide-y divide-gray-100">
              {jobs.map((j) => (
                <div key={j.job_id} className="p-3 flex items-center gap-2">
                  <Link
                    href={`/jobs/${j.job_id}`}
                    className="min-w-0 flex-1"
                  >
                    <p className="text-sm font-medium text-gray-900 truncate">{j.job_name}</p>
                    {j.role_on_job && (
                      <p className="text-xs text-gray-500 truncate">{j.role_on_job}</p>
                    )}
                  </Link>
                  {canEdit && (
                  <button
                    onClick={() => detachJob(j.job_id)}
                    disabled={jobBusy === j.job_id}
                    className="text-red-600 p-2 rounded hover:bg-red-50 disabled:opacity-50"
                    title="Remove from job"
                  >
                    {jobBusy === j.job_id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <X className="w-4 h-4" />
                    )}
                  </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}