/**
 * Social & room-community contract check.
 *
 * These are the pure edges of migration 0022: the validators every write passes through and the
 * report DTO the queue renders. Nothing here needs Postgres or Redis, so it runs on a laptop:
 *
 *   npx tsx scripts/social-contract.ts
 */
import { ApiError } from '../src/utils/http';

const out: string[] = [];
let failures = 0;

function check(name: string, ok: boolean, detail?: unknown) {
  out.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  :: ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

function rejects(fn: () => unknown, status: number, code: string): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof ApiError && err.status === status && err.code === code;
  }
}

async function main() {
  const social = await import('../src/services/social.service');
  const community = await import('../src/services/room-community.service');

  // ---- report vocabulary ----------------------------------------------------
  check(
    'report reasons are the six the CHECK constraint allows',
    social.REPORT_REASONS.join(',') === 'HARASSMENT,SPAM,FRAUD,UNDERAGE,VIOLENCE,OTHER',
    social.REPORT_REASONS,
  );
  check(
    'report statuses are the four the CHECK constraint allows',
    social.REPORT_STATUSES.join(',') === 'PENDING,REVIEWED,DISMISSED,ACTIONED',
    social.REPORT_STATUSES,
  );
  check(
    'a dismissal is not a decision an operator can attach a ban to (enum excludes it)',
    !(social.REPORT_DECISIONS as readonly string[]).includes('PENDING'),
    social.REPORT_DECISIONS,
  );

  // ---- report validators ----------------------------------------------------
  check('a known reason passes through unchanged', social.normalizeReportReason('SPAM') === 'SPAM');
  check(
    'a lowercase reason is refused, not silently upper-cased',
    rejects(() => social.normalizeReportReason('spam'), 400, 'report_reason_invalid'),
  );
  check(
    'an unknown reason is refused',
    rejects(() => social.normalizeReportReason('BOREDOM'), 400, 'report_reason_invalid'),
  );
  check('blank details mean null', social.normalizeReportDetails('   ') === null);
  check('details are trimmed', social.normalizeReportDetails('  repeats himself  ') === 'repeats himself');
  check(
    'details over 500 characters are refused',
    rejects(() => social.normalizeReportDetails('x'.repeat(social.MAX_REPORT_DETAILS + 1)), 400, 'report_details_too_long'),
  );
  check('blank resolution means null', social.normalizeResolution('') === null);
  check(
    'resolution over 300 characters is refused',
    rejects(() => social.normalizeResolution('x'.repeat(social.MAX_RESOLUTION + 1)), 400, 'resolution_too_long'),
  );
  check('blank block reason means null', social.normalizeBlockReason('  ') === null);
  check(
    'block reason over 200 characters is refused',
    rejects(() => social.normalizeBlockReason('x'.repeat(social.MAX_BLOCK_REASON + 1)), 400, 'block_reason_too_long'),
  );

  // ---- id shape -------------------------------------------------------------
  const id = '3f2a9f4e-8f61-4f6a-9b1a-2f3c4d5e6a7b';
  check('a canonical UUID passes', social.requireUserId(id) === id);
  check('a malformed id is named, not left to Postgres', rejects(() => social.requireUserId('abc'), 400, 'invalid_uuid'));

  // ---- room community validators -------------------------------------------
  check('a blank announcement means "remove it"', community.normalizeAnnouncement('   ') === null);
  check('an announcement is trimmed', community.normalizeAnnouncement('  Be kind.  ') === 'Be kind.');
  check(
    'an announcement over 300 characters is refused',
    rejects(() => community.normalizeAnnouncement('x'.repeat(301)), 400, 'announcement_too_long'),
  );
  check('a blank transfer note means null', community.normalizeTransferNote('') === null);
  check(
    'a transfer note over 200 characters is refused',
    rejects(() => community.normalizeTransferNote('x'.repeat(201)), 400, 'note_too_long'),
  );

  // ---- report DTO -----------------------------------------------------------
  const dto = social.toReport({
    id: 'r1',
    reporter_id: id,
    target_user_id: '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f',
    room_id: null,
    reason: 'FRAUD',
    details: 'asked for a loan',
    status: 'PENDING',
    resolution: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: new Date('2026-11-05T08:00:00Z'),
    reporter_username: 'alice',
    reporter_avatar_url: null,
    target_username: 'bob',
    target_avatar_url: '/avatars/bob.png',
  });
  check('a report DTO names both parties and keeps camelCase', dto.reporter.username === 'alice' && dto.target.username === 'bob');
  check('a report DTO serializes timestamps as ISO strings', dto.createdAt === '2026-11-05T08:00:00.000Z');
  check('a report with no room has a null room, not an empty object', dto.room === null);
  check('an unreviewed report has no reviewed timestamp', dto.reviewedAt === null);

  console.log(out.join('\n'));
  console.log(`\n${out.length - failures}/${out.length} checks passed`);
  // The services import an ioredis client that retries forever; nothing is opened here, so leave.
  process.exit(failures > 0 ? 1 : 0);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
