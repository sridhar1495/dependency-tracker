# Performance validation

Evidence for the requirements in [CLAUDE.md §13](../CLAUDE.md). Each one is a
measurement, not an assertion, and each is reproducible from this repository.

Everything below was captured against PostgreSQL 16 with the tuning flags from
`docker-compose.yml`, on a dataset of **5,000 accounts, 20,000 reports, 1,000
sessions, 2,500 configured DependencyTrack connections, 1,500 schedules across
500 accounts, and 18,000 scheduled runs**.

Schedules are seeded three to an account rather than one each: a user owns any
number of them (migration 009), and seeding one apiece would both misrepresent
the table and hide the shape the claim query actually meets.

Reproduce with:

```bash
createdb perfcheck
PERF_DATABASE_URL=postgres://dtdash:pw@localhost:5432/perfcheck node docs/perf-check.js
```

`docs/perf-check.js` seeds the dataset, runs `EXPLAIN (ANALYZE, BUFFERS)` on
every hot-path query and exits non-zero if any of them regresses. It reports a
sequential scan only when the scan is **rescanned per outer row** or **filters
away more rows than it returns** — a scan that builds a hash table for a join is
the correct plan and is not a finding.

---

## 1. Query plans

| Query | Time | Buffers | Plan |
|---|---|---|---|
| `lib/auth.js` — resolve a bearer token | **0.028 ms** | 6 | Index Scan `ux_sessions_token` |
| `lib/users.js` — find an account at sign-in | **0.035 ms** | 3 | Index Scan `ux_users_login_id` (citext) |
| `lib/reports-db.js` — list one account's reports | **0.038 ms** | 6 | Index Scan `ix_reports_user_created` |
| `lib/reports-db.js` — per-user quota count | **0.035 ms** | 6 | Bitmap Index Scan on `reports (user_id)` |
| `lib/schedules.js` — claim one due schedule | **0.059 ms** | 5 | `ix_sched_due` + `ix_sched_running`, see §1.3 |
| `lib/schedules.js` — one account's schedules | **0.064 ms** | 14 | Bitmap Index Scan `ix_sched_user` |
| `lib/schedules.js` — schedule quota count | **0.021 ms** | 5 | Bitmap Index Scan `ix_sched_user` |
| `lib/schedules.js` — run statistics for one schedule | **0.037 ms** | 5 | Index Scan `ix_runs_schedule_time` |
| `lib/caches.js` — cache metadata by fingerprint | **0.014 ms** | 1 | see §1.1 |
| `lib/dt-connections.js` — resolve one connection | **0.015 ms** | 3 | Index Scan `dt_connections_pkey` |
| `lib/users.js` — administration listing (500 rows) | **12.1 ms** | 7,303 | see §1.2 |
| `lib/disk.js` — storage by account (top 5) | **25.7 ms** | 768 | aggregate over 20,000 reports |

Every per-request query is an index scan reading fewer than 15 pages. The two
double-digit figures both belong to the administration screen — a single page
view by a single operator, not a per-request path — and the storage aggregate is
additionally cached for 10 seconds so polling that screen cannot turn into load.

**The listing absorbed a new join for free.** Migration 005 added
`CROSS JOIN app_settings` and `LEFT JOIN user_settings` so the screen can show
each account's effective report limit and whether it was inherited or set.
`app_settings` is a singleton, so the planner materialises it once rather than
multiplying rows: 10.0 ms / 4,873 buffers before, 9.3 ms / 4,916 after — inside
run-to-run noise.

**Migration 009 cost it 3 ms, and had to.** Counting each account's schedules
went from reading one joined row to a `LEFT JOIN LATERAL` aggregate over the
table: 9.3 ms / 4,916 buffers to 12.1 ms / 7,303. That is the price of the
feature, and the alternative was not cheaper but wrong — a plain
`LEFT JOIN schedules ON user_id` repeats the entire user row once per schedule
and inflates every count on the screen. Still one page view by one operator,
not a per-request path.

### 1.1 The cache lookup shows a sequential scan, and that is correct

At 50 cache rows the planner chooses a sequential scan (`cost=0.00..1.62`,
0.012 ms, **one** buffer) because the whole table is one page and an index
descent would cost more. The index exists and is used as soon as the table is
large enough to matter — the same query at 20,050 rows:

