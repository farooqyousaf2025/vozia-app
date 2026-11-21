/* Public API smoke checks for the live room / host / agency discovery rankings.
   Runs after the CI API has started. It performs reads only: no accounts, wallets or ledger writes. */
const API = process.env.E2E_API_URL || 'http://127.0.0.1:4000';

async function get(path) {
  const response = await fetch(API + path, { signal: AbortSignal.timeout(15_000) });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

(async () => {
  let checks = 0;
  const assert = (condition, label, detail) => {
    if (!condition) throw new Error(`FAIL ${label}: ${JSON.stringify(detail)}`);
    checks += 1;
    console.log(`PASS ${label}`);
  };

  for (const kind of ['rooms', 'hosts', 'agencies']) {
    const result = await get(`/api/rankings/discovery?kind=${kind}&limit=10`);
    assert(result.status === 200 && result.body?.kind === kind && Array.isArray(result.body?.leaders),
      `${kind} board responds with its expected shape`, result);
    const leaders = result.body.leaders;
    assert(leaders.every((row, index) =>
      row.position === index + 1 && Number.isFinite(Number(row.score)) &&
      (index === 0 || Number(leaders[index - 1].score) >= Number(row.score))),
      `${kind} positions and quality scores are ordered`, leaders);
    const serialized = JSON.stringify(result.body);
    assert(!serialized.includes('qa_ref') && !serialized.includes('is_test'),
      `${kind} board does not expose QA internals`);
  }

  const regional = await get('/api/rankings/discovery?kind=rooms&region=PK&limit=5');
  assert(regional.status === 200 && regional.body?.region === 'PK',
    'ISO country region filter is accepted', regional);
  const invalidRegion = await get('/api/rankings/discovery?kind=rooms&region=PAK');
  const invalidKind = await get('/api/rankings/discovery?kind=wallet');
  assert(invalidRegion.status === 400 && invalidKind.status === 400,
    'invalid region and board kind are rejected', { invalidRegion, invalidKind });

  console.log(`\n${checks}/11 live discovery checks passed.`);
})().catch((error) => {
  console.error('DISCOVERY RANKINGS SMOKE FAILED', error);
  process.exit(1);
});
