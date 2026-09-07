"use client";

import { useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useToast } from "@/components/Toast";
import DataTable from "@/components/ui/DataTable";
import { Loader2, TriangleAlert, Upload, Info, MapPinOff } from "lucide-react";
import { parseDelimited } from "@/lib/plantImport";
import {
  IMPORT_SOURCES,
  LENGTH_UNITS,
  guessColumns,
  detectFrame,
  groupPaths,
  buildImport,
  compareAreas,
  describeImport,
  type ImportSource,
  type LengthUnit,
  type CoordFrame,
  type RawPoint,
  type ImportedArea,
} from "@/lib/siteImport";
import { importAreas } from "@/lib/siteImportData";

// Bring a field measurement onto an estimate: Moasure, a GNSS rover, a drone or
// surveyor CSV.
//
// The flow is deliberately ordered upload → CONFIRM WHAT IT IS → preview →
// import. The confirm step exists because two things cannot be inferred safely:
// the unit (a metres file read as feet is 10.76x on area and looks fine) and the
// coordinate frame (a local trace placed on the map looks right and sits wrong).
// Neither gets a default.

const num = (v: string): number => {
  const n = Number(String(v).trim());
  return Number.isFinite(n) ? n : NaN;
};

export default function SiteImportPanel({
  estimateId,
  orgId,
  existingSqft,
}: {
  estimateId: string;
  orgId: string;
  existingSqft: number;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [points, setPoints] = useState<RawPoint[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);

  // NOT defaulted. null means "not chosen", and nothing imports until it is.
  const [unit, setUnit] = useState<LengthUnit | null>(null);
  const [source, setSource] = useState<ImportSource>("moasure");
  const [frame, setFrame] = useState<CoordFrame>("local");
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState<{ written: number; skipped: number } | null>(null);

  const detection = useMemo(
    () => (points.length ? detectFrame(headers, points) : null),
    [headers, points]
  );

  const areas: ImportedArea[] = useMemo(() => {
    if (!points.length) return [];
    return buildImport(groupPaths(points), { unit, source, frame });
  }, [points, unit, source, frame]);

  const importedSqft = useMemo(
    () => areas.filter((a) => a.kind === "area").reduce((s, a) => s + a.areaSqft, 0),
    [areas]
  );
  const comparison = useMemo(
    () => (importedSqft > 0 ? compareAreas(existingSqft, importedSqft) : null),
    [existingSqft, importedSqft]
  );

  const ready = unit !== null && areas.some((a) => a.importable);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setDone(null);
    setParseError(null);
    setFileName(file.name);

    const text = await file.text();
    const parsed = parseDelimited(text);
    const map = guessColumns(parsed.headers);
    if (!map) {
      setHeaders(parsed.headers);
      setPoints([]);
      // Refusing beats picking the first two numeric columns and hoping.
      setParseError(
        "Could not find two coordinate columns. Headers named lat/lng, or x/y, are what this looks for."
      );
      return;
    }

    const rows: RawPoint[] = [];
    for (const r of parsed.rows) {
      const a = num(r[map.a] ?? "");
      const b = num(r[map.b] ?? "");
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const zRaw = map.z === null ? "" : r[map.z] ?? "";
      const z = zRaw === "" ? null : num(zRaw);
      rows.push({
        a,
        b,
        z: z === null || Number.isNaN(z) ? null : z,
        pathName: map.pathName === null ? null : (r[map.pathName] ?? null),
        label: map.label === null ? null : (r[map.label] ?? null),
      });
    }

    setHeaders(parsed.headers);
    setPoints(rows);
    if (rows.length === 0) {
      setParseError("No readable coordinate rows in that file.");
      return;
    }
    // Seed the frame from the detection, but leave it editable — and leave the
    // unit alone, because nothing in the file can tell us.
    const d = detectFrame(parsed.headers, rows);
    setFrame(d.frame);
  }

  async function runImport() {
    if (!ready) return;
    setImporting(true);
    const res = await importAreas(supabase, {
      estimateId,
      organizationId: orgId,
      areas,
      fileName,
    });
    setImporting(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    setDone({ written: res.written, skipped: res.skipped });
    toast.success(`Imported ${res.written} area${res.written === 1 ? "" : "s"}`);
  }

  const field =
    "w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white";

  return (
    <div className="space-y-4">
      <div>
        <label className="inline-flex items-center gap-2 text-sm font-semibold text-white bg-slate-900 rounded-lg px-3 py-2 cursor-pointer active:bg-slate-800">
          <Upload className="h-4 w-4" />
          {fileName || "Choose a CSV"}
          <input type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={onFile} />
        </label>
        <p className="mt-1 text-xs text-gray-500">
          Exported from Moasure, Emlid or a surveyor. CSV for now — the DXF these
          devices also produce is not read yet.
        </p>
      </div>

      {parseError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{parseError}</span>
        </div>
      )}

      {points.length > 0 && (
        <>
          <p className="text-sm text-gray-600">
            {points.length} point{points.length === 1 ? "" : "s"} across{" "}
            {areas.length} path{areas.length === 1 ? "" : "s"}.
          </p>

          {/* THE UNIT. No default, and nothing imports without it, because the
              mistake is invisible: a metres file read as feet is 3.28x on
              length and 10.76x on area and looks entirely ordinary. */}
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="text-xs font-medium text-gray-600">
                Units in the file *
              </span>
              <select
                className={`${field} mt-1 ${unit === null ? "border-amber-400" : ""}`}
                value={unit ?? ""}
                onChange={(e) =>
                  setUnit(e.target.value === "" ? null : (e.target.value as LengthUnit))
                }
              >
                <option value="">Choose…</option>
                {LENGTH_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u === "ft" ? "Feet" : "Metres"}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600">Coordinates</span>
              <select
                className={`${field} mt-1`}
                value={frame}
                onChange={(e) => setFrame(e.target.value as CoordFrame)}
              >
                <option value="geographic">Geographic (lat / lng)</option>
                <option value="local">Local (x / y from a start point)</option>
              </select>
            </label>

            <label className="block">
              <span className="text-xs font-medium text-gray-600">Measured with</span>
              <select
                className={`${field} mt-1`}
                value={source}
                onChange={(e) => setSource(e.target.value as ImportSource)}
              >
                {IMPORT_SOURCES.filter((s) => s !== "map").map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {unit === null && (
            <p className="bg-amber-100 text-amber-700 text-xs p-2 rounded">
              Choose the units before importing. Nothing in a CSV says whether it
              is feet or metres, and reading metres as feet overstates area by
              more than ten times — a number that looks perfectly reasonable on
              a quote.
            </p>
          )}

          {detection && (
            <p className="flex items-start gap-2 text-xs text-gray-600">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
              <span>{detection.reason}</span>
            </p>
          )}

          {frame === "local" && (
            <p className="flex items-start gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
              <MapPinOff className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                A local file has no position on earth — it is measured relative
                to wherever the device started, at whatever rotation. The area,
                perimeter and elevation are still exact and will be imported; the
                shape will not appear on the map. Placing it would mean guessing,
                and a shape that looks right but sits wrong is worse than none.
              </span>
            </p>
          )}

          {comparison && (
            <p className="bg-slate-100 text-slate-700 text-xs p-2 rounded">
              {comparison.message}
            </p>
          )}

          <DataTable
            columns={[
              {
                key: "name",
                header: "Path",
                cell: (a: ImportedArea) => (
                  <span className="font-medium text-gray-900">{a.name}</span>
                ),
              },
              {
                key: "kind",
                header: "Shape",
                cell: (a: ImportedArea) => (
                  <span className="text-gray-600">{a.kind}</span>
                ),
                hideOnMobile: true,
              },
              {
                key: "area",
                header: "Area",
                align: "right",
                num: true,
                cell: (a: ImportedArea) => (
                  <span className="text-gray-600">
                    {a.areaSqft > 0 ? `${a.areaSqft.toLocaleString("en-US")} sqft` : "—"}
                  </span>
                ),
                hideOnMobile: true,
              },
              {
                key: "run",
                header: "Run",
                align: "right",
                num: true,
                cell: (a: ImportedArea) => (
                  <span className="text-gray-600">
                    {a.lengthFt > 0 ? `${a.lengthFt} ft` : "—"}
                  </span>
                ),
                hideOnMobile: true,
              },
              {
                key: "fall",
                header: "Fall",
                align: "right",
                num: true,
                // null elevation is NOT flat — it means the file carried no z.
                cell: (a: ImportedArea) => (
                  <span className="text-gray-600">
                    {a.elevation ? `${a.elevation.fallFt} ft` : "no data"}
                  </span>
                ),
                hideOnMobile: true,
              },
              {
                key: "detail",
                header: "What will be imported",
                cell: (a: ImportedArea) => (
                  <span className={a.importable ? "text-gray-600" : "text-amber-700"}>
                    {describeImport(a)}
                  </span>
                ),
              },
            ]}
            rows={areas}
            framed
            mobileCardBare
            mobileCardClassName={() => "bg-white rounded-lg p-3 shadow-sm"}
            mobileCard={(a: ImportedArea) => (
              <div>
                <p className="text-sm font-semibold text-gray-900">{a.name}</p>
                <p className="text-xs text-gray-500">{a.kind}</p>
                <p className="mt-1 text-[11px] text-gray-400">{describeImport(a)}</p>
              </div>
            )}
          />

          <div className="flex items-center gap-3">
            <button
              onClick={runImport}
              disabled={!ready || importing}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {importing && <Loader2 className="h-4 w-4 animate-spin" />}
              Import {areas.filter((a) => a.importable).length} path
              {areas.filter((a) => a.importable).length === 1 ? "" : "s"}
            </button>
            {done && (
              <span className="text-sm text-green-700">
                {done.written} imported
                {done.skipped > 0 ? `, ${done.skipped} skipped` : ""}.
              </span>
            )}
          </div>

          <p className="text-xs text-gray-500">
            Importing adds new areas. Nothing already on this estimate is changed
            or replaced — where the two disagree, both are kept and you choose.
          </p>
        </>
      )}
    </div>
  );
}
