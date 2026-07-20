import { ResetPasswordForm } from "./reset-password-form"

export const metadata = { title: "Reset password — BuildFox" }
export const dynamic = "force-dynamic"

export default function ResetPasswordPage() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/buildfox-mark.svg"
            alt="BuildFox"
            className="mx-auto h-12 w-12 rounded-lg shadow-sm"
          />
          <h1 className="mt-4 text-2xl font-semibold text-foreground">BuildFox</h1>
        </div>
        <ResetPasswordForm />
      </div>
    </div>
  )
}
