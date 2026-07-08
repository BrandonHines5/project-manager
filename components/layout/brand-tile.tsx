import { HINES_HOMES, type Brand } from "@/lib/brand"
import { cn } from "@/lib/utils"

// The square brand mark shown in the top bar, mobile menu, login, and project
// headers. Hines Homes renders the actual browser-favicon artwork (the navy
// fence on white) so the in-app logo and the tab icon are the same mark; the
// favicon PNG fills the rounded tile. Other brands (MJV Building Group) keep the
// brand-blue tile with their white mark.
//
// `className` sizes/rounds the tile (e.g. "h-8 w-8 rounded-md"); `imgClassName`
// sizes the mark inside it (e.g. "h-6 w-6") — used only for the non-Hines mark,
// since the Hines favicon artwork fills the tile.
export function BrandTile({
  brand = HINES_HOMES,
  className,
  imgClassName,
}: {
  brand?: Brand
  className?: string
  imgClassName?: string
}) {
  const onLight = brand.key === "hines"
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden",
        onLight ? "bg-white ring-1 ring-black/10" : "bg-brand-500 text-white",
        className
      )}
    >
      {/* Static mark from /public — next/image adds no benefit here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={onLight ? "/brand/hines-mark-navy.png" : brand.mark}
        alt={brand.name}
        className={onLight ? "h-full w-full object-cover" : imgClassName}
      />
    </span>
  )
}