```
Index Scan using violation_caches_pkey on violation_caches
  (cost=0.41..8.43 rows=1) (actual time=0.019..0.020 rows=1 loops=1)
  Index Cond: (fingerprint = '6dbf9ac2…'::text)
```

The number of cache rows tracks distinct DependencyTrack **connections**, not
users, so in practice this table stays small — which is the point (§3).

### 1.2 The administration listing was 337 ms and is now 10 ms

The first working version of `listWithStats()` ordered and limited at the top
level, so PostgreSQL evaluated both lateral subqueries for all 5,000 accounts
and discarded 4,500 of the results. The lateral over `user_sessions` had no
usable index and was re-scanned once per account:

```
->  Limit  (actual time=0.052..0.052 rows=0 loops=5000)
      ->  Seq Scan on user_sessions  (actual time=0.051..0.051 rows=0 loops=5000)
            Filter: ((revoked_at IS NULL) AND (user_id = u.id) AND (expires_at > now()))
            Rows Removed by Filter: 900
            Buffers: shared hit=76704
Execution Time: 326.807 ms
```

Two changes fixed it:

1. **Select the page of users before the laterals run.** `FROM (SELECT … FROM
   users ORDER BY created_at LIMIT $1) u` means the laterals execute 500 times
   instead of 5,000.
2. **Add `principal_type = 'user'` to the session lateral.** This is not a
   filter — it is what makes `ux_sessions_one_live_per_user` usable, since that
   index is partial on `(revoked_at IS NULL AND principal_type = 'user')`.
   Without the predicate the planner cannot prove the index covers the query.
   No row changes: an administrator session has `user_id NULL` and could never
   have matched `user_id = u.id`.

| | Time | Buffers |
|---|---|---|
| Before | 337 ms | 136,861 |
| After | **10 ms** | **4,873** |

**33× faster, 28× fewer pages read.** The remaining sequential scans in the plan
are hash-join builds against `dt_connections` and `schedules` with `loops=1`,
which is the right plan for joining a 500-row page against a 5,000-row table.

### 1.3 The claim's serialisation guard needed an index of its own

Migration 009 let a user own several schedules and gave `claimOne()` a
`NOT EXISTS` clause to keep only one of them running at a time. That clause is
correct, and it was executing as a **sequential scan of the whole `schedules`
table on every claim** — 1,503 rows read to establish that nothing was running.

The poller claims up to `SCHEDULER_CONCURRENCY` times a minute and a job refills
its own slot on completion, so that scan ran several times a minute and grew
with every schedule anybody added. Migration 010 added a partial index on
`(user_id) WHERE running_since IS NOT NULL`, which by construction contains only
what is running at that instant — a handful of rows however large the table is,
the same reasoning as `ix_sched_due`.

| | Plan for the guard | Buffers (claim) |
|---|---|---|
| Before | Seq Scan, 1,503 rows filtered | 42 |
| After | **Index Scan `ix_sched_running`** | **5** |

This is what CLAUDE.md §16's `EXPLAIN` requirement is for: nothing else would
have noticed, because the query was correct and fast enough to look fine at the
size it was first written against.

---

## 2. Load behaviour

Measured against the running service with a stub DependencyTrack that counts the
requests it receives.

### 2.1 Twenty users, one DependencyTrack connection, one crawl

Twenty accounts sharing one connection all opened the dashboard simultaneously:

```
✓ every user got building or ready, nobody an error
✓ exactly one cache row for 20 accounts
✓ exactly one crawl: 9 pipeline requests, not 180
✓ the burst settled in 177 ms
```

Nine requests is one full build — three risk types × three violation states. The
other nineteen callers lost the `pg_try_advisory_lock` election, were told
`building`, and read the winner's result. **Adding users does not multiply the
load placed on DependencyTrack.**

### 2.2 The scheduler pool has no idle capacity

The tick used to claim a batch and `await` all of it before claiming again, so
one slow report idled every other slot until it finished. Eight overdue
schedules across eight accounts, pool ceiling three:

