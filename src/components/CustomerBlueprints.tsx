"use client";

import { useState } from "react";
import { FileText } from "lucide-react";
import BlueprintPreview from "./BlueprintPreview";

type Blueprint = {
  id: string;
  storage_path: string;
  filename: string;
  caption: string | null;
  created_at: string;
};

export default function CustomerBlueprints({
  blueprints,
  baseUrl,
}: {
  blueprints: Blueprint[];
  baseUrl: string;
}) {
  const [preview, setPreview] = useState<Blueprint | null>(null);

  if (blueprints.length === 0) return null;

  return (
    <>
      <div className="border-t border-gray-100 p-3">
        <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
          Blueprints ({blueprints.length})
        </p>
        <div className="space-y-1">
          {blueprints.map((b) => (
            <button
              key={b.id}
              onClick={() => setPreview(b)}
              className="block text-sm text-blue-600 underline truncate flex items-center gap-1 text-left w-full"
            >
              <FileText className="w-4 h-4 flex-shrink-0" />
              <span className="truncate">{b.filename}</span>
            </button>
          ))}
        </div>
      </div>
      {preview && (
        <BlueprintPreview
          url={baseUrl + preview.storage_path}
          filename={preview.filename}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}