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

export type ReconciliationDomain = 'journal' | 'recharge' | 'commission' | 'revenue' | 'games';

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
   * A scalar SELECT. `$1`/`$2` are always bound to the optional window so that every check
   * accepts the same two parameters, whether or not it narrows by time.
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
];

export async function reconciliationReport(from?: Date, to?: Date): Promise<ReconciliationReport> {
  const params = [from ?? null, to ?? null];
  const checks: ReconciliationCheck[] = [];

  for (const definition of CHECKS) {
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
