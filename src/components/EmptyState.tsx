import { Camera, FileText, Briefcase, Inbox, type LucideIcon } from "lucide-react";
import { isLawn } from "@/lib/variant";

// Terra Verde empty state (lawn deploy only; construction keeps gray verbatim).
const ES_ICON = isLawn() ? "bg-surface-muted text-muted" : "bg-gray-100 text-gray-400";
const ES_TITLE = isLawn() ? "text-foreground" : "text-gray-900";
const ES_DESC = isLawn() ? "text-muted" : "text-gray-500";

/**
 * Renders an illustrated empty state. Use anywhere a list could be empty.
 */
export default function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center text-center py-10 px-4">
      <div className={`w-14 h-14 rounded-full flex items-center justify-center mb-3 ${ES_ICON}`}>
        <Icon className="w-7 h-7" />
      </div>
      <p className={`text-sm font-semibold ${ES_TITLE}`}>{title}</p>
      {description && (
        <p className={`text-xs mt-1 max-w-xs ${ES_DESC}`}>{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export const EmptyIcons = {
  Camera,
  FileText,
  Briefcase,
  Inbox,
};