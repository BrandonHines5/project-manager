"use client"

import { useState, useTransition } from "react"
import { toast } from "sonner"
import { Card, CardBody } from "@/components/ui/card"
import { Select, Label } from "@/components/ui/input"
import { saveNotificationPreference } from "@/app/actions/notification-preferences"
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_CHANNELS,
  CHANNELS_BY_CATEGORY,
  type NotificationCategory,
  type NotificationChannel,
} from "@/lib/notifications/preferences"

type Profile = {
  id: string
  full_name: string | null
  email: string | null
  role: "staff" | "trade" | "client"
}
type Company = { id: string; name: string }

export function NotificationsSettingsClient({
  me,
  profiles,
  companies,
  initialPrefs,
}: {
  me: { id: string; name: string; role: "staff" | "trade" | "client" }
  profiles: Profile[]
  companies: Company[]
  initialPrefs: Record<string, boolean>
}) {
  const isStaff = me.role === "staff"
  const [owner, setOwner] = useState(`p:${me.id}`)
  const [prefs, setPrefs] = useState(initialPrefs)
  const [, startTransition] = useTransition()

  const isCompanyOwner = owner.startsWith("c:")

  function channelApplies(
    category: NotificationCategory,
    channel: NotificationChannel
  ) {
    // Companies (subs/vendors) have no in-app bell.
    if (isCompanyOwner && channel === "in_app") return false
    return CHANNELS_BY_CATEGORY[category].includes(channel)
  }

  function isEnabled(category: NotificationCategory, channel: NotificationChannel) {
    return prefs[`${owner}|${category}|${channel}`] !== false
  }

  function toggle(
    category: NotificationCategory,
    channel: NotificationChannel,
    enabled: boolean
  ) {
    const key = `${owner}|${category}|${channel}`
    setPrefs((p) => ({ ...p, [key]: enabled }))
    const kind = owner[0]
    const id = owner.slice(2)
    startTransition(async () => {
      try {
        await saveNotificationPreference({
          profile_id: kind === "p" ? id : null,
          company_id: kind === "c" ? id : null,
          category,
          channel,
          enabled,
        })
      } catch (e) {
        setPrefs((p) => ({ ...p, [key]: !enabled }))
        toast.error(e instanceof Error ? e.message : "Failed to save")
      }
    })
  }

  const teamMembers = profiles.filter((p) => p.role === "staff" && p.id !== me.id)
  const clients = profiles.filter((p) => p.role === "client")
  const subs = profiles.filter((p) => p.role === "trade")

  return (
    <div className="max-w-3xl mx-auto px-4 md:px-6 py-6">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">
          Notification settings
        </h1>
        <p className="text-sm text-muted">
          Choose which notifications go out and on which channel. A checked box
          means that notification is on; anyone with no changes gets everything
          by default.
        </p>
      </div>

      {isStaff && (
        <div className="mb-4 max-w-md">
          <Label className="mb-1">Whose settings</Label>
          <Select value={owner} onChange={(e) => setOwner(e.target.value)}>
            <option value={`p:${me.id}`}>You ({me.name})</option>
            {teamMembers.length > 0 && (
              <optgroup label="Team members">
                {teamMembers.map((p) => (
                  <option key={p.id} value={`p:${p.id}`}>
                    {p.full_name || p.email}
                  </option>
                ))}
              </optgroup>
            )}
            {clients.length > 0 && (
              <optgroup label="Clients">
                {clients.map((p) => (
                  <option key={p.id} value={`p:${p.id}`}>
                    {p.full_name || p.email}
                  </option>
                ))}
              </optgroup>
            )}
            {subs.length > 0 && (
              <optgroup label="Subs (individual logins)">
                {subs.map((p) => (
                  <option key={p.id} value={`p:${p.id}`}>
                    {p.full_name || p.email}
                  </option>
                ))}
              </optgroup>
            )}
            {companies.length > 0 && (
              <optgroup label="Companies (subs & vendors)">
                {companies.map((c) => (
                  <option key={c.id} value={`c:${c.id}`}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
          {isCompanyOwner && (
            <p className="text-xs text-muted mt-1">
              Companies receive email and SMS only (no in-app bell).
            </p>
          )}
        </div>
      )}

      <Card>
        <CardBody className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left">
                <th className="px-4 py-2.5 font-medium">Notification</th>
                {NOTIFICATION_CHANNELS.map((ch) => (
                  <th
                    key={ch.key}
                    className="px-4 py-2.5 font-medium text-center w-24"
                  >
                    {ch.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_CATEGORIES.map((cat) => (
                <tr key={cat.key} className="border-b border-border last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{cat.label}</div>
                    <div className="text-xs text-muted">{cat.description}</div>
                  </td>
                  {NOTIFICATION_CHANNELS.map((ch) => (
                    <td key={ch.key} className="px-4 py-3 text-center">
                      {channelApplies(cat.key, ch.key) ? (
                        <input
                          type="checkbox"
                          className="h-4 w-4 cursor-pointer"
                          aria-label={`${cat.label} — ${ch.label}`}
                          checked={isEnabled(cat.key, ch.key)}
                          onChange={(e) =>
                            toggle(cat.key, ch.key, e.target.checked)
                          }
                        />
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </Card>

      <p className="text-xs text-muted mt-3">
        In-app notifications are enforced instantly. Email and SMS preferences
        apply to assignment, bid/PO, comment, client-decision, and reminder
        messages sent by the app.
      </p>
    </div>
  )
}
