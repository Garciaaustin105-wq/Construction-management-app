import { AlertTriangle, XCircle } from 'lucide-react';
import { checkApplicatorEligibility } from '@/lib/lawnApplicator';

export default function ApplicatorLicenseBadge({
  licenseNumber,
  licenseExpires,
}: {
  licenseNumber: string | null;
  licenseExpires: string | null;
}) {
  const { severity, reason } = checkApplicatorEligibility({
    licenseNumber,
    licenseExpires,
  });

  if (severity === 'ok') return null;

  const isWarn = severity === 'warn';
  const bg = isWarn ? 'bg-amber-50' : 'bg-red-50';
  const text = isWarn ? 'text-amber-700' : 'text-red-700';
  const border = isWarn ? 'border-amber-200' : 'border-red-200';
  const Icon = isWarn ? AlertTriangle : XCircle;

  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-xs font-medium inline-flex items-center gap-1 ${bg} ${text} ${border}`}
    >
      <Icon size={16} />
      {reason}
    </span>
  );
}