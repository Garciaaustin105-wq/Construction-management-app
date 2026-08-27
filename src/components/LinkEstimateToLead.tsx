'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { useToast } from '@/components/Toast';
import { linkEstimateToLead, type Lead } from '@/lib/leads';
import { Loader2, FileText, ChevronDown, X } from 'lucide-react';

export default function LinkEstimateToLead({
  lead,
  onLinked,
}: {
  lead: Lead;
  onLinked: (estimateId: string) => void;
}) {
  const supabase = createClient();
  const toast = useToast();

  const [linkedId, setLinkedId] = useState<string | null>(lead.estimate_id);
  const [showPicker, setShowPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [estimates, setEstimates] = useState<
    Array<{ id: string; estimate_number: string | null; title: string | null; status: string }> | null
  >(null);
  const [pickedId, setPickedId] = useState('');

  const field =
    'w-full px-3 py-2 border border-gray-300 rounded-lg text-sm bg-white';

  useEffect(() => {
    if (!showPicker) return;

    const fetchEstimates = async () => {
      try {
        let data: any[] = [];

        if (lead.converted_customer_id) {
          const { data: custData, error: custErr } = await supabase
            .from('estimates')
            .select('id, estimate_number, title, status')
            .eq('customer_id', lead.converted_customer_id)
            .order('created_at', { ascending: false })
            .limit(50);

          if (!custErr && custData && custData.length > 0) {
            data = custData;
          }
        }

        if (data.length === 0) {
          const { data: allData, error: allErr } = await supabase
            .from('estimates')
            .select('id, estimate_number, title, status')
            .order('created_at', { ascending: false })
            .limit(50);

          if (!allErr && allData) {
            data = allData;
          }
        }

        setEstimates(data);
      } catch (e) {
        console.error('Failed to fetch estimates', e);
        setEstimates([]);
      }
    };

    fetchEstimates();
  }, [showPicker, lead.converted_customer_id, supabase]);

  const handleLink = async () => {
    if (!pickedId) return;
    setSaving(true);
    const { error } = await linkEstimateToLead(supabase, {
      leadId: lead.id,
      estimateId: pickedId,
    });
    setSaving(false);
    if (error) {
      toast.error(error);
    } else {
      toast.success('Estimate linked');
      setLinkedId(pickedId);
      setShowPicker(false);
      setPickedId('');
      onLinked(pickedId);
    }
  };

  const estimateLabel = () => {
    const est = estimates?.find((e) => e.id === linkedId);
    if (!est) return `Estimate ${linkedId?.slice(0, 8)}`;
    return est.title || est.estimate_number || 'Untitled';
  };

  return (
    <section className="bg-white rounded-lg p-3 shadow-sm space-y-2">
      {linkedId ? (
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="h-4 w-4 text-gray-600" />
              <Link
                href={`/estimates/${linkedId}`}
                className="text-blue-600 hover:underline"
              >
                {estimateLabel()}
              </Link>
            </div>
            <button
              onClick={() => setShowPicker(true)}
              className="text-sm text-blue-600 flex items-center gap-1"
            >
              <ChevronDown className="h-4 w-4" />
              Change
            </button>
          </div>
          <p className="text-xs text-gray-500">
            Approving/rejecting this estimate moves the lead to won/lost
            automatically.
          </p>
        </div>
      ) : (
        <button
          onClick={() => setShowPicker(true)}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold active:bg-blue-700"
        >
          <FileText className="h-5 w-5" />
          Link estimate
        </button>
      )}

      {showPicker && (
        <div className="space-y-2">
          <select
            className={field}
            value={pickedId}
            onChange={(e) => setPickedId(e.target.value)}
          >
            <option value="">Select an estimate</option>
            {estimates?.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title || e.estimate_number || 'Untitled'} ({e.status})
              </option>
            ))}
          </select>
          <div className="flex gap-2">
            <button
              onClick={handleLink}
              disabled={saving || !pickedId}
              className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                'Link'
              )}
            </button>
            <button
              onClick={() => {
                setShowPicker(false);
                setPickedId('');
              }}
              className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm"
            >
              <X className="h-4 w-4" />
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
