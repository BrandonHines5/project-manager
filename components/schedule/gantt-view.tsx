"use client"

import { useMemo, useRef } from "react"
import { addDays as fnsAddDays, differenceInCalendarDays, parseISO, format, isWeekend, startOfDay } from "date-fns"
import { CalendarDays } from "lucide-react"
import { EmptyState } from "@/components/ui/empty"
import { cn, todayISO } from "@/lib/utils"
import type { ScheduleData } from "@/app/(app)/projects/[id]/schedule/schedule-client"

const DAY_PX = 28
const ROW_PX = 36
const HEADER_PX = 56
const LABEL_PX = 220

export function GanttView({
  data,
  onEdit,
}: {
  data: ScheduleData
  onEdit: (id: string) => void
}) {
  const items = data.items.filter(
    (i) => i.kind === "work" && i.start_date && i.end_date && !i.recurrence_parent_id
  )

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

  if (sortedItems.length === 0) {
    return (
      <EmptyState
        icon={<CalendarDays className="h-10 w-10" />}
        title="No scheduled work items"
        description="Add a work item with start and end dates to see it on the Gantt chart."
      />
    )
  }

  const totalWidth = LABEL_PX + days.length * DAY_PX
  const totalHeight = HEADER_PX + sortedItems.length * ROW_PX
  const today = parseISO(todayISO())
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
    <div
      ref={containerRef}
      className="bg-surface border border-border rounded-lg overflow-auto"
      style={{ maxHeight: "calc(100vh - 240px)" }}
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
                className="absolute left-0 px-3 text-sm font-medium text-foreground truncate bg-surface border-r border-border z-10 flex items-center"
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
                onClick={() => onEdit(item.id)}
                className={cn(
                  "absolute rounded-md text-white text-xs font-medium px-2 truncate shadow-sm hover:opacity-90 cursor-pointer text-left",
                  barColor
                )}
                style={{
                  left: x + 2,
                  top: y + 6,
                  width: w,
                  height: ROW_PX - 12,
                }}
                title={`${item.title} · ${dur}d`}
              >
                {item.title}
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
            return (
              <path
                key={a.id}
                d={`M ${x1} ${y1} L ${midX} ${y1} L ${midX} ${y2} L ${x2} ${y2}`}
                stroke="#94a3b8"
                strokeWidth="1.5"
                fill="none"
                markerEnd="url(#arrowhead)"
              />
            )
          })}
        </svg>
      </div>
    </div>
  )
}
