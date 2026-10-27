-- 0006_business_parent_rule.sql — correct who may report to whom.
--
-- 0004 expressed "a seller cannot own another seller" as
--     CHECK (kind = 'COIN_SELLER' OR parent_id IS NULL)
-- which also banned the shape §21 asks for: BD agents under a BD manager. A CHECK cannot
-- look at the parent row, so the rule moves into a trigger and reads correctly:
--   * a coin seller reports to a BD account (manager or agent)
--   * a BD agent reports to a BD manager
--   * a BD manager has no parent
--   * nobody parents a coin seller

ALTER TABLE business_accounts DROP CONSTRAINT IF EXISTS business_accounts_kind_parent_check;

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'business_accounts'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) LIKE '%COIN_SELLER%'
  LOOP
    EXECUTE format('ALTER TABLE business_accounts DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION business_parent_is_bd() RETURNS trigger AS $$
DECLARE
  parent_kind business_account_kind;
BEGIN
  IF NEW.parent_id IS NULL THEN
    IF NEW.kind = 'BD_MANAGER' THEN RETURN NEW; END IF;
    -- BD agents may sit directly under the platform only until a manager exists; §21's
    -- "multiple BD managers" switch is what decides whether a territory has one.
    RETURN NEW;
  END IF;

  SELECT kind INTO parent_kind FROM business_accounts WHERE id = NEW.parent_id;
  IF parent_kind IS NULL THEN
    RAISE EXCEPTION 'business account % has no parent %', NEW.code, NEW.parent_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF parent_kind = 'COIN_SELLER' THEN
    RAISE EXCEPTION 'a coin seller (% ) cannot own another business account', parent_kind
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.kind = 'COIN_SELLER' THEN
    IF parent_kind NOT IN ('BD_MANAGER','BD_AGENT') THEN
      RAISE EXCEPTION 'coin sellers report to a BD account, not to %', NEW.kind
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.kind = 'BD_AGENT' THEN
    IF parent_kind <> 'BD_MANAGER' THEN
      RAISE EXCEPTION 'a BD agent reports to a BD manager, not to %', parent_kind
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'a BD manager has no parent account'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS business_accounts_parent_kind ON business_accounts;
CREATE TRIGGER business_accounts_parent_kind
  BEFORE INSERT OR UPDATE OF parent_id, kind ON business_accounts
  FOR EACH ROW EXECUTE FUNCTION business_parent_is_bd();
