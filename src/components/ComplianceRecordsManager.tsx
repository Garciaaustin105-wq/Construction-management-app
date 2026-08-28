/**
 * ComplianceRecordsManager
 *
 * A lawn-variant ops page for chemical-compliance records: RUP purchases,
 * disposal records, CEU records, non-certified training, and the 30-day
 * “mark shared” tool for unshared RUP applications.
 *
 * Uses the Supabase client in the browser, router.refresh() after each
 * mutation, and the shared ToastProvider for feedback.
 */

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";
import NumberInput from "@/components/NumberInput";
import { Loader2, Plus, Trash2, CheckCircle2 } from "lucide-react";

export type ComplianceProduct = { id: string; name: string; is_restricted_use: boolean };
export type ComplianceCrew = { id: string; name: string };
export type RupPurchaseRow = {
  id: string;
  product_id: string;
  dealer_name: string | null;
  purchase_date: string;
  quantity: number;
  unit: string | null;
  certificate_number: string | null;
  verified_at: string | null;
};
export type DisposalRow = {
  id: string;
  product_id: string;
  quantity: number;
  unit: string | null;
  method: string | null;
  disposal_date: string;
  disposal_location: string | null;
  disposed_by: string | null;
};
export type CeuRow = {
  id: string;
  crew_id: string;
  course_name: string;
  hours: number;
  completed_date: string;
  category: string | null;
};
export type TrainingRow = {
  id: string;
  crew_id: string;
  supervising_applicator_id: string | null;
  training_completed_date: string;
  training_provider: string | null;
};
export type UnsharedRupRow = {
  id: string;
  product_name: string | null;
  quantity_used: number | null;
  created_at: string;
};

export type ProductOption = { value: string; label: string };
export type CrewOption = { value: string; label: string };

export type ComplianceRecordsManagerProps = {
  orgId: string;
  products: ComplianceProduct[];
  crews: ComplianceCrew[];
  rupPurchases: RupPurchaseRow[];
  disposals: DisposalRow[];
  ceuRecords: CeuRow[];
  trainingRecords: TrainingRow[];
  unsharedRup: UnsharedRupRow[];
};

