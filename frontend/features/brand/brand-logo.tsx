import Image from "next/image";

/** One identity asset for login, workspace navigation, and compact navigation. */
export function BrandLogo({ responsive = false }: { responsive?: boolean }) {
  return <span className={`brand-logo ${responsive ? "brand-logo-responsive" : ""}`} role="img" aria-label="ConText">
    <span className="brand-logo-full sidebar-label"><Image src="/brand/context-logo.png" alt="" width={1200} height={420} unoptimized loading="eager" /></span>
    {responsive && <span className="brand-logo-symbol"><Image src="/brand/context-symbol.png" alt="" width={512} height={512} unoptimized loading="eager" /></span>}
  </span>;
}