```
✓ tick returned in 13 ms without waiting for the reports it started
✓ three claims visible in the database
✓ one report held its slot indefinitely while the other two cycled four more
✓ the pool stayed full throughout, and drained with no claim left behind
```

Under the batch design none of those four replacements could have started. The
sustained ceiling is `SCHEDULER_CONCURRENCY ÷ average report duration`; what
changed is that the service now reaches it instead of collapsing to the rate of
its slowest job.

**One account's schedules still run one at a time** — that is enforced in the
database by the `NOT EXISTS` clause above, not by the pool, so it survives a
restart and would survive a second replica.

### 2.3 Bounded concurrency

```
✓ backends never exceeded the pool max of 15   (peak = 15)
✓ well under the server max_connections of 50  (peak = 15)
```

Sampled from `pg_stat_activity` every 40 ms across the burst above.

### 2.4 The token cache removes the per-request database read

```
✓ 40 authenticated requests caused 0 reads of user_sessions
```

Measured as the change in `pg_stat_user_tables.idx_scan + seq_scan` for
`user_sessions`. The first request populated the cache; the next 39 hit it.

### 2.5 `last_seen_at` is throttled

```
✓ 40 requests inside the touch interval caused no session write
  (last_seen_at unchanged)
```

One write per minute per session, not one per request — the difference between
~1 write per request and ~1 per minute under load.

Measured by reading `user_sessions.last_seen_at` for the one session under test,
not `pg_stat_user_tables.n_tup_upd`. That counter is table-wide, so every other
session's `touch()` lands in it, and PostgreSQL flushes a backend's statistics
only about once a second — which puts a neighbouring phase's tail inside the
measurement window and reports writes that this phase did not cause. The column
value is exact and attributable to one session.

### 2.6 Report progress is throttled

Covered by the database tier (`db.test.js`): consecutive `writeProgress()` calls
inside one second return `false` without writing, and `{ force: true }` writes
regardless. The single-tenant implementation rewrote the whole JSON registry
after every project × risk type — roughly 1,500 writes for a 500-project report.

---

## 3. Growth characteristics

| Table | Grows with | Bounded by |
|---|---|---|
| `users`, `dt_connections`, `user_settings`, `mail_settings` | accounts | one row per account |
| `schedules` | **schedules, not accounts** | per-account `max_schedules`, enforced on creation |
| `schedule_projects` | projects selected per schedule | cascades when the schedule is cancelled |
| `app_settings` | nothing | exactly one row, enforced by a singleton primary key |
| `user_sessions` | live sessions | one per account (partial unique index) + a 10-minute sweeper |
| `reports`, `report_file_chunks` | reports | per-user `max_reports`, enforced on creation and on lowering the limit |
| `violation_caches` | **distinct DependencyTrack connections** | swept when no connection references the fingerprint |
| `login_audit` | sign-in attempts | 90-day retention |
| `schedule_runs` | scheduled runs | 90-day retention |

In the seeded dataset, **2,500 configured connections resolved to 50 cache
rows**, because the fingerprint is `sha256(url + key)` rather than a user id.

---

## 4. What is not measured here

- **Report generation throughput.** Dominated by DependencyTrack's own response
  times, not by anything in this service. Concurrency is bounded at
  `SCHEDULER_CONCURRENCY` (5) × `REPORT_CONCURRENCY` (5) upstream requests, and
  `VIOLATION_CONCURRENCY` (3) for cache builds.
- **Where DependencyTrack's knee is.** The number worth tuning is DT's, not this
  service's, and it belongs to whoever runs DT. Before raising
  `SCHEDULER_CONCURRENCY`, measure how late reports actually start
  (`started_at − next_run_at`); if that is under a minute there is nothing to
  gain, and past DT's limit the retries make it worse rather than better.
- **A real DependencyTrack instance.** Every measurement above uses a stub, by
  design: these are properties of this service, and a live DT would add variance
  without adding information. CLAUDE.md §10.5 forbids tests that need a live DT.
- **Multi-replica operation.** One replica is the supported topology. The
  scheduler's `FOR UPDATE SKIP LOCKED` and the cache's advisory lock are already
  correct across replicas; the in-process token cache is not, and would need
  `LISTEN/NOTIFY` invalidation. This is a known upgrade path, not a shipped one.
