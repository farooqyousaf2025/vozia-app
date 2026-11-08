import { one } from '../config/db';

/**
 * The finance team's daily cross-check (§25).
 *
 * Every service that moves value writes to two books: the coin ledger answers "whose balance
 * moved", the journal answers "what did the platform collect and whom does it still owe". A
 * number that is right in one book and wrong in the other is exactly the mistake an audit
 * finds months later, so this module does not trust either service. It re-derives the
 * relationship between them straight from the tables and reports every breach it finds.
 *
 * The checks are deliberately written as counts of offending rows rather than sums: a report
 * that says "0" is a claim that can be falsified by one query, whereas "the totals differ by
 * 3 cents" invites somebody to explain the 3 away.
 */

export type ReconciliationDomain = 'journal' | 'recharge' | 'commission' | 'revenue' | 'games' | 'promo' | 'earning';

export type ReconciliationCheck = {
  key: string;
  domain: ReconciliationDomain;
  label: string;
  /** What the check counts, so the panel can say "1 row" instead of "1". */
  unit: string;
  expected: string;
  breaches: number;
  passed: boolean;
};

export type ReconciliationReport = {
  generatedAt: string;
  range: { from: string | null; to: string | null };
  checks: ReconciliationCheck[];
  passed: number;
  breached: number;
};

type CheckDefinition = {
  key: string;
  domain: ReconciliationDomain;
  label: string;
  unit: string;
  expected: string;
  /**
   * A scalar SELECT. A check that narrows by time reads `$1`/`$2`, which the report binds to the
   * window; a check of a present-state invariant names neither and is run with no parameters at all
   * (see `reconciliationReport`) — Postgres refuses a bind whose values outnumber the placeholders.
   */
  sql: string;
};

