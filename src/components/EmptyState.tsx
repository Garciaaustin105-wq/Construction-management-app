import { Camera, FileText, Briefcase, Inbox, type LucideIcon } from "lucide-react";

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
      <div className="w-14 h-14 rounded-full bg-gray-100 text-gray-400 flex items-center justify-center mb-3">
        <Icon className="w-7 h-7" />
      </div>
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      {description && (
        <p className="text-xs text-gray-500 mt-1 max-w-xs">{description}</p>
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