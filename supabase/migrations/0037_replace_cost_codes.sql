-- Replace the generic seed cost codes (from 0010) with Hines Homes' canonical
-- cost-code list. This new list becomes the ONLY set of codes offered in the
-- decisions cost-code picker.
--
-- The owner supplied names only, so codes are assigned sequentially in the
-- given alphabetical order with gaps of 10 (so new codes can be slotted between
-- siblings later without renumbering). `position` mirrors the code so the picker
-- lists them in the same order.
--
-- Existing decision_cost_items that referenced an old code are remapped to the
-- closest code in the new list BEFORE the old rows are deleted (the FK is
-- `on delete set null`, so remap-first preserves the linkage). Live data review
-- showed only three old codes were in use:
--   80-200 Drywall              -> Drywall - Materials
--   90-100 Interior Trim & Doors -> Interior Trim - Materials
--   90-200 Cabinets             -> Cabinets
-- No decisions.allowance_cost_code_id referenced any old code.

-- 1. Insert the canonical list.
insert into public.cost_codes (code, name, position) values
  ('10',  'Appliances', 10),
  ('20',  'Audio Video Security', 20),
  ('30',  'Bank Fees', 30),
  ('40',  'Cabinets', 40),
  ('50',  'Carpet - Labor', 50),
  ('60',  'Carpet - Materials', 60),
  ('70',  'Closing Costs', 70),
  ('80',  'Countertops - Main Surface', 80),
  ('90',  'Countertops - Sinks and Cutouts', 90),
  ('100', 'Deck - Composite Materials', 100),
  ('110', 'Deck - Labor', 110),
  ('120', 'Deck - Wood Materials', 120),
  ('130', 'Demo', 130),
  ('140', 'Doors - Exterior', 140),
  ('150', 'Doors - Front', 150),
  ('160', 'Doors - Interior', 160),
  ('170', 'Driveway / Walkway - Concrete', 170),
  ('180', 'Driveway / Walkway - Labor', 180),
  ('190', 'Driveway / Walkway - Other Matl', 190),
  ('200', 'Drywall - Labor and Joint Cmpd', 200),
  ('210', 'Drywall - Materials', 210),
  ('220', 'Earthworks - Block Fill', 220),
  ('230', 'Earthworks - Final Grade', 230),
  ('240', 'Earthworks - Site Prep', 240),
  ('250', 'Electrical Fixtures - Deco', 250),
  ('260', 'Electrical Fixtures - Other', 260),
  ('270', 'Electrician', 270),
  ('280', 'Engineering Fees', 280),
  ('290', 'Equipment Rental', 290),
  ('300', 'Exterior Siding', 300),
  ('310', 'Exterior Trim', 310),
  ('320', 'Fence', 320),
  ('330', 'Fireplace', 330),
  ('340', 'Foundation - Blocks - Labor', 340),
  ('350', 'Foundation - Blocks - Materials', 350),
  ('360', 'Foundation - Blocks -Waterproof', 360),
  ('370', 'Foundation - Footings - Labor', 370),
  ('380', 'Foundation - Footings - Other M', 380),
  ('390', 'Foundation - Footings - Pump', 390),
  ('400', 'Foundation - Footings -Concrete', 400),
  ('410', 'Foundation - Slab - Concrete', 410),
  ('420', 'Foundation - Slab - Labor', 420),
  ('430', 'Foundation - Slab - Other Matl', 430),
  ('440', 'Foundation - Slab - Pump Truck', 440),
  ('450', 'Framing - Labor', 450),
  ('460', 'Framing - Materials', 460),
  ('470', 'Garage Doors', 470),
  ('480', 'Glass & Mirrors', 480),
  ('490', 'Gutters', 490),
  ('500', 'Hardware', 500),
  ('510', 'HVAC', 510),
  ('520', 'Insulation', 520),
  ('530', 'Interior Trim - Labor', 530),
  ('540', 'Interior Trim - Materials', 540),
  ('550', 'Landscaping - Irrigation', 550),
  ('560', 'Landscaping - Other', 560),
  ('570', 'Landscaping - Retaining Wall', 570),
  ('580', 'Landscaping - Sod Flower Beds', 580),
  ('590', 'LVT - Labor', 590),
  ('600', 'LVT - Materials', 600),
  ('610', 'Mailbox', 610),
  ('620', 'Masonry - Brick - Labor', 620),
  ('630', 'Masonry - Brick - Materials', 630),
  ('640', 'Masonry - Stone - Mat and Labor', 640),
  ('650', 'Masonry - Stucco / Dryvit', 650),
  ('660', 'Paint / Stain - Exterior', 660),
  ('670', 'Paint / Stain - Interior', 670),
  ('680', 'Plumbing - Freestanding Tub', 680),
  ('690', 'Plumbing - Grinder Pump', 690),
  ('700', 'Plumbing - Labor and Fixtures', 700),
  ('710', 'Plumbing - Septic', 710),
  ('720', 'Preliminary', 720),
  ('730', 'Property Taxes', 730),
  ('740', 'Railing - Metal', 740),
  ('750', 'Roofing - Labor', 750),
  ('760', 'Roofing - Materials', 760),
  ('770', 'Safe Room', 770),
  ('780', 'Site Clean-up', 780),
  ('790', 'Stained Concrete', 790),
  ('800', 'Structural Steel', 800),
  ('810', 'Tile - Labor', 810),
  ('820', 'Tile - Materials', 820),
  ('830', 'Utilities', 830),
  ('840', 'Windows', 840),
  ('850', 'Wood Floors - Labor', 850),
  ('860', 'Wood Floors - Materials', 860)
on conflict (code) do nothing;

-- 2. Remap in-use line items from old codes to their closest new code.
--    New codes are referenced by their assigned `code` (not name) because some
--    names — Cabinets, HVAC, Insulation, Appliances, Gutters, Exterior Siding —
--    exist in both the old and new lists and would be ambiguous by name.
update public.decision_cost_items
   set cost_code_id = (select id from public.cost_codes where code = '210')  -- Drywall - Materials
 where cost_code_id = (select id from public.cost_codes where code = '80-200');

update public.decision_cost_items
   set cost_code_id = (select id from public.cost_codes where code = '540')  -- Interior Trim - Materials
 where cost_code_id = (select id from public.cost_codes where code = '90-100');

update public.decision_cost_items
   set cost_code_id = (select id from public.cost_codes where code = '40')   -- Cabinets
 where cost_code_id = (select id from public.cost_codes where code = '90-200');

-- 3. Remove the old seed codes. They all use the NN-NNN format (e.g. 10-100,
--    999-999); the new codes are plain digits, so this pattern only matches the
--    legacy rows. Any references they had were remapped in step 2.
delete from public.cost_codes where code ~ '^\d+-\d+$';
