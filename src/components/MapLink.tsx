import { MapPin } from "lucide-react";

export default function MapLink({ address }: { address: string }) {
  const encoded = encodeURIComponent(address);
  const isIOS = typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent);

  const href = isIOS
    ? `http://maps.apple.com/?q=${encoded}`
    : `https://www.google.com/maps/search/?api=1&query=${encoded}`;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-blue-600 underline text-sm"
    >
      <MapPin className="w-4 h-4" />
      {address}
    </a>
  );
}