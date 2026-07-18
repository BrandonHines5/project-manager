import Link from "next/link"

export const metadata = {
  title: "End-User License Agreement — BuildFox",
  description:
    "End-user license agreement for BuildFox, the Hines Homes project-management application.",
}

// Public page (outside the (app) auth group) — no requireSession(), so it is
// reachable without login. Required as a public URL for the Intuit QuickBooks
// app assessment (End-User License Agreement URL).
export default function EulaPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-foreground">
      <h1 className="text-3xl font-semibold tracking-tight">
        End-User License Agreement
      </h1>
      <p className="mt-2 text-sm text-muted">Last updated: July 9, 2026</p>

      <div className="mt-8 space-y-6 text-sm leading-6">
        <section>
          <p>
            This End-User License Agreement (&ldquo;Agreement&rdquo;) governs
            your use of BuildFox, the Hines Homes project-management application (the
            &ldquo;Application&rdquo;), operated by Hines Homes (&ldquo;we,&rdquo;
            &ldquo;us,&rdquo; or &ldquo;our&rdquo;). The Application is an
            internal business tool provided to authorized employees, contractors,
            and trade partners of Hines Homes. By accessing or using the
            Application, you agree to be bound by this Agreement.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">1. License</h2>
          <p className="mt-2">
            We grant you a limited, non-exclusive, non-transferable, revocable
            license to access and use the Application solely for legitimate
            business purposes on behalf of Hines Homes and in accordance with the
            access level assigned to your account. You may not copy, modify,
            distribute, sell, or lease any part of the Application, nor reverse-
            engineer or attempt to extract its source code, except as permitted
            by law.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">2. QuickBooks Online integration</h2>
          <p className="mt-2">
            The Application can connect to a QuickBooks Online company at your
            direction to create and synchronize purchase orders and to read
            related accounting reference data (such as vendors, accounts, items,
            and company information). Your use of QuickBooks Online remains
            subject to Intuit&rsquo;s own terms of service and privacy policy. You
            are responsible for ensuring you are authorized to connect the
            QuickBooks Online company you select. You may disconnect the
            integration at any time from within the Application.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">3. Acceptable use</h2>
          <p className="mt-2">
            You agree not to use the Application to violate any law, infringe any
            third party&rsquo;s rights, or attempt to gain unauthorized access to
            any system or data. You are responsible for maintaining the
            confidentiality of your account credentials and for all activity that
            occurs under your account.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">4. Disclaimer of warranties</h2>
          <p className="mt-2">
            The Application is provided &ldquo;as is&rdquo; and &ldquo;as
            available&rdquo; without warranties of any kind, whether express or
            implied, including any implied warranties of merchantability, fitness
            for a particular purpose, or non-infringement. We do not warrant that
            the Application will be uninterrupted, error-free, or free of harmful
            components.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">5. Limitation of liability</h2>
          <p className="mt-2">
            To the maximum extent permitted by law, Hines Homes will not be
            liable for any indirect, incidental, special, consequential, or
            punitive damages, or any loss of profits or data, arising out of or
            related to your use of the Application.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">6. Termination</h2>
          <p className="mt-2">
            We may suspend or terminate your access to the Application at any time
            for any reason, including violation of this Agreement. Upon
            termination, the license granted to you ends and you must stop using
            the Application.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">7. Contact</h2>
          <p className="mt-2">
            Questions about this Agreement may be directed to{" "}
            <a className="text-brand-600 underline" href="mailto:brandon@hineshomes.com">
              brandon@hineshomes.com
            </a>
            .
          </p>
        </section>

        <p className="pt-4 text-muted">
          See also our{" "}
          <Link className="text-brand-600 underline" href="/legal/privacy">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </main>
  )
}
