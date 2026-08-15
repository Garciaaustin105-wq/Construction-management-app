// White-label logo renderer for app chrome. Shows the org's uploaded logo
// when one is set, otherwise falls back to the platform icon. Imported by the
// client Sidebar/TopBar; pure presentational (no hooks, no "use client" needed).

type OrgLogoProps = {
  logoUrl: string | null;
  alt: string;
  size?: number;
  className?: string;
};

export default function OrgLogo({
  logoUrl,
  alt,
  size = 28,
  className,
}: OrgLogoProps) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={alt}
        width={size}
        height={size}
        className={`shrink-0 rounded-md object-contain ${className ?? ""}`}
      />
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/terra-vista-icon.svg"
      alt={alt}
      width={size}
      height={size}
      className={`shrink-0 rounded-md ${className ?? ""}`}
    />
  );
}