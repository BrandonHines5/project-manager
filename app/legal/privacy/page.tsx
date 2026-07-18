import Link from "next/link"

export const metadata = {
  title: "Privacy Policy — BuildFox",
  description:
    "Privacy policy for BuildFox, the Hines Homes project-management application, and its QuickBooks Online integration.",
}

// Public page (outside the (app) auth group) — no requireSession(), so it is
// reachable without login. Required as a public URL for the Intuit QuickBooks
// app assessment (Privacy Policy URL).
export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 text-foreground">
      <h1 className="text-3xl font-semibold tracking-tight">Privacy Policy</h1>
      <p className="mt-2 text-sm text-muted">Last updated: July 9, 2026</p>

      <div className="mt-8 space-y-6 text-sm leading-6">
        <section>
          <p>
            This Privacy Policy explains how Hines Homes (&ldquo;we,&rdquo;
            &ldquo;us,&rdquo; or &ldquo;our&rdquo;) handles information in
            connection with BuildFox, our project-management application (the
            &ldquo;Application&rdquo;), an internal business tool used to manage
            construction projects, purchase orders, and related workflows.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Information we handle</h2>
          <p className="mt-2">
            The Application stores business records you and your team create,
            including projects, schedules, purchase orders, bid requests,
            decisions, daily logs, companies (subcontractors and vendors), and
            user account details such as name and email address. Accounts are
            provisioned for authorized Hines Homes staff, clients, and trade
            partners.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">QuickBooks Online data</h2>
          <p className="mt-2">
            When you connect a QuickBooks Online company, the Application accesses
            your Intuit accounting data only as needed to synchronize purchase
            orders. Specifically, it may:
          </p>
          <ul className="mt-2 list-disc space-y-1 pl-6">
            <li>
              create and update purchase orders in your QuickBooks Online company;
            </li>
            <li>
              read reference data used to build those purchase orders — vendors,
              accounts, items/cost codes, customers/jobs, classes, and company
              information.
            </li>
          </ul>
          <p className="mt-2">
            We do not access QuickBooks payroll, banking credentials, or customer
            payment card data. We do not sell, rent, or share your QuickBooks data
            with third parties for their own marketing or other purposes. The
            connection is made at your direction and can be disconnected at any
            time from within the Application, which revokes the Application&rsquo;s
            access.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Authentication tokens</h2>
          <p className="mt-2">
            To maintain the QuickBooks Online connection, the Application stores
            OAuth access and refresh tokens issued by Intuit. These tokens are
            stored on our secured backend and are used only to make authorized API
            requests on your behalf. They are not exposed to end-user browsers and
            are deleted when you disconnect the integration.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Service providers</h2>
          <p className="mt-2">
            The Application is hosted on Vercel and stores its data in Supabase
            (PostgreSQL). It integrates with third-party services including Intuit
            QuickBooks Online. These providers process data on our behalf under
            their respective terms and security practices.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Data retention &amp; security</h2>
          <p className="mt-2">
            We retain business records for as long as needed to operate our
            business and meet legal obligations. We apply administrative and
            technical safeguards — including access controls, row-level security,
            and encrypted transport — to protect the information in the
            Application. No method of transmission or storage is completely
            secure, and we cannot guarantee absolute security.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Changes</h2>
          <p className="mt-2">
            We may update this Privacy Policy from time to time. Material changes
            will be reflected by the &ldquo;Last updated&rdquo; date above.
          </p>
        </section>

        <section>
          <h2 className="text-lg font-semibold">Contact</h2>
          <p className="mt-2">
            Questions about this Privacy Policy may be directed to{" "}
            <a className="text-brand-600 underline" href="mailto:brandon@hineshomes.com">
              brandon@hineshomes.com
            </a>
            .
          </p>
        </section>

        <p className="pt-4 text-muted">
          See also our{" "}
          <Link className="text-brand-600 underline" href="/legal/eula">
            End-User License Agreement
          </Link>
          .
        </p>
      </div>
    </main>
  )
}
