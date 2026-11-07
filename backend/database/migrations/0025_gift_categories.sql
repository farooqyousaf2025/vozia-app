-- 0025 — Gift categories become a list the operator owns.
--
-- `gifts.category` has been a VARCHAR(24) since the first schema, and for four years the only list
-- of its legal values was a comment (`-- ROSE | SPECIAL | LUXURY | EVENT`) plus a dropdown in the
-- admin panel and a `as const` array beside it. Nothing else read them, because nothing else had to:
-- the phone builds its gift-panel tabs from whatever the catalogue actually contains, so a category
-- invented in SQL would have appeared on the app the moment a gift used it, and an operator who
-- wanted a "Season" shelf needed a developer. Meanwhile the column accepted any string under 25
-- characters, so `cathegory: 'Luxury '` and `'LUXURY'` were two different shelves with the same name.
--
-- This makes the list a table. It carries a display `name` separate from the `key`, because the key
-- is what a thousand gift rows and every historical transaction refer to, while the label is copy an
-- operator may want to rewrite on a Tuesday. Ordering moves here too: the tab strip is an editorial
-- decision, and `sort_order` on the gifts themselves says nothing about which shelf comes first.
--
-- The foreign key is RESTRICT, not CASCADE, and not absent. Deleting a shelf must not silently
-- re-file the gifts under it — that is what an operator would have to unpick by hand — so the
-- database refuses, and `deleteGiftCategory` names the gifts that are in the way. The alternative
-- (no FK, validate in service) would let a hand-edited row create a category no screen can reach.

CREATE TABLE IF NOT EXISTS gift_categories (
  -- Upper snake, because that is what every existing value already looks like; widening the shape
  -- would mean migrating the rows below and every gift that names one. 24 characters matches the
  -- column it is keyed against, so no gift can name a shelf that is too long to exist.
  key        VARCHAR(24) PRIMARY KEY CHECK (key ~ '^[A-Z0-9][A-Z0-9_]{1,23}$'),
  name       VARCHAR(40) NOT NULL,
  sort_order INTEGER     NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  DROP TRIGGER IF EXISTS gift_categories_updated_at ON gift_categories;
  CREATE TRIGGER gift_categories_updated_at BEFORE UPDATE ON gift_categories
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END $$;

COMMENT ON TABLE gift_categories IS 'The shelves the gift panel tabs are built from. Admin-managed; published in sort order by GET /api/gifts beside the catalogue.';
COMMENT ON COLUMN gift_categories.key IS 'gifts.category points here. Immutable: a rename is an edit to `name`, not to the key, because the key is stored on every gift and is what a receipt-era grouping question asks.';
COMMENT ON COLUMN gift_categories.name IS 'What the tab says. Free text for the operator; the app draws it as-is, so no screen has to know a new shelf exists before it can show it.';
COMMENT ON COLUMN gift_categories.sort_order IS 'Tab order, cheapest-shelf-first is not a rule the server enforces — the operator decides, and the app follows.';

-- ---------------------------------------------------------------------------
-- Seed, then adopt whatever the catalogue already uses
-- ---------------------------------------------------------------------------
--
-- The four names from the schema comment come first, in the order the panel has always shown them.
-- Then every distinct value a gift row already carries becomes a shelf too: on a live database that
-- is how a category created by hand in SQL survives the switch instead of breaking the foreign key,
-- and on a fresh one the query adds nothing. Appended after the seeded block so an operator's own
-- ordering is not scrambled by whatever was in the table before.

INSERT INTO gift_categories (key, name, sort_order) VALUES
  ('ROSE',    'Roses',    10),
  ('SPECIAL', 'Special',  20),
  ('LUXURY',  'Luxury',   30),
  ('EVENT',   'Events',   40)
ON CONFLICT (key) DO NOTHING;

INSERT INTO gift_categories (key, name, sort_order)
SELECT unused.key,
       INITCAP(LOWER(REPLACE(unused.key, '_', ' '))),
       -- One notch past the last row each time, on the same tens ladder the seeds use, and ordered by
       -- key so two runs over the same data land on the same numbers.
       10 * ((SELECT count(*) FROM gift_categories) + row_number() OVER (ORDER BY unused.key))
  FROM (SELECT DISTINCT category AS key FROM gifts) AS unused
 WHERE unused.key NOT IN (SELECT key FROM gift_categories)
ON CONFLICT (key) DO NOTHING;

ALTER TABLE gifts DROP CONSTRAINT IF EXISTS gifts_category_fkey;
ALTER TABLE gifts ADD CONSTRAINT gifts_category_fkey
  FOREIGN KEY (category) REFERENCES gift_categories (key) ON DELETE RESTRICT;

COMMENT ON COLUMN gifts.category IS 'gift_categories.key. A gift cannot be filed under a shelf that has not been added, and a shelf with gifts in it cannot be deleted.';