export default function ComplianceRecordsManager(
  props: ComplianceRecordsManagerProps
) {
  const { orgId, products, crews, rupPurchases, disposals, ceuRecords, trainingRecords, unsharedRup } = props;
  const toast = useToast();
  const router = useRouter();

  // Busy state keyed by action id
  const [busyId, setBusyId] = useState<string | null>(null);

  // Helper: load supabase client
  const loadSupabase = async () => {
    const supabaseMod = await import("@/lib/supabase/client");
    return supabaseMod.createClient();
  };

  // Helper: error message extraction (no `any` leaks)
  const errMsg = (e: unknown): string =>
    e instanceof Error ? e.message : "Something went wrong";

  // Section 1: RUP records to share
  const handleMarkShared = async (id: string) => {
    setBusyId(`markShared-${id}`);
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("chemical_applications")
        .update({ shared_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
      toast.success("Marked shared");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  // Section 2: RUP purchases
  const [purchaseProductId, setPurchaseProductId] = useState<string>("");
  const [purchaseDealerName, setPurchaseDealerName] = useState<string>("");
  const [purchaseDate, setPurchaseDate] = useState<string>("");
  const [purchaseQuantity, setPurchaseQuantity] = useState<number>(0);
  const [purchaseUnit, setPurchaseUnit] = useState<string>("");
  const [purchaseCertificateNumber, setPurchaseCertificateNumber] = useState<string>("");

  const handleAddPurchase = async () => {
    if (!purchaseProductId || !purchaseDate || purchaseQuantity <= 0) {
      toast.error("Product, date, and quantity are required");
      return;
    }
    setBusyId("addPurchase");
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("rup_purchases")
        .insert({
          organization_id: orgId,
          product_id: purchaseProductId,
          dealer_name: purchaseDealerName || null,
          purchase_date: purchaseDate,
          quantity: purchaseQuantity,
          unit: purchaseUnit || null,
          certificate_number: purchaseCertificateNumber || null,
        });
      if (error) throw error;
      toast.success("Purchase added");
      setPurchaseProductId("");
      setPurchaseDealerName("");
      setPurchaseDate("");
      setPurchaseQuantity(0);
      setPurchaseUnit("");
      setPurchaseCertificateNumber("");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleVerifyPurchase = async (id: string) => {
    setBusyId(`verify-${id}`);
    try {
      const supabase = await loadSupabase();
      const { data: { user } } = await supabase.auth.getUser();
      const { error } = await supabase
        .from("rup_purchases")
        .update({
          supervisor_verified_by: user?.id ?? null,
          verified_at: new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
      toast.success("Purchase verified");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeletePurchase = async (id: string) => {
    if (!confirm("Delete this purchase?")) return;
    setBusyId(`delPurchase-${id}`);
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("rup_purchases")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("Purchase deleted");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  // Section 3: Disposal records
  const [disposalProductId, setDisposalProductId] = useState<string>("");
  const [disposalQuantity, setDisposalQuantity] = useState<number>(0);
  const [disposalUnit, setDisposalUnit] = useState<string>("");
  const [disposalMethod, setDisposalMethod] = useState<string>("");
  const [disposalDate, setDisposalDate] = useState<string>("");
  const [disposalLocation, setDisposalLocation] = useState<string>("");
  const [disposalCrewId, setDisposalCrewId] = useState<string>("");

  const handleAddDisposal = async () => {
    if (!disposalProductId || !disposalDate || disposalQuantity <= 0) {
      toast.error("Product, date, and quantity are required");
      return;
    }
    setBusyId("addDisposal");
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("chemical_disposal_records")
        .insert({
          organization_id: orgId,
          product_id: disposalProductId,
          quantity: disposalQuantity,
          unit: disposalUnit || null,
          method: disposalMethod || null,
          disposal_date: disposalDate,
          disposal_location: disposalLocation || null,
          disposed_by: disposalCrewId || null,
        });
      if (error) throw error;
      toast.success("Disposal added");
      setDisposalProductId("");
      setDisposalQuantity(0);
      setDisposalUnit("");
      setDisposalMethod("");
      setDisposalDate("");
      setDisposalLocation("");
      setDisposalCrewId("");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteDisposal = async (id: string) => {
    if (!confirm("Delete this disposal record?")) return;
    setBusyId(`delDisposal-${id}`);
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("chemical_disposal_records")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("Disposal deleted");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  // Section 4: Applicator CEU records
  const [ceuCrewId, setCeuCrewId] = useState<string>("");
  const [ceuCourseName, setCeuCourseName] = useState<string>("");
  const [ceuHours, setCeuHours] = useState<number>(0);
  const [ceuCompletedDate, setCeuCompletedDate] = useState<string>("");
  const [ceuCategory, setCeuCategory] = useState<string>("");

  const handleAddCeu = async () => {
    if (!ceuCrewId || !ceuCourseName || !ceuCompletedDate || ceuHours <= 0) {
      toast.error("Crew, course, date, and hours are required");
      return;
    }
    setBusyId("addCeu");
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("applicator_ceu_records")
        .insert({
          organization_id: orgId,
          crew_id: ceuCrewId,
          course_name: ceuCourseName,
          hours: ceuHours,
          completed_date: ceuCompletedDate,
          category: ceuCategory || null,
        });
      if (error) throw error;
      toast.success("CEU added");
      setCeuCrewId("");
      setCeuCourseName("");
      setCeuHours(0);
      setCeuCompletedDate("");
      setCeuCategory("");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteCeu = async (id: string) => {
    if (!confirm("Delete this CEU record?")) return;
    setBusyId(`delCeu-${id}`);
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("applicator_ceu_records")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("CEU deleted");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  // Section 5: Noncertified applicator training
  const [trainingCrewId, setTrainingCrewId] = useState<string>("");
  const [trainingSupervisorId, setTrainingSupervisorId] = useState<string>("");
  const [trainingDate, setTrainingDate] = useState<string>("");
  const [trainingProvider, setTrainingProvider] = useState<string>("");

  const handleAddTraining = async () => {
    if (!trainingCrewId || !trainingDate) {
      toast.error("Crew and training date are required");
      return;
    }
    setBusyId("addTraining");
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("noncertified_applicator_training")
        .insert({
          organization_id: orgId,
          crew_id: trainingCrewId,
          supervising_applicator_id: trainingSupervisorId || null,
          training_completed_date: trainingDate,
          training_provider: trainingProvider || null,
        });
      if (error) throw error;
      toast.success("Training added");
      setTrainingCrewId("");
      setTrainingSupervisorId("");
      setTrainingDate("");
      setTrainingProvider("");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteTraining = async (id: string) => {
    if (!confirm("Delete this training record?")) return;
    setBusyId(`delTraining-${id}`);
    try {
      const supabase = await loadSupabase();
      const { error } = await supabase
        .from("noncertified_applicator_training")
        .delete()
        .eq("id", id);
      if (error) throw error;
      toast.success("Training deleted");
      router.refresh();
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setBusyId(null);
    }
  };

  // CEU summary
  const ceuSummary = ceuRecords.reduce<Record<string, number>>((acc, r) => {
    acc[r.crew_id] = (acc[r.crew_id] ?? 0) + r.hours;
    return acc;
  }, {});
  const ceuSummaryArray = Object.entries(ceuSummary)
    .map(([crewId, total]) => ({
      crewId,
      total,
      name: crews.find((c) => c.id === crewId)?.name ?? "—",
    }))
    .sort((a, b) => b.total - a.total);

  return (
    <div className="space-y-6">
      {/* Section 1 – RUP records to share */}
      {unsharedRup.length > 0 && (
        <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
          <h3 className="font-bold mb-2">RUP records to share</h3>
          <p className="text-sm text-gray-600 mb-4">
            Restricted-use applications older than 25 days without a customer record copy (30-day rule).
          </p>
          <ul className="space-y-2 mb-4">
            {unsharedRup.map((row) => (
              <li key={row.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-2 text-sm">
                <div>
                  <p className="font-medium">{row.product_name ?? "—"}</p>
                  <p className="text-gray-500">{row.quantity_used ?? "—"} units on {row.created_at.slice(0, 10)}</p>
                </div>
                <button
                  onClick={() => handleMarkShared(row.id)}
                  disabled={busyId === `markShared-${row.id}`}
                  className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800"
                >
                  {busyId === `markShared-${row.id}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Mark shared
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Section 2 – RUP purchases */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <h3 className="font-bold mb-2">RUP purchases</h3>
        <ul className="space-y-2 mb-4">
          {rupPurchases.map((row) => (
            <li key={row.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-2 text-sm">
              <div>
                <p className="font-medium">{products.find((p) => p.id === row.product_id)?.name ?? "—"}</p>
                <p className="text-gray-500">
                  {row.dealer_name ?? "—"} – {row.purchase_date} – {row.quantity} {row.unit ?? ""} – {row.certificate_number ?? "—"}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {row.verified_at ? (
                  <span className="px-2 py-0.5 rounded text-xs bg-green-200 text-green-800 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" /> Verified
                  </span>
                ) : (
                  <button
                    onClick={() => handleVerifyPurchase(row.id)}
                    disabled={busyId === `verify-${row.id}`}
                    className="flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-800"
                  >
                    {busyId === `verify-${row.id}` ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Plus className="h-4 w-4" />
                    )}
                    Verify
                  </button>
                )}
                <button
                  onClick={() => handleDeletePurchase(row.id)}
                  disabled={busyId === `delPurchase-${row.id}`}
                  className="text-red-600 hover:text-red-800 flex items-center gap-1"
                >
                  {busyId === `delPurchase-${row.id}` ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" />
                  )}
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Product *</label>
            <select
              value={purchaseProductId}
              onChange={(e) => setPurchaseProductId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">Select product *</option>
              {products.filter((p) => p.is_restricted_use).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Dealer name</label>
            <input
              type="text"
              value={purchaseDealerName}
              onChange={(e) => setPurchaseDealerName(e.target.value)}
              placeholder="Dealer name"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Purchase date *</label>
            <input
              type="date"
              value={purchaseDate}
              onChange={(e) => setPurchaseDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Quantity *</label>
            <NumberInput
              value={purchaseQuantity}
              onChange={setPurchaseQuantity}
              placeholder="Quantity"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Unit</label>
            <select
              value={purchaseUnit}
              onChange={(e) => setPurchaseUnit(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">Select unit</option>
              <option value="GAL">GAL</option>
              <option value="QT">QT</option>
              <option value="LB">LB</option>
              <option value="OZ">OZ</option>
              <option value="EA">EA</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Certificate number</label>
            <input
              type="text"
              value={purchaseCertificateNumber}
              onChange={(e) => setPurchaseCertificateNumber(e.target.value)}
              placeholder="Certificate number"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <button
          onClick={handleAddPurchase}
          disabled={busyId === "addPurchase"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {busyId === "addPurchase" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add
        </button>
      </div>

      {/* Section 3 – Disposal records */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <h3 className="font-bold mb-2">Disposal records</h3>
        <ul className="space-y-2 mb-4">
          {disposals.map((row) => (
            <li key={row.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-2 text-sm">
              <div>
                <p className="font-medium">{products.find((p) => p.id === row.product_id)?.name ?? "—"}</p>
                <p className="text-gray-500">
                  {row.quantity} {row.unit ?? ""} – {row.method ?? "—"} – {row.disposal_date} – {row.disposal_location ?? "—"} – {crews.find((c) => c.id === row.disposed_by)?.name ?? "—"}
                </p>
              </div>
              <button
                onClick={() => handleDeleteDisposal(row.id)}
                disabled={busyId === `delDisposal-${row.id}`}
                className="text-red-600 hover:text-red-800 flex items-center gap-1"
              >
                {busyId === `delDisposal-${row.id}` ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Delete
              </button>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Product *</label>
            <select
              value={disposalProductId}
              onChange={(e) => setDisposalProductId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">Select product *</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Quantity *</label>
            <NumberInput
              value={disposalQuantity}
              onChange={setDisposalQuantity}
              placeholder="Quantity"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Unit</label>
            <select
              value={disposalUnit}
              onChange={(e) => setDisposalUnit(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">Select unit</option>
              <option value="GAL">GAL</option>
              <option value="QT">QT</option>
              <option value="LB">LB</option>
              <option value="OZ">OZ</option>
              <option value="EA">EA</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Method</label>
            <input
              type="text"
              value={disposalMethod}
              onChange={(e) => setDisposalMethod(e.target.value)}
              placeholder="Method"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Disposal date *</label>
            <input
              type="date"
              value={disposalDate}
              onChange={(e) => setDisposalDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Location</label>
            <input
              type="text"
              value={disposalLocation}
              onChange={(e) => setDisposalLocation(e.target.value)}
              placeholder="Location"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Disposed by</label>
            <select
              value={disposalCrewId}
              onChange={(e) => setDisposalCrewId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">Select crew</option>
              {crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <button
          onClick={handleAddDisposal}
          disabled={busyId === "addDisposal"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {busyId === "addDisposal" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add
        </button>
      </div>

      {/* Section 4 – Applicator CEU records */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <h3 className="font-bold mb-2">Applicator CEU records</h3>
        {ceuSummaryArray.length > 0 && (
          <div className="mb-4 text-sm text-gray-600">
            {ceuSummaryArray.map((s) => (
              <p key={s.crewId}>
                {s.name}: {s.total} hrs
              </p>
            ))}
          </div>
        )}
        <ul className="space-y-2 mb-4">
          {ceuRecords.map((row) => (
            <li key={row.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-2 text-sm">
              <div>
                <p className="font-medium">{crews.find((c) => c.id === row.crew_id)?.name ?? "—"}</p>
                <p className="text-gray-500">
                  {row.course_name} – {row.hours} hrs – {row.completed_date} – {row.category ?? "—"}
                </p>
              </div>
              <button
                onClick={() => handleDeleteCeu(row.id)}
                disabled={busyId === `delCeu-${row.id}`}
                className="text-red-600 hover:text-red-800 flex items-center gap-1"
              >
                {busyId === `delCeu-${row.id}` ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Delete
              </button>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Crew *</label>
            <select
              value={ceuCrewId}
              onChange={(e) => setCeuCrewId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">Select crew *</option>
              {crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Course name *</label>
            <input
              type="text"
              value={ceuCourseName}
              onChange={(e) => setCeuCourseName(e.target.value)}
              placeholder="Course name"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Hours *</label>
            <NumberInput
              value={ceuHours}
              onChange={setCeuHours}
              placeholder="Hours"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Completed date *</label>
            <input
              type="date"
              value={ceuCompletedDate}
              onChange={(e) => setCeuCompletedDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Category</label>
            <input
              type="text"
              value={ceuCategory}
              onChange={(e) => setCeuCategory(e.target.value)}
              placeholder="Category"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <button
          onClick={handleAddCeu}
          disabled={busyId === "addCeu"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {busyId === "addCeu" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add
        </button>
      </div>

      {/* Section 5 – Noncertified applicator training */}
      <div className="bg-white rounded-lg border border-gray-200 shadow-sm p-4">
        <h3 className="font-bold mb-2">Noncertified applicator training</h3>
        <ul className="space-y-2 mb-4">
          {trainingRecords.map((row) => (
            <li key={row.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-2 text-sm">
              <div>
                <p className="font-medium">{crews.find((c) => c.id === row.crew_id)?.name ?? "—"}</p>
                <p className="text-gray-500">
                  {crews.find((c) => c.id === row.supervising_applicator_id)?.name ?? "—"} – {row.training_completed_date} – {row.training_provider ?? "—"}
                </p>
              </div>
              <button
                onClick={() => handleDeleteTraining(row.id)}
                disabled={busyId === `delTraining-${row.id}`}
                className="text-red-600 hover:text-red-800 flex items-center gap-1"
              >
                {busyId === `delTraining-${row.id}` ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                Delete
              </button>
            </li>
          ))}
        </ul>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Crew *</label>
            <select
              value={trainingCrewId}
              onChange={(e) => setTrainingCrewId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">Select crew *</option>
              {crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Supervising applicator</label>
            <select
              value={trainingSupervisorId}
              onChange={(e) => setTrainingSupervisorId(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            >
              <option value="">Select supervising applicator</option>
              {crews.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <div>
            <label className="block text-sm font-medium mb-1">Training date *</label>
            <input
              type="date"
              value={trainingDate}
              onChange={(e) => setTrainingDate(e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium mb-1">Provider</label>
            <input
              type="text"
              value={trainingProvider}
              onChange={(e) => setTrainingProvider(e.target.value)}
              placeholder="Provider"
              className="w-full border border-gray-300 rounded-lg px-2 py-1 text-sm"
            />
          </div>
        </div>
        <button
          onClick={handleAddTraining}
          disabled={busyId === "addTraining"}
          className="flex items-center gap-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg px-3 py-1.5 active:bg-slate-800"
        >
          {busyId === "addTraining" ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
          Add
        </button>
      </div>
    </div>
  );
}
