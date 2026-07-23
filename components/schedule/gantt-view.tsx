"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { toastActionError } from "@/lib/action-error"
import { addDays as fnsAddDays, differenceInCalendarDays, parseISO, format, isWeekend, startOfDay } from "date-fns"
import { CalendarDays, Zap, Minimize2, Printer } from "lucide-react"
import { EmptyState } from "@/components/ui/empty"
import { cn, todayISO, addDays, formatDate, formatDateRange } from "@/lib/utils"
import { isLateScheduleItem } from "@/lib/schedule/late"
import { moveScheduleItem, type MoveReasonT } from "@/app/actions/schedule"
import { computeScheduleAnalysis } from "@/lib/schedule/scheduling"
import { MoveReasonDialog } from "./move-reason-dialog"
import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"

// Two density presets. "Condensed" shrinks the day column and rows so more
// of the timeline fits on screen at once; the default is comfortable for
// dragging bars around.
const DENSITY = {
  comfortable: { DAY_PX: 28, ROW_PX: 36, HEADER_PX: 56, LABEL_PX: 220 },
  condensed: { DAY_PX: 12, ROW_PX: 22, HEADER_PX: 44, LABEL_PX: 160 },
} as const

export function GanttView({
  data,
  hideComplete,
  onEdit,
}: {
  data: ScheduleData
  hideComplete: boolean
  onEdit: (id: string) => void
}) {
  const datedWorkItems = data.items.filter(
    (i) =>
      i.kind === "work" &&
      i.start_date &&
      i.end_date &&
      !i.recurrence_parent_id
  )
  const items = hideComplete
    ? datedWorkItems.filter((i) => i.status !== "complete")
    : datedWorkItems
  // Distinguishes "nothing scheduled" from "everything's done and hidden" so
  // the empty state below isn't misleading when Hide complete is on.
  const allHiddenByComplete =
    hideComplete && items.length === 0 && datedWorkItems.length > 0

  const [showCritical, setShowCritical] = useState(true)
  const [condensed, setCondensed] = useState(false)
  const { DAY_PX, ROW_PX, HEADER_PX, LABEL_PX } =
    condensed ? DENSITY.condensed : DENSITY.comfortable
  const analysis = useMemo(
    () => computeScheduleAnalysis(data.items, data.predecessors),
    [data.items, data.predecessors]
  )
  const criticalIds = analysis.critical
  const floatDays = analysis.floatDays
  const projectFinishLabel = useMemo(() => {
    if (analysis.projectFinishEpochDay == null) return null
    // Construct Date at UTC midnight of the epoch-day, then format in UTC
    // too (CodeRabbit #32). Without timeZone: "UTC" the formatter uses
    // the browser's local zone, which renders the previous calendar day
    // for any user west of UTC.
    const d = new Date(analysis.projectFinishEpochDay * 86400000)
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    })
  }, [analysis.projectFinishEpochDay])

  const { minDate, days } = useMemo(() => {
    if (items.length === 0) {
      const t = new Date()
      return {
        minDate: t,
        days: [] as Date[],
      }
    }
    const dates = items.flatMap((i) => [
      parseISO(i.start_date!),
      parseISO(i.end_date!),
    ])
    const today = new Date()
    dates.push(today)
    let min = dates.reduce((a, b) => (a < b ? a : b))
    let max = dates.reduce((a, b) => (a > b ? a : b))
    min = fnsAddDays(startOfDay(min), -3)
    max = fnsAddDays(startOfDay(max), 7)
    const days: Date[] = []
    for (let d = min; d <= max; d = fnsAddDays(d, 1)) days.push(d)
    return { minDate: min, days }
  }, [items])

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => a.start_date!.localeCompare(b.start_date!)),
    [items]
  )
  const rowIndex = new Map(sortedItems.map((it, i) => [it.id, i]))

  const containerRef = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [dragOffsets, setDragOffsets] = useState<Record<string, number>>({})
  // On a baselined schedule every drag needs a reason: the drop parks here
  // while the popup collects it. Cancel = the bar simply snaps back.
  const [pendingMove, setPendingMove] = useState<{
    itemId: string
    projectId: string
    currentStart: string
    currentEnd: string
    newStart: string
    newEnd: string
    days: number
  } | null>(null)
  const baselineSet = !!data.baseline_set_at
  // Track active drag listeners so they can be torn down if the component
  // unmounts mid-drag (e.g. user clicks the List view toggle while a bar is
  // being dragged). Without this, listeners leak and mouseup later triggers
  // moveScheduleItem on an unmounted component.
  const dragCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    return () => {
      dragCleanupRef.current?.()
      dragCleanupRef.current = null
    }
  }, [])

  function startDrag(
    e: React.MouseEvent,
    itemId: string,
    currentStart: string,
    currentEnd: string,
    projectId: string
  ) {
    e.preventDefault()
    e.stopPropagation()
    // Cancel any prior drag still wired up.
    dragCleanupRef.current?.()
    const startX = e.clientX
    let liveDays = 0

    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX
      liveDays = Math.round(dx / DAY_PX)
      setDragOffsets((s) => ({ ...s, [itemId]: liveDays }))
    }

    function cleanup() {
      window.removeEventListener("mousemove", onMove)
      window.removeEventListener("mouseup", onUp)
      dragCleanupRef.current = null
    }

    function onUp() {
      cleanup()
      setDragOffsets((s) => {
        const next = { ...s }
        delete next[itemId]
        return next
      })
      if (liveDays === 0) return
      const newStart = addDays(currentStart, liveDays)
      const newEnd = addDays(currentEnd, liveDays)
      // Baselined schedule: hold the move until the user gives a reason.
      // Every gantt bar is a dated work item, so no kind check needed.
      if (baselineSet) {
        setPendingMove({
          itemId,
          projectId,
          currentStart,
          currentEnd,
          newStart,
          newEnd,
          days: liveDays,
        })
        return
      }
      commitMove(
        { itemId, projectId, newStart, newEnd, days: liveDays },
        null
      )
    }

    window.addEventListener("mousemove", onMove)
    window.addEventListener("mouseup", onUp)
    dragCleanupRef.current = cleanup
  }

  function commitMove(
    mv: {
      itemId: string
      projectId: string
      newStart: string
      newEnd: string
      days: number
    },
    reason: MoveReasonT | null
  ) {
    startTransition(async () => {
      try {
        await moveScheduleItem({
          id: mv.itemId,
          project_id: mv.projectId,
          start_date: mv.newStart,
          end_date: mv.newEnd,
          move_reason: reason,
        })
        setPendingMove(null)
        toast.success(
          `Moved ${mv.days > 0 ? "+" : ""}${mv.days}d (successors cascaded)`
        )
        router.refresh()
      } catch (e) {
        toastActionError(e, "Move failed")
      }
    })
  }

  if (sortedItems.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDays className="h-10 w-10" />}
        title={
          allHiddenByComplete
            ? "All work items are complete"
            : "No scheduled work items"
        }
        description={
          allHiddenByComplete
            ? "They're hidden by “Hide complete.” Click “Show complete” to view them."
            : "Add a work item with start and end dates to see it on the Gantt chart."
        }
      />
    )
  }

  const totalWidth = LABEL_PX + days.length * DAY_PX
  const totalHeight = HEADER_PX + sortedItems.length * ROW_PX
  const todayIso = todayISO()
  const today = parseISO(todayIso)
  const todayX = LABEL_PX + differenceInCalendarDays(today, minDate) * DAY_PX

  // Group days by month for header.
  const monthGroups: { label: string; days: number; startIdx: number }[] = []
  for (let i = 0; i < days.length; i++) {
    const d = days[i]
    const label = format(d, "MMM yyyy")
    const last = monthGroups[monthGroups.length - 1]
    if (last && last.label === label) {
      last.days++
    } else {
      monthGroups.push({ label, days: 1, startIdx: i })
    }
  }

  // Predecessor arrows
  const arrows = data.predecessors.filter(
    (p) => rowIndex.has(p.item_id) && rowIndex.has(p.predecessor_id)
  )

  return (
    <div className="space-y-2">
    <div className="flex items-center justify-between gap-2 text-xs flex-wrap">
      {projectFinishLabel ? (
        <div className="inline-flex items-center gap-1.5 text-muted">
          <span className="uppercase tracking-wide text-[10px]">
            Project finish
          </span>
          <span className="font-medium text-foreground">
            {projectFinishLabel}
          </span>
          <span className="text-muted">
            · {criticalIds.size} critical item
            {criticalIds.size === 1 ? "" : "s"}
          </span>
        </div>
      ) : (
        <span />
      )}
      <div className="flex items-center gap-4">
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-muted hover:text-foreground">
          <input
            type="checkbox"
            checked={condensed}
            onChange={(e) => setCondensed(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <Minimize2 className="h-3.5 w-3.5" />
          Condense
        </label>
        <label className="inline-flex items-center gap-1.5 cursor-pointer select-none text-muted hover:text-foreground">
          <input
            type="checkbox"
            checked={showCritical}
            onChange={(e) => setShowCritical(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          <Zap className="h-3.5 w-3.5 text-danger" />
          Highlight critical path
          {criticalIds.size > 0 && (
            <span className="text-muted">({criticalIds.size})</span>
          )}
        </label>
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-1.5 cursor-pointer select-none text-muted hover:text-foreground"
          title="Print the Gantt chart / save it as a PDF"
        >
          <Printer className="h-3.5 w-3.5" />
          Print / PDF
        </button>
      </div>
    </div>
    <div
      ref={containerRef}
      className="bg-surface border border-border rounded-lg overflow-auto"
      style={{ maxHeight: "calc(100vh - 280px)" }}
    >
      <div
        className="relative"
        style={{ width: totalWidth, minHeight: totalHeight }}
      >
        {/* Sticky header rows */}
        <div
          className="sticky top-0 z-20 bg-surface border-b border-border"
          style={{ height: HEADER_PX }}
        >
          {/* Top: month labels */}
          <div
            className="absolute top-0 left-0 right-0 flex"
            style={{ height: HEADER_PX / 2, paddingLeft: LABEL_PX }}
          >
            {monthGroups.map((g) => (
              <div
                key={`${g.label}-${g.startIdx}`}
                className="border-r border-border text-xs font-medium text-muted flex items-center px-2"
                style={{ width: g.days * DAY_PX }}
              >
                {g.label}
              </div>
            ))}
          </div>
          {/* Day numbers */}
          <div
            className="absolute left-0 right-0 flex"
            style={{
              top: HEADER_PX / 2,
              height: HEADER_PX / 2,
              paddingLeft: LABEL_PX,
            }}
          >
            {days.map((d, i) => (
              <div
                key={i}
                className={cn(
                  "border-r border-border/60 text-[10px] text-center flex flex-col items-center justify-center",
                  isWeekend(d) && "bg-zinc-50 text-muted"
                )}
                style={{ width: DAY_PX }}
              >
                <span>{format(d, "d")}</span>
              </div>
            ))}
          </div>
          {/* Label column header */}
          <div
            className="absolute left-0 top-0 bottom-0 bg-surface border-r border-border flex items-center px-3 text-xs font-medium text-muted uppercase tracking-wide"
            style={{ width: LABEL_PX }}
          >
            Work item
          </div>
        </div>

        {/* Today line */}
        {todayX > LABEL_PX && todayX < totalWidth && (
          <div
            className="absolute z-10 pointer-events-none"
            style={{
              left: todayX,
              top: HEADER_PX,
              bottom: 0,
              width: 1,
              background: "#c62828",
            }}
            title="Today"
          />
        )}

        {/* Rows */}
        {sortedItems.map((item, i) => {
          const start = parseISO(item.start_date!)
          const end = parseISO(item.end_date!)
          const offset = differenceInCalendarDays(start, minDate)
          const dur = differenceInCalendarDays(end, start) + 1
          const x = LABEL_PX + offset * DAY_PX
          const y = HEADER_PX + i * ROW_PX
          const w = Math.max(dur * DAY_PX - 4, DAY_PX * 0.6)

          const barColor =
            item.status === "complete"
              ? "bg-emerald-500"
              : item.status === "delayed"
              ? "bg-red-500"
              : item.status === "in_progress"
              ? "bg-brand-500"
              : "bg-zinc-400"
          const isCritical = showCritical && criticalIds.has(item.id)

          return (
            <div key={item.id}>
              {/* Row background */}
              <div
                className={cn(
                  "absolute border-b border-border/40",
                  i % 2 === 1 && "bg-background/40"
                )}
                style={{
                  left: 0,
                  right: 0,
                  top: y,
                  height: ROW_PX,
                }}
              />
              {/* Weekend stripes on row */}
              {days.map((d, di) =>
                isWeekend(d) ? (
                  <div
                    key={di}
                    className="absolute pointer-events-none bg-zinc-100/60"
                    style={{
                      left: LABEL_PX + di * DAY_PX,
                      top: y,
                      width: DAY_PX,
                      height: ROW_PX,
                    }}
                  />
                ) : null
              )}
              {/* Label */}
              <div
                className={cn(
                  "absolute left-0 px-3 text-sm font-medium truncate bg-surface border-r border-border z-10 flex items-center",
                  isLateScheduleItem(item, todayIso)
                    ? "text-danger"
                    : "text-foreground"
                )}
                style={{
                  width: LABEL_PX,
                  top: y,
                  height: ROW_PX,
                }}
                title={item.title}
              >
                {item.title}
              </div>
              {/* Bar */}
              <button
                type="button"
                onClick={() => {
                  if (dragOffsets[item.id]) return
                  onEdit(item.id)
                }}
                onMouseDown={(e) =>
                  startDrag(
                    e,
                    item.id,
                    item.start_date!,
                    item.end_date!,
                    item.project_id
                  )
                }
                disabled={pending}
                className={cn(
                  "absolute rounded-md text-white text-xs font-medium px-2 truncate shadow-sm hover:opacity-90 active:opacity-80 text-left inline-flex items-center gap-1",
                  barColor,
                  isCritical && "ring-2 ring-red-500 ring-offset-1",
                  dragOffsets[item.id] ? "cursor-grabbing" : "cursor-grab"
                )}
                style={{
                  left: x + 2 + (dragOffsets[item.id] ?? 0) * DAY_PX,
                  top: y + 6,
                  width: w,
                  height: ROW_PX - 12,
                }}
                title={(() => {
                  const f = floatDays.get(item.id)
                  const slack =
                    typeof f === "number" && f > 0
                      ? ` · ${f}d float`
                      : isCritical
                        ? " · critical path"
                        : ""
                  return `${item.title} · ${dur}d${slack} · drag to reschedule`
                })()}
              >
                {isCritical && <Zap className="h-3 w-3 shrink-0" />}
                <span className="truncate">{item.title}</span>
              </button>
            </div>
          )
        })}

        {/* Predecessor arrows (SVG) */}
        <svg
          className="absolute pointer-events-none"
          style={{
            left: 0,
            top: 0,
            width: totalWidth,
            height: totalHeight,
          }}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 6 3, 0 6" fill="#94a3b8" />
            </marker>
            <marker
              id="arrowhead-critical"
              markerWidth="6"
              markerHeight="6"
              refX="5"
              refY="3"
              orient="auto"
            >
              <polygon points="0 0, 6 3, 0 6" fill="#ef4444" />
            </marker>
          </defs>
          {arrows.map((a) => {
            const succ = sortedItems.find((i) => i.id === a.item_id)
            const pred = sortedItems.find((i) => i.id === a.predecessor_id)
            if (!succ || !pred) return null
            const sIdx = rowIndex.get(succ.id)!
            const pIdx = rowIndex.get(pred.id)!
            const predEnd = parseISO(pred.end_date!)
            const succStart = parseISO(succ.start_date!)
            const x1 =
              LABEL_PX + (differenceInCalendarDays(predEnd, minDate) + 1) * DAY_PX - 2
            const y1 = HEADER_PX + pIdx * ROW_PX + ROW_PX / 2
            const x2 =
              LABEL_PX + differenceInCalendarDays(succStart, minDate) * DAY_PX + 2
            const y2 = HEADER_PX + sIdx * ROW_PX + ROW_PX / 2
            const midX = (x1 + x2) / 2
            const edgeCritical =
              showCritical && criticalIds.has(succ.id) && criticalIds.has(pred.id)
            return (
              <path
                key={a.id}
                d={`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`}
                stroke={edgeCritical ? "#ef4444" : "#94a3b8"}
                strokeWidth={edgeCritical ? "2" : "1.5"}
                fill="none"
                markerEnd={
                  edgeCritical ? "url(#arrowhead-critical)" : "url(#arrowhead)"
                }
              />
            )
          })}
        </svg>
      </div>
    </div>
    {pendingMove && (
      <MoveReasonDialog
        open={true}
        reasons={data.delayReasons}
        pending={pending}
        description={`${
          data.items.find((i) => i.id === pendingMove.itemId)?.title ?? "Item"
        }: ${formatDateRange(
          pendingMove.currentStart,
          pendingMove.currentEnd
        )} → ${formatDateRange(pendingMove.newStart, pendingMove.newEnd)} (${
          pendingMove.days > 0 ? "+" : ""
        }${pendingMove.days}d)`}
        onConfirm={(reason) => commitMove(pendingMove, reason)}
        onCancel={() => setPendingMove(null)}
      />
    )}
    <GanttPrintDocument
      data={data}
      sortedItems={sortedItems}
      days={days}
      minDate={minDate}
      monthGroups={monthGroups}
      criticalIds={criticalIds}
      showCritical={showCritical}
      arrows={arrows}
      rowIndex={rowIndex}
      projectFinishLabel={projectFinishLabel}
    />
    </div>
  )
}

// Print-only rendition of the chart. The live gantt can't print — it's a
// scroll container clipped to the viewport and often thousands of pixels
// wide — so this re-renders the same data as ONE viewBox-scaled SVG that the
// browser shrinks to the printable page width (landscape via the mounted
// @page style below). Hidden on screen; revealed by the #gantt-print-root
// rules in globals.css when the user hits Print / PDF.
function GanttPrintDocument({
  data,
  sortedItems,
  days,
  minDate,
  monthGroups,
  criticalIds,
  showCritical,
  arrows,
  rowIndex,
  projectFinishLabel,
}: {
  data: ScheduleData
  sortedItems: ScheduleData["items"]
  days: Date[]
  minDate: Date
  monthGroups: { label: string; days: number; startIdx: number }[]
  criticalIds: Set<string>
  showCritical: boolean
  arrows: ScheduleData["predecessors"]
  rowIndex: Map<string, number>
  projectFinishLabel: string | null
}) {
  // Logical units only — the viewBox scales everything to the page width.
  const DAY = 16
  const ROW = 20
  const HEADER = 36
  const LABEL = 190
  const W = LABEL + days.length * DAY
  const H = HEADER + sortedItems.length * ROW
  const todayXP = LABEL + differenceInCalendarDays(parseISO(todayISO()), minDate) * DAY
  // Day-level weekend stripes get noisy (and slow) on long timelines; keep
  // them for ~3 months and fall back to week gridlines beyond that.
  const showWeekends = days.length <= 100

  const project = data.projects.find((p) => p.id === data.project_id)
  const barFill = (status: string) =>
    status === "complete"
      ? "#10b981"
      : status === "delayed"
        ? "#ef4444"
        : status === "in_progress"
          ? "#1976d2"
          : "#a1a1aa"

  // Same date source as the today marker (todayISO) and the app's standard
  // fixed-locale formatter — no ambient-locale drift between server render
  // and hydration, and the header can never disagree with the marker.
  const printedOn = formatDate(todayISO())

  return (
    <div id="gantt-print-root">
      {/* Landscape only while the Gantt is mounted — a global @page rule
          would flip the Pricing PDF sideways too. */}
      <style>{`@media print { @page { size: letter landscape; margin: 0.5in; } }`}</style>
      <div className="gp-header">
        <div>
          <div className="gp-title">Construction schedule</div>
          <div className="gp-project">
            {project ? `#${project.project_number} — ${project.name}` : ""}
            {data.project_address ? ` · ${data.project_address}` : ""}
          </div>
          <div className="gp-sub">
            Printed {printedOn}
            {projectFinishLabel ? ` · Projected finish ${projectFinishLabel}` : ""}
            {` · ${sortedItems.length} work item${sortedItems.length === 1 ? "" : "s"}`}
          </div>
        </div>
        <div className="gp-legend">
          <span><i style={{ background: "#a1a1aa" }} /> Not started</span>
          <span><i style={{ background: "#1976d2" }} /> In progress</span>
          <span><i style={{ background: "#10b981" }} /> Complete</span>
          <span><i style={{ background: "#ef4444" }} /> Delayed</span>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: "100%", height: "auto" }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <marker
            id="gp-arrow"
            markerWidth="6"
            markerHeight="6"
            refX="5"
            refY="3"
            orient="auto"
          >
            <polygon points="0 0, 6 3, 0 6" fill="#94a3b8" />
          </marker>
        </defs>

        {/* Weekend shading / week gridlines */}
        {days.map((d, di) => {
          const x = LABEL + di * DAY
          if (showWeekends && isWeekend(d)) {
            return (
              <rect
                key={`w${di}`}
                x={x}
                y={HEADER}
                width={DAY}
                height={H - HEADER}
                fill="#f4f4f5"
              />
            )
          }
          if (!showWeekends && d.getDay() === 1) {
            return (
              <line
                key={`w${di}`}
                x1={x}
                y1={HEADER}
                x2={x}
                y2={H}
                stroke="#e4e4e7"
                strokeWidth="0.5"
              />
            )
          }
          return null
        })}

        {/* Month header */}
        {monthGroups.map((g) => {
          const x = LABEL + g.startIdx * DAY
          return (
            <g key={`${g.label}-${g.startIdx}`}>
              <line x1={x} y1={0} x2={x} y2={H} stroke="#d4d4d8" strokeWidth="0.75" />
              <text x={x + 4} y={13} fontSize="10" fill="#52525b" fontWeight="600">
                {g.label}
              </text>
            </g>
          )
        })}
        <line x1={0} y1={HEADER - 8} x2={W} y2={HEADER - 8} stroke="#a1a1aa" strokeWidth="0.75" />
        <line x1={LABEL} y1={0} x2={LABEL} y2={H} stroke="#a1a1aa" strokeWidth="0.75" />

        {/* Rows: separator, label, bar */}
        {sortedItems.map((item, i) => {
          const y = HEADER + i * ROW
          const offset = differenceInCalendarDays(parseISO(item.start_date!), minDate)
          const dur =
            differenceInCalendarDays(
              parseISO(item.end_date!),
              parseISO(item.start_date!)
            ) + 1
          const bx = LABEL + offset * DAY
          const bw = Math.max(dur * DAY - 1, DAY * 0.6)
          const isCritical = showCritical && criticalIds.has(item.id)
          // SVG text doesn't ellipsize; cap the label to what fits the column.
          const label =
            item.title.length > 34 ? `${item.title.slice(0, 33)}…` : item.title
          return (
            <g key={item.id}>
              <line
                x1={0}
                y1={y + ROW}
                x2={W}
                y2={y + ROW}
                stroke="#f0f0f1"
                strokeWidth="0.5"
              />
              <text x={4} y={y + ROW / 2 + 3.5} fontSize="9" fill="#18181b">
                {label}
              </text>
              <rect
                x={bx}
                y={y + 3}
                width={bw}
                height={ROW - 6}
                rx={3}
                fill={barFill(item.status)}
                stroke={isCritical ? "#ef4444" : "none"}
                strokeWidth={isCritical ? 1.5 : 0}
              />
              {/* Duration inside the bar when it fits */}
              {bw >= 26 && (
                <text
                  x={bx + 4}
                  y={y + ROW / 2 + 3}
                  fontSize="8"
                  fill="#ffffff"
                >
                  {dur}d
                </text>
              )}
            </g>
          )
        })}

        {/* Predecessor arrows */}
        {arrows.map((a) => {
          const succ = sortedItems.find((i) => i.id === a.item_id)
          const pred = sortedItems.find((i) => i.id === a.predecessor_id)
          if (!succ || !pred) return null
          const sIdx = rowIndex.get(succ.id)!
          const pIdx = rowIndex.get(pred.id)!
          const x1 =
            LABEL +
            (differenceInCalendarDays(parseISO(pred.end_date!), minDate) + 1) * DAY
          const y1 = HEADER + pIdx * ROW + ROW / 2
          const x2 =
            LABEL + differenceInCalendarDays(parseISO(succ.start_date!), minDate) * DAY
          const y2 = HEADER + sIdx * ROW + ROW / 2
          const midX = (x1 + x2) / 2
          return (
            <path
              key={a.id}
              d={`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`}
              stroke="#94a3b8"
              strokeWidth="0.75"
              fill="none"
              markerEnd="url(#gp-arrow)"
            />
          )
        })}

        {/* Today */}
        {todayXP > LABEL && todayXP < W && (
          <line
            x1={todayXP}
            y1={HEADER - 8}
            x2={todayXP}
            y2={H}
            stroke="#c62828"
            strokeWidth="1"
            strokeDasharray="3 2"
          />
        )}
      </svg>
    </div>
  )
}
