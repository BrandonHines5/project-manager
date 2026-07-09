import { HINES_HOMES, type Brand } from "@/lib/brand"
import { cn } from "@/lib/utils"

// The square brand mark shown in the top bar, mobile menu, login, and project
// headers. Both house brands ship a real full-color logo that reads on a light
// background, so every tile is a white chip with the brand's mark inside it.
// Hines fills the chip with its favicon artwork (the navy fence on white); MJV
// Building Group's logo carries its own whitespace, so it's contained and
// centered rather than cropped to the tile edges.
//
// `className` sizes/rounds the tile (e.g. "h-8 w-8 rounded-md"); `imgClassName`
// sizes the contained mark inside it (e.g. "h-6 w-6") — used for every brand
// except Hines, whose favicon artwork fills the tile.
export function BrandTile({
  brand = HINES_HOMES,
  className,
  imgClassName,
}: {
  brand?: Brand
  className?: string
  imgClassName?: string
}) {
  const isHines = brand.key === "hines"
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden bg-white ring-1 ring-black/10",
        className
      )}
    >
      {/* Static mark from /public — next/image adds no benefit here. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={isHines ? "/brand/hines-mark-navy.png" : brand.mark}
        alt={brand.name}
        className={
          isHines ? "h-full w-full object-cover" : cn("object-contain", imgClassName)
        }
      />
    </span>
  )
}