const CHECKS: CheckDefinition[] = [
  {
    key: 'journal.entries_balanced',
    domain: 'journal',
    label: 'Every journal entry has equal debits and credits',
    unit: 'unbalanced entries',
    expected: '0',
    sql: `
      select count(*) from (
        select e.id,
               coalesce(sum(l.amount_cents) filter (where l.direction = 'DEBIT'), 0)  as d,
               coalesce(sum(l.amount_cents) filter (where l.direction = 'CREDIT'), 0) as c
          from fin_journal_entries e
          join fin_journal_lines l on l.entry_id = e.id
         where (coalesce(e.occurred_at, '-infinity'::timestamptz) >= coalesce($1, '-infinity'::timestamptz))
           and (coalesce(e.occurred_at, 'infinity'::timestamptz) <= coalesce($2, 'infinity'::timestamptz))
         group by e.id
      ) x where x.d <> x.c`,
  },
  {
    key: 'journal.trial_balance',
    domain: 'journal',
    label: 'The book as a whole sums to zero (trial balance)',
    unit: 'cents out of balance',
    expected: '0',
    sql: `
      select coalesce(sum(l.amount_cents) filter (where l.direction = 'DEBIT'), 0)
           - coalesce(sum(l.amount_cents) filter (where l.direction = 'CREDIT'), 0)
        from fin_journal_lines l
        join fin_journal_entries e on e.id = l.entry_id
       where (coalesce(e.occurred_at, '-infinity'::timestamptz) >= coalesce($1, '-infinity'::timestamptz))
         and (coalesce(e.occurred_at, 'infinity'::timestamptz) <= coalesce($2, 'infinity'::timestamptz))`,
  },
  {
    key: 'journal.source_rows_exist',
    domain: 'journal',
    label: 'Every posting names a recharge order that still exists',
    unit: 'orphan postings',
    expected: '0',
    sql: `
      select count(*)
        from fin_journal_entries e
       where e.source_kind = 'RECHARGE_ORDER'
         and (coalesce(e.occurred_at, '-infinity'::timestamptz) >= coalesce($1, '-infinity'::timestamptz))
         and (coalesce(e.occurred_at, 'infinity'::timestamptz) <= coalesce($2, 'infinity'::timestamptz))
         and not exists (select 1 from recharge_orders o where o.id::text = e.source_id)`,
  },
  {
    key: 'recharge.credited_has_journal',
    domain: 'recharge',
    label: 'Each credited order booked its own collection against the coin liability',
    unit: 'orders with no posting',
    expected: '0',
    sql: `
      select count(*)
        from recharge_orders o
       where o.status = 'CREDITED'
         and (o.created_at >= coalesce($1, o.created_at)) and (o.created_at <= coalesce($2, o.created_at))
         and not exists (
           select 1
             from fin_journal_entries e
             join fin_journal_lines l on l.entry_id = e.id
            where e.source_kind = 'RECHARGE_ORDER'
              and e.source_id = o.id::text
              and l.account_code = 'COIN_LIABILITY'
              and l.direction = 'CREDIT'
              and l.amount_cents = o.amount_cents)`,
  },
  {
    key: 'recharge.credited_has_ledger',
    domain: 'recharge',
    label: 'Each credited order moved the customer’s coins in the ledger',
    unit: 'orders with no ledger row',
    expected: '0',
    sql: `
      select count(*)
        from recharge_orders o
       where o.status = 'CREDITED'
         and (o.created_at >= coalesce($1, o.created_at)) and (o.created_at <= coalesce($2, o.created_at))
         and not exists (
           select 1 from transactions t
            where t.meta->>'rechargeOrderId' = o.id::text
              and (t.created_at >= coalesce($1, t.created_at)) and (t.created_at <= coalesce($2, t.created_at)))`,
  },
  {
    key: 'recharge.issued_has_journal',
    domain: 'recharge',
    label: 'Every payment that minted coins booked the liability it created',
    unit: 'payments with no posting',
    expected: '0',
    // The gap this closes was specific: `settlePaymentOnClient` is the primitive both the Stripe webhook
    // and the seller flow call, and only the seller flow went on to post. So the check accepts either
    // posting shape — the generic entry keyed on the proof, or the order's own fee-split entry reached
    // through the transaction they share — but requires the credited cents to equal what was collected.
    sql: `
      select count(*)
        from payment_proofs p
       where p.amount_cents > 0
         and (p.created_at >= coalesce($1, p.created_at)) and (p.created_at <= coalesce($2, p.created_at))
         and not exists (
           select 1
             from fin_journal_entries e
             join fin_journal_lines l on l.entry_id = e.id
            where e.source_kind = 'COIN_ISSUANCE'
              and e.source_id = p.id::text
              and l.account_code = 'COIN_LIABILITY'
              and l.direction = 'CREDIT'
              and l.amount_cents = p.amount_cents)
         and not exists (
           select 1
             from recharge_orders o
             join fin_journal_entries e2 on e2.source_kind = 'RECHARGE_ORDER' and e2.source_id = o.id::text
             join fin_journal_lines l2 on l2.entry_id = e2.id
            where o.transaction_id = p.transaction_id
              and l2.account_code = 'COIN_LIABILITY'
              and l2.direction = 'CREDIT'
              and l2.amount_cents = p.amount_cents)`,
  },
  {
    key: 'journal.issuance_source_rows_exist',
    domain: 'journal',
    label: 'Every issuance posting names a payment proof that still exists',
    unit: 'orphan postings',
    expected: '0',
    sql: `
      select count(*)
        from fin_journal_entries e
       where e.source_kind = 'COIN_ISSUANCE'
         and (coalesce(e.occurred_at, '-infinity'::timestamptz) >= coalesce($1, '-infinity'::timestamptz))
         and (coalesce(e.occurred_at, 'infinity'::timestamptz) <= coalesce($2, 'infinity'::timestamptz))
         and not exists (select 1 from payment_proofs p where p.id::text = e.source_id)`,
  },
  {
    key: 'recharge.reversed_commission_reversed',
    domain: 'recharge',
    label: 'A reversed order took its partners’ accruals with it',
    unit: 'reversed orders still accruing',
    expected: '0',
    sql: `
      select count(*)
        from recharge_orders o
       where o.status = 'REVERSED'
         and (o.created_at >= coalesce($1, o.created_at)) and (o.created_at <= coalesce($2, o.created_at))
         and exists (
           select 1 from commission_entries e
            where e.recharge_order_id = o.id and e.status = 'ACCRUED')`,
  },
  {
    key: 'commission.within_collection',
    domain: 'commission',
    label: 'No order ever owed a partner more than the platform collected from it',
    unit: 'over-commissioned orders',
    expected: '0',
    sql: `
      select count(*) from (
        select o.id,
               o.amount_cents - o.fee_cents as net,
               coalesce(sum(e.amount_cents), 0) as owed
          from recharge_orders o
          left join commission_entries e on e.recharge_order_id = o.id and e.status = 'ACCRUED'
         where o.status in ('CREDITED', 'REVERSED')
           and (o.created_at >= coalesce($1, o.created_at)) and (o.created_at <= coalesce($2, o.created_at))
         group by o.id, o.amount_cents, o.fee_cents
      ) x where x.owed > x.net`,
  },
  {
    key: 'commission.no_duplicates',
    domain: 'commission',
    label: 'One accrual per order, partner and commission kind',
    unit: 'duplicated accruals',
    expected: '0',
    sql: `
      select count(*) from (
        select e.recharge_order_id, e.beneficiary_id, e.kind, count(*) as n
          from commission_entries e
         where e.status = 'ACCRUED'
           and e.recharge_order_id is not null
           and e.beneficiary_id is not null
           and (e.created_at >= coalesce($1, e.created_at)) and (e.created_at <= coalesce($2, e.created_at))
         group by e.recharge_order_id, e.beneficiary_id, e.kind
         having count(*) > 1
      ) x`,
  },
  {
    key: 'commission.settlement_matches_entries',
    domain: 'commission',
    label: 'Each settlement batch pays exactly the accruals in its period',
    unit: 'batches that do not add up',
    expected: '0',
    sql: `
      select count(*)
        from commission_settlements s
       where (s.created_at >= coalesce($1, s.created_at)) and (s.created_at <= coalesce($2, s.created_at))
         and s.amount_cents <> (
           select coalesce(sum(e.amount_cents), 0)
             from commission_entries e
            where e.beneficiary_id = s.beneficiary_id
              and e.settled_at is not null
              and e.settled_at >= s.period_from
              and e.settled_at <= s.period_to)`,
  },
  {
    key: 'revenue.face_value_not_revenue',
    domain: 'revenue',
    label: 'Coin face value was never booked as recognised platform revenue',
    unit: 'cents wrongly recognised',
    expected: '0',
    sql: `
      select coalesce(sum(l.amount_cents), 0)
        from fin_journal_lines l
        join fin_journal_entries e on e.id = l.entry_id
       where l.account_code = 'PLATFORM_REVENUE'
         and e.source_kind = 'RECHARGE_ORDER'
         and (coalesce(e.occurred_at, '-infinity'::timestamptz) >= coalesce($1, '-infinity'::timestamptz))
         and (coalesce(e.occurred_at, 'infinity'::timestamptz) <= coalesce($2, 'infinity'::timestamptz))`,
  },
  {
    key: 'games.pool_explained',
    domain: 'games',
    label: 'Every settled prize pool is the entry pool less the platform cut',
    unit: 'unexplained pools',
    expected: '0',
    sql: `
      select count(*)
        from game_settlements s
        join game_sessions g on g.id = s.session_id
       where s.status = 'SETTLED'
         and (g.created_at >= coalesce($1, g.created_at)) and (g.created_at <= coalesce($2, g.created_at))
         and s.gross_pool <> s.commission + s.prize_pool`,
  },
  {
    key: 'games.prize_ledger_matches',
    domain: 'games',
    label: 'The coins paid out in the ledger equal what the settlement distributed',
    unit: 'settlements that disagree',
    expected: '0',
    sql: `
      select count(*)
        from game_settlements s
        join game_sessions g on g.id = s.session_id
       where s.status = 'SETTLED'
         and (g.created_at >= coalesce($1, g.created_at)) and (g.created_at <= coalesce($2, g.created_at))
         and s.distributed <> (
           select coalesce(sum(t.amount_diamonds), 0)
             from transactions t
            where t.type = 'GAME_PRIZE' and t.game_session_id = s.session_id)`,
  },
  {
    key: 'games.settled_once',
    domain: 'games',
    label: 'A match settles at most once',
    unit: 'sessions with two settlements',
    expected: '0',
    sql: `
      select count(*) from (
        select s.session_id
          from game_settlements s
          join game_sessions g on g.id = s.session_id
         where (g.created_at >= coalesce($1, g.created_at)) and (g.created_at <= coalesce($2, g.created_at))
         group by s.session_id
         having count(*) > 1
      ) x`,
  },
  {
    key: 'games.prize_without_settlement',
    domain: 'games',
    label: 'No prize row exists without the settlement that authorised it',
    unit: 'orphan prize rows',
    expected: '0',
    sql: `
      select count(*)
        from transactions t
       where t.type = 'GAME_PRIZE'
         and (t.created_at >= coalesce($1, t.created_at)) and (t.created_at <= coalesce($2, t.created_at))
         and not exists (select 1 from game_settlements s where s.session_id = t.game_session_id)`,
  },
  {
    key: 'games.entry_without_seat',
    domain: 'games',
    label: 'Every entry fee and refund belongs to a player actually seated in the match',
    unit: 'orphan entry rows',
    expected: '0',
    sql: `
      select count(*)
        from transactions t
       where t.type in ('GAME_ENTRY', 'GAME_REFUND')
         and (t.created_at >= coalesce($1, t.created_at)) and (t.created_at <= coalesce($2, t.created_at))
         and not exists (
           select 1 from game_participants p
            where p.session_id = t.game_session_id
              and p.user_id = coalesce(t.sender_id, t.receiver_id))`,
  },
  {
    key: 'games.dispute_pays_nothing',
    domain: 'games',
    label: 'A match under dispute distributed no prize',
    unit: 'disputed settlements that paid',
    expected: '0',
    sql: `
      select count(*)
        from game_settlements s
        join game_sessions g on g.id = s.session_id
       where s.status = 'DISPUTED'
         and (g.created_at >= coalesce($1, g.created_at)) and (g.created_at <= coalesce($2, g.created_at))
         and s.distributed > 0`,
  },
  {
    key: 'promo.every_grant_booked',
    domain: 'promo',
    label: 'Every bonus coin minted by a grant was booked against the coin liability',
    unit: 'grants with no posting',
    expected: '0',
    // The same hole 0034 closed for recharges, in the one place the platform hands out coins it never
    // sold. A grant made while `minorPerCoin` is unset mints no platform value, so it has nothing to
    // post — the second predicate skips exactly those, the way `grantPromoDiamonds` does.
    sql: `
      select count(*)
        from promo_grants g
       where (g.created_at >= coalesce($1, g.created_at)) and (g.created_at <= coalesce($2, g.created_at))
         and coalesce((select (c.value->>'minorPerCoin')::int from system_config c where c.key = 'accounts.coinValue'), 0) > 0
         and not exists (
           select 1
             from fin_journal_entries e
             join fin_journal_lines l on l.entry_id = e.id
            where e.source_kind = 'PROMO_GRANT'
              and e.source_id = g.id::text
              and l.account_code = 'PROMOTIONAL:PLATFORM'
              and l.direction = 'DEBIT')`,
  },
  {
    key: 'promo.cached_balance_matches_grants',
    domain: 'promo',
    label: 'The bonus balance a wallet shows is the sum of the grants behind it',
    unit: 'accounts out of step',
    expected: '0',
    // `users.promo_diamond_balance` is a cache; `promo_grants.remaining` is the truth, because that is
    // what expires. If they drift, a member is shown coins they cannot spend or denied coins they can.
    sql: `
      select count(*)
        from users u
       where u.promo_diamond_balance <> coalesce(
               (select sum(g.remaining) from promo_grants g where g.user_id = u.id and g.status = 'ACTIVE'), 0)`,
  },
  {
    key: 'promo.spend_within_purchase',
    domain: 'promo',
    label: 'No purchase drew more bonus diamonds from a grant than it cost',
    unit: 'over-claimed spends',
    expected: '0',
    sql: `
      select count(*) from (
        select s.transaction_id, sum(s.diamonds) as from_grants, t.amount_diamonds as cost
          from promo_grant_spends s
          join transactions t on t.id = s.transaction_id
         where (t.created_at >= coalesce($1, t.created_at)) and (t.created_at <= coalesce($2, t.created_at))
         group by s.transaction_id, t.amount_diamonds
      ) x where x.from_grants > x.cost`,
  },
  {
    key: 'earning.paid_attempt_has_a_payout',
    domain: 'earning',
    label: 'Every attempt the engine called PAID also wrote its payout row',
    unit: 'paid attempts with no payout',
    expected: '0',
    // The claim and the mint are one UPDATE and one INSERT inside one transaction, so a PAID attempt
    // with nothing beside it is not a lag — it is a reward a member was told they got and never got.
    // `UNIQUE (activity_id)` on the payout already refuses a second one; nothing refuses zero.
    sql: `
      select count(*)
        from earning_activities a
       where a.status = 'PAID'
         and (a.paid_at >= coalesce($1, a.paid_at)) and (a.paid_at <= coalesce($2, a.paid_at))
         and not exists (select 1 from earning_payouts p where p.activity_id = a.id)`,
  },
  {
    key: 'earning.payout_belongs_to_a_paid_attempt',
    domain: 'earning',
    label: 'No payout stands on an attempt that was never paid',
    unit: 'payouts on unpaid attempts',
    expected: '0',
    sql: `
      select count(*)
        from earning_payouts p
        join earning_activities a on a.id = p.activity_id
       where (p.created_at >= coalesce($1, p.created_at)) and (p.created_at <= coalesce($2, p.created_at))
         and (a.status <> 'PAID' or a.paid_at is null)`,
  },
  {
    key: 'earning.payout_is_the_grant_it_names',
    domain: 'earning',
    label: 'A bonus-diamond payout minted exactly its own grant, and an XP payout minted none',
    unit: 'payouts not matched by their mint',
    expected: '0',
    // The dedupe the engine leans on is `promo_grants (source_kind, source_id)`, keyed on the attempt.
    // If the grant beside a payout belongs to a different account, a different source, or is a different
    // size, then either a reward was minted twice or the balance a member sees cannot be traced back to
    // the rule that promised it.
    sql: `
      select count(*)
        from earning_payouts p
        left join promo_grants g on g.id = p.promo_grant_id
       where (p.created_at >= coalesce($1, p.created_at)) and (p.created_at <= coalesce($2, p.created_at))
         and (
                (p.currency = 'BONUS_DIAMOND'
                  and (g.id is null
                       or g.amount <> p.amount
                       or g.user_id <> p.user_id
                       or g.source_kind <> p.purpose
                       or g.source_id <> p.activity_id::text))
             or (p.currency = 'XP' and p.promo_grant_id is not null)
         )`,
  },
  {
    key: 'earning.payout_keeps_its_promise',
    domain: 'earning',
    label: 'Every payout repeats the account, rule, bucket, occurrence and amount its attempt promised',
    unit: 'payouts that drifted from the attempt',
    expected: '0',
    // §10 asks for the rule version and the snapshot to travel with the money. The attempt is the
    // promise read off the rule at the moment it was met; the payout is the receipt. Any column where
    // they disagree — including the campaign, which is whose budget was charged — is a receipt for a
    // different reward.
    sql: `
      select count(*)
        from earning_payouts p
        join earning_activities a on a.id = p.activity_id
       where (p.created_at >= coalesce($1, p.created_at)) and (p.created_at <= coalesce($2, p.created_at))
         and (   p.user_id <> a.user_id
              or p.rule_id <> a.rule_id
              or p.rule_version <> a.rule_version
              or p.bucket <> a.bucket
              or p.occurrence <> a.occurrence
              or p.currency <> a.reward_currency
              or p.amount <> a.reward_amount
              or coalesce(p.campaign_id::text, '') <> coalesce(a.campaign_id::text, ''))`,
  },
  {
    key: 'earning.payout_snapshot_is_readable',
    domain: 'earning',
    label: 'Every payout still resolves to the rule version it was paid under',
    unit: 'payouts with no matching rule snapshot',
    expected: '0',
    // A rule edit writes a new version rather than overwriting, so the row that priced a reward is
    // supposed to be readable forever. A payout that joins nothing is a payment no support answer,
    // and no appeal, can explain. Deliberately unwindowed: the snapshot either exists or does not,
    // and a date filter would only hide the rows that matter.
    sql: `
      select count(*)
        from earning_payouts p
       where not exists (
         select 1 from earning_rules r
          where r.id = p.rule_id and r.rule_version = p.rule_version)`,
  },
  {
    key: 'earning.campaign_budget_holds',
    domain: 'earning',
    label: 'No campaign minted more bonus diamonds than its budget',
    unit: 'over-budget campaigns',
    expected: '0',
    // The engine checks this before it pays, so a breach here means two paths paid concurrently past
    // the cap — the failure the `FOR UPDATE` on the campaign row exists to prevent. Read as a lifetime
    // total against a lifetime cap: a windowed sum would compare this week's spending to the whole
    // budget and pass a campaign that had already blown it.
    sql: `
      select count(*) from (
        select p.campaign_id, c.budget_diamonds, sum(p.amount) as paid
          from earning_payouts p
          join earning_campaigns c on c.id = p.campaign_id
         where p.currency = 'BONUS_DIAMOND' and c.budget_diamonds is not null
         group by p.campaign_id, c.budget_diamonds
      ) x where x.paid > x.budget_diamonds`,
  },
];

