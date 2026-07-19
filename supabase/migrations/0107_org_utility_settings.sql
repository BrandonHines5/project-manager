-- 0107: Stage B3 (part 2) — seed org #1's utility-provider settings.
--
-- The Initiate Utilities module's builder identity, provider intake emails,
-- CAW payment URL, and regional lookup maps now resolve from
-- `organizations.settings.utilities` (lib/utilities/org-config.ts). This
-- seeds org #1 with the exact literals the code used to hardcode. An org
-- WITHOUT a utilities block doesn't have the module — the page renders its
-- not-configured state and the actions refuse to send.
--
-- Deliberately NOT seeded (left to resolve through their existing env-var
-- fallbacks, so current deploys behave identically and the env override
-- keeps working until a settings editor exists in B5):
--   builder.tin            → CAW_BUILDER_TIN
--   caw.submissionEmail    → CAW_SUBMISSION_EMAIL (falls back to the CAW
--                            new-construction intake)
--   caw.paymentUrl         → CAW_PAYMENT_URL
--   lumberOne.submissionEmail → LUMBER_ONE_SUBMISSION_EMAIL (falls back to
--                            Brad Hartwick's inbox)

update organizations
set settings = jsonb_set(
  settings,
  '{utilities}',
  '{
    "builder": {
      "companyName": "Hines Homes, LLC",
      "businessPhone": "501-802-8453",
      "altPhone": "",
      "email": "info@hineshomes.com",
      "mailingAddress": "401 Commerce Drive, Maumelle, AR 72113",
      "preparerName": "Adam Verhalen"
    },
    "caw": {
      "zipBySubdivision": {
        "natural trail estates": "72113",
        "ridgeview trails": "72113"
      },
      "zipByCity": {
        "maumelle": "72113"
      }
    },
    "lumberOne": {
      "countyByCity": {
        "maumelle": "Pulaski",
        "little rock": "Pulaski",
        "north little rock": "Pulaski",
        "sherwood": "Pulaski",
        "jacksonville": "Pulaski",
        "roland": "Pulaski",
        "scott": "Pulaski",
        "wrightsville": "Pulaski",
        "mayflower": "Faulkner",
        "conway": "Faulkner",
        "greenbrier": "Faulkner",
        "vilonia": "Faulkner",
        "cabot": "Lonoke",
        "ward": "Lonoke",
        "austin": "Lonoke",
        "lonoke": "Lonoke",
        "benton": "Saline",
        "bryant": "Saline",
        "alexander": "Saline",
        "stuttgart": "Arkansas"
      },
      "deliveryNoteBySubdivision": {
        "stonebrook": "Gate Code 4003"
      }
    }
  }'::jsonb,
  true
)
where id = '018f6f2a-4c1e-4b8e-9d3a-7c5b2e8a1f10';
