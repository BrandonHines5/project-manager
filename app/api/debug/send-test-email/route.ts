import { NextResponse } from "next/server"
import { sendEmail } from "@/lib/email"

// TEMPORARY diagnostic endpoint. Calls sendEmail directly (bypassing all the
// decision/approval logic) and returns its exact result, so we can see whether
// Resend accepts the send or returns an error — something the runtime logs in
// this project don't surface. Recipient is hard-coded to the owner so it can't
// be used to send mail to arbitrary addresses. Remove once email is verified.

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET() {
  try {
    const result = await sendEmail({
      to: "brandon@hineshomes.com",
      subject: "Hines Homes — test email (probe)",
      text: "This is a direct sendEmail() test from /api/debug/send-test-email. If you received this, Resend sending works end to end.",
    })
    return NextResponse.json({ ok: true, result })
  } catch (e) {
    return NextResponse.json(
      { ok: false, threw: true, message: e instanceof Error ? e.message : String(e) },
      { status: 200 }
    )
  }
}
