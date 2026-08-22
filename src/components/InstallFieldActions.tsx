"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import {
  Play,
  Pause,
  CheckCircle2,
  AlertTriangle,
  StickyNote,
  Package,
  Camera,
} from "lucide-react";
import { OUTCOMES, SEVERITIES } from "@/lib/installs";

// The crew field UI: the tap targets on an install.
//
// EVERY write here goes through a SECURITY DEFINER RPC (install_start /
// install_stop / install_complete / install_report_problem / install_add_note /
// install_log_material). Crew have NO update policy on `installs`, by design —
// see the long note at the top of isp_module_b.sql. Do not "simplify" any of
// these into a direct .from("installs").update(): it will fail for crew, and
// making it succeed would mean opening up price/address/assignment editing.
//
// Photos are the one direct write, because they're a plain insert the existing
// photos RLS already covers ("Crew insert install photos"). The storage path
// MUST be `installs/<id>/<file>` — the bucket policies in isp_module_storage.sql
// resolve the install from segment 2 of that path and reject anything else.
type Panel = "problem" | "note" | "material" | null;

export default function InstallFieldActions({
  installId,
  status,
  hasOpenEntry,
}: {
  installId: string;
  status: string;
  hasOpenEntry: boolean;
}) {
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [showDone, setShowDone] = useState(false);

  // Problem
  const [problemText, setProblemText] = useState("");
  const [severity, setSeverity] = useState("normal");
  // Note
  const [noteText, setNoteText] = useState("");
  // Material
  const [matName, setMatName] = useState("");
  const [matQty, setMatQty] = useState("");
  const [matUnit, setMatUnit] = useState("");
  const [matSerial, setMatSerial] = useState("");
  // Done
  const [outcome, setOutcome] = useState("completed");
  const [doneNote, setDoneNote] = useState("");

  const isDone = status === "completed";

  async function call(
    fn: string,
    args: Record<string, unknown>,
    successMsg: string,
    onOk?: () => void
  ) {
    setBusy(true);
    const { error } = await supabase.rpc(fn, args);
    if (error) {
      toast.error(error.message);
    } else {
      toast.success(successMsg);
      onOk?.();
      router.refresh();
    }
    setBusy(false);
  }

  async function handlePhoto(file: File) {
    setBusy(true);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      toast.error("Not signed in");
      setBusy(false);
      return;
    }
    // Path shape is load-bearing — see the note above.
    const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
    const path = `installs/${installId}/${Date.now()}.${ext}`;

    const { error: upErr } = await supabase.storage
      .from("job-photos")
      .upload(path, file, { contentType: file.type || "image/jpeg" });
    if (upErr) {
      toast.error(`Upload failed: ${upErr.message}`);
      setBusy(false);
      return;
    }
    const { error: rowErr } = await supabase.from("photos").insert({
      install_id: installId,
      storage_path: path,
      uploaded_by: user.id,
    });
    if (rowErr) {
      // The object is stored but unreferenced. Remove it rather than leave an
      // orphan the office can never see or clean up from the UI.
      await supabase.storage.from("job-photos").remove([path]);
      toast.error(`Failed to save photo: ${rowErr.message}`);
    } else {
      toast.success("Photo added");
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <section className="bg-white rounded-lg p-4 shadow-sm space-y-3">
      <h2 className="text-sm font-semibold text-gray-900">On site</h2>

      {/* Start / Stop */}
      {!isDone && (
        <div className="grid grid-cols-2 gap-2">
          <button
            disabled={busy || hasOpenEntry}
            onClick={() =>
              call("install_start", { p_install_id: installId }, "Clocked in")
            }
            className="flex items-center justify-center gap-2 bg-green-600 text-white py-4 rounded-lg font-semibold active:bg-green-700 disabled:opacity-40"
          >
            <Play className="w-5 h-5" /> Start
          </button>
          <button
            disabled={busy || !hasOpenEntry}
            onClick={() =>
              call("install_stop", { p_install_id: installId }, "Clocked out")
            }
            className="flex items-center justify-center gap-2 bg-gray-700 text-white py-4 rounded-lg font-semibold active:bg-gray-800 disabled:opacity-40"
          >
            <Pause className="w-5 h-5" /> Stop
          </button>
        </div>
      )}

      {/* Done */}
      {!isDone && !showDone && (
        <button
          disabled={busy}
          onClick={() => setShowDone(true)}
          className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white py-4 rounded-lg font-semibold active:bg-blue-700 disabled:opacity-40"
        >
          <CheckCircle2 className="w-5 h-5" /> Done
        </button>
      )}

      {showDone && (
        <div className="border border-blue-200 bg-blue-50 rounded-lg p-3 space-y-3">
          <p className="text-sm font-medium text-gray-900">How did it go?</p>
          <div className="space-y-2">
            {OUTCOMES.map((o) => (
              <label
                key={o.value}
                className="flex items-start gap-2 p-2 rounded-lg bg-white border border-gray-200"
              >
                <input
                  type="radio"
                  name="outcome"
                  value={o.value}
                  checked={outcome === o.value}
                  onChange={(e) => setOutcome(e.target.value)}
                  className="w-5 h-5 mt-0.5"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-gray-900">
                    {o.label}
                  </span>
                  <span className="block text-xs text-gray-500">{o.hint}</span>
                </span>
              </label>
            ))}
          </div>
          <textarea
            value={doneNote}
            onChange={(e) => setDoneNote(e.target.value)}
            rows={2}
            placeholder="Anything the office should know (optional)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() =>
                call(
                  "install_complete",
                  {
                    p_install_id: installId,
                    p_outcome: outcome,
                    p_note: doneNote.trim() || null,
                  },
                  "Install marked done",
                  () => {
                    setShowDone(false);
                    setDoneNote("");
                  }
                )
              }
              className="flex-1 bg-blue-600 text-white py-3 rounded-lg font-semibold active:bg-blue-700 disabled:opacity-40"
            >
              Submit
            </button>
            <button
              onClick={() => setShowDone(false)}
              className="px-4 py-3 rounded-lg font-medium text-gray-600"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Secondary actions */}
      <div className="grid grid-cols-2 gap-2">
        <button
          onClick={() => setPanel(panel === "problem" ? null : "problem")}
          className="flex items-center justify-center gap-2 border border-red-200 text-red-700 py-3 rounded-lg font-medium active:bg-red-50"
        >
          <AlertTriangle className="w-4 h-4" /> Problem
        </button>
        <button
          onClick={() => setPanel(panel === "note" ? null : "note")}
          className="flex items-center justify-center gap-2 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium active:bg-gray-50"
        >
          <StickyNote className="w-4 h-4" /> Note
        </button>
        <button
          onClick={() => setPanel(panel === "material" ? null : "material")}
          className="flex items-center justify-center gap-2 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium active:bg-gray-50"
        >
          <Package className="w-4 h-4" /> Material
        </button>
        <label className="flex items-center justify-center gap-2 border border-gray-300 text-gray-700 py-3 rounded-lg font-medium active:bg-gray-50 cursor-pointer">
          <Camera className="w-4 h-4" /> Photo
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Reset the input so picking the same file twice still fires.
              e.target.value = "";
              if (f) handlePhoto(f);
            }}
          />
        </label>
      </div>

      {panel === "problem" && (
        <div className="border border-red-200 rounded-lg p-3 space-y-2">
          <textarea
            value={problemText}
            onChange={(e) => setProblemText(e.target.value)}
            rows={3}
            placeholder="What's wrong? (conduit collapsed, no access, wrong equipment…)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <div className="flex gap-2">
            {SEVERITIES.map((s) => (
              <label key={s.value} className="flex items-center gap-1 text-sm">
                <input
                  type="radio"
                  name="severity"
                  value={s.value}
                  checked={severity === s.value}
                  onChange={(e) => setSeverity(e.target.value)}
                />
                {s.label}
              </label>
            ))}
          </div>
          <p className="text-xs text-gray-500">
            This flags the install for the office. You can still finish the job.
          </p>
          <button
            disabled={busy || !problemText.trim()}
            onClick={() =>
              call(
                "install_report_problem",
                {
                  p_install_id: installId,
                  p_description: problemText,
                  p_severity: severity,
                },
                "Problem reported",
                () => {
                  setProblemText("");
                  setPanel(null);
                }
              )
            }
            className="w-full bg-red-600 text-white py-3 rounded-lg font-semibold active:bg-red-700 disabled:opacity-40"
          >
            Report problem
          </button>
        </div>
      )}

      {panel === "note" && (
        <div className="border border-gray-200 rounded-lg p-3 space-y-2">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            rows={3}
            placeholder="Gate code, where the line runs, what you found…"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <button
            disabled={busy || !noteText.trim()}
            onClick={() =>
              call(
                "install_add_note",
                { p_install_id: installId, p_body: noteText },
                "Note added",
                () => {
                  setNoteText("");
                  setPanel(null);
                }
              )
            }
            className="w-full bg-gray-800 text-white py-3 rounded-lg font-semibold active:bg-gray-900 disabled:opacity-40"
          >
            Add note
          </button>
        </div>
      )}

      {panel === "material" && (
        <div className="border border-gray-200 rounded-lg p-3 space-y-2">
          <input
            value={matName}
            onChange={(e) => setMatName(e.target.value)}
            placeholder="What was used (ONT, drop cable…)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
          />
          <div className="grid grid-cols-2 gap-2">
            <input
              value={matQty}
              onChange={(e) => setMatQty(e.target.value)}
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              placeholder="Qty"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
            <input
              value={matUnit}
              onChange={(e) => setMatUnit(e.target.value)}
              placeholder="Unit (ft, ea)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <input
            value={matSerial}
            onChange={(e) => setMatSerial(e.target.value)}
            placeholder="Serial number (optional)"
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono"
          />
          <button
            disabled={busy || !matName.trim()}
            onClick={() =>
              call(
                "install_log_material",
                {
                  p_install_id: installId,
                  p_name: matName,
                  p_quantity: matQty.trim() === "" ? null : Number(matQty),
                  p_unit: matUnit.trim() || null,
                  p_serial_number: matSerial.trim() || null,
                },
                "Material logged",
                () => {
                  setMatName("");
                  setMatQty("");
                  setMatUnit("");
                  setMatSerial("");
                  setPanel(null);
                }
              )
            }
            className="w-full bg-gray-800 text-white py-3 rounded-lg font-semibold active:bg-gray-900 disabled:opacity-40"
          >
            Log material
          </button>
        </div>
      )}
    </section>
  );
}