export async function reconciliationReport(from?: Date, to?: Date): Promise<ReconciliationReport> {
  const window = [from ?? null, to ?? null];
  const checks: ReconciliationCheck[] = [];

  for (const definition of CHECKS) {
    // A present-state invariant — a cache out of step with the rows it caches is out of step now,
    // whatever period the operator asked about — names no window in its SQL. Binding the dates to it
    // anyway would fail the query, so the parameters follow the statement.
    const params = definition.sql.includes('$1') ? window : [];
    const row = await one<{ n: string | number }>(`select (${definition.sql}) as n`, params);
    const breaches = Number(row?.n ?? 0);
    checks.push({
      key: definition.key,
      domain: definition.domain,
      label: definition.label,
      unit: definition.unit,
      expected: definition.expected,
      breaches,
      passed: breaches === 0,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    range: { from: from ? from.toISOString() : null, to: to ? to.toISOString() : null },
    checks,
    passed: checks.filter((c) => c.passed).length,
    breached: checks.filter((c) => !c.passed).length,
  };
}

/** Same rows, as the CSV the finance team files. */
export function reconciliationCsv(report: ReconciliationReport): string {
  const escape = (value: string): string => `"${value.replace(/"/g, '""')}"`;
  const header = ['domain', 'check', 'unit', 'expected', 'found', 'status'];
  const lines = report.checks.map((check) =>
    [check.domain, check.label, check.unit, check.expected, String(check.breaches), check.passed ? 'OK' : 'BREACH']
      .map(escape)
      .join(','),
  );
  return [`reconciliation range,${escape(`${report.range.from ?? 'all'} .. ${report.range.to ?? 'now'}`)}`, header.map(escape).join(','), ...lines].join('\n');
}
