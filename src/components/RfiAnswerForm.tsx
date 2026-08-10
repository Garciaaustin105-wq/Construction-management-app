"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/Toast";

export default function RfiAnswerForm({ rfiId }: { rfiId: string }) {
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const router = useRouter();
  const supabase = createClient();
  const toast = useToast();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!answer.trim()) return;
    setSaving(true);
    const { error } = await supabase
      .from("rfis")
      .update({
        answer,
        status: "answered",
        answered_at: new Date().toISOString(),
      })
      .eq("id", rfiId);
    if (error) {
      toast.error(`Failed: ${error.message}`);
    } else {
      toast.success("Answer sent");
      setAnswer("");
      router.refresh();
    }
    setSaving(false);
  }

  return (
    <form onSubmit={handleSubmit} className="mt-2 space-y-2">
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        placeholder="Type your answer..."
        rows={3}
        className="block w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
      />
      <button
        type="submit"
        disabled={saving || !answer.trim()}
        className="w-full bg-green-600 text-white py-2 rounded-lg text-sm font-semibold active:bg-green-700 disabled:opacity-50"
      >
        {saving ? "Sending..." : "Send Answer"}
      </button>
    </form>
  );
}