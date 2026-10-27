-- 0009_seller_limits.sql — the seller's limits become a database fact.
--
-- §22 makes per-seller transaction limits an administrator setting: a maximum order size, a
-- daily diamond ceiling and a daily order count. `createRechargeOrder` already refuses an order
-- that breaks them, but it reads "what has this seller opened today" and then inserts — two
-- requests that arrive together can both pass that read and both land, which is exactly how a
-- partner blows through a limit it was given.
--
-- So the same rule is stated where it cannot be raced: a BEFORE INSERT trigger that takes the
-- seller's row lock first. Concurrent order creation for one seller serializes on it, and the
-- second transaction sees the first one's rows.

CREATE OR REPLACE FUNCTION recharge_order_within_seller_limits() RETURNS trigger AS $$
DECLARE
  seller        business_accounts%ROWTYPE;
  used_orders   BIGINT;
  used_diamonds BIGINT;
BEGIN
  -- The lock is the point: without it the two counts below are a snapshot of a future that
  -- another transaction may already be changing.
  SELECT * INTO seller FROM business_accounts WHERE id = NEW.seller_id FOR UPDATE;

  IF NEW.diamonds > seller.max_order_diamonds THEN
    RAISE EXCEPTION 'seller_order_diamond_limit'
      USING ERRCODE = 'check_violation',
            HINT = format('Order of %s diamonds exceeds the per-order limit of %s', NEW.diamonds, seller.max_order_diamonds);
  END IF;

  SELECT COUNT(*), COALESCE(SUM(o.diamonds), 0)
    INTO used_orders, used_diamonds
    FROM recharge_orders o
   WHERE o.seller_id = NEW.seller_id
     AND o.created_at >= date_trunc('day', now())
     AND o.status NOT IN ('CANCELLED', 'EXPIRED', 'REJECTED');

  -- Counted before this row is inserted, so the limit means "no more than N open orders".
  IF used_orders >= seller.daily_order_limit THEN
    RAISE EXCEPTION 'seller_daily_order_limit'
      USING ERRCODE = 'check_violation',
            HINT = format('%s orders today against a daily limit of %s', used_orders, seller.daily_order_limit);
  END IF;

  IF used_diamonds + NEW.diamonds > seller.daily_diamond_limit THEN
    RAISE EXCEPTION 'seller_daily_diamond_limit'
      USING ERRCODE = 'check_violation',
            HINT = format('%s diamonds today against a daily limit of %s', used_diamonds + NEW.diamonds, seller.daily_diamond_limit);
  END IF;

  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recharge_order_seller_limits ON recharge_orders;
CREATE TRIGGER recharge_order_seller_limits BEFORE INSERT ON recharge_orders
  FOR EACH ROW EXECUTE FUNCTION recharge_order_within_seller_limits();
