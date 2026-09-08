# End-to-end regression suite

The fifth test tier (CLAUDE.md §10.2). The other four test units, routes with a
stubbed data layer, the installer, and the schema. This one drives the
**assembled product**: the real `server.js` as a child process, a real
PostgreSQL, the real dashboard pages behind an nginx-equivalent, and stubs for
the only two genuinely external things — DependencyTrack and SMTP.

Run it before a release, after any change that crosses a layer, and — once it is
wired up — on every pull request.

---

## Running it

```bash
cd violation-cache

# Without a database it skips, loudly and per suite. This is not a pass.
node --test e2e.test.js

# The real thing.
TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/dtdash_e2e \
  node --test e2e.test.js
```

> **It destroys the contents of that database.** The suite drops and recreates
> the `public` schema so every run starts from a fresh install — the same
> contract `db.test.js` already has. Point it at a throwaway database, never at
> anything you care about.

A full run takes about **50 seconds**, browser tier included.

### The browser tier

The browser tests are opt-in on whether Playwright can be resolved. CLAUDE.md §3
caps the dependency list at three packages, so it cannot be a fourth — it is
found at run time instead, and if it is missing that one suite skips while
everything else still runs.

Any of these is enough:

```bash
npm install -g playwright && npx playwright install chromium   # global install
PLAYWRIGHT_PATH=/path/to/playwright node --test e2e.test.js    # explicit path
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome                       # pin the binary
```

Nothing is added to `package.json` by any of these, which is the point.

---

## What is here

| File | Role |
|---|---|
| `stack.js` | Brings the whole thing up and takes it down. Resets the schema, writes the administrator credentials file, starts the stubs and the proxy, spawns `server.js`, waits for `/healthz`. |
| `dt-stub.js` | DependencyTrack. Mirrors the upstream's **routing**, not just its payloads. |
| `smtp-stub.js` | SMTP. Records the **envelope**, so a test can assert on `RCPT TO`. |
| `web-proxy.js` | nginx-equivalent: same-origin pages and API, with `try_files` fallback. |
| `client.js` | Request helpers, a SQL reader, and the Playwright resolver. |
| `../e2e.test.js` | The suite itself. |

### Three decisions worth knowing before you edit this

**`server.js` runs as a child process; everything else runs in-process.**
CLAUDE.md §10.4 forbids importing `server.js` — it would start an HTTP server
inside the test runner — and a child process is what the container does anyway,
boot sequence and all. The stubs and the proxy are a few dozen lines each, so
spawning them would buy nothing and cost port files, orphan processes and a
class of flakiness with no upside.

**Ports are assigned by the OS, never hard-coded.** A run cannot collide with a
developer's running stack or with a parallel CI job.

**The stubs mirror behaviour, not just shape.** `dt-stub.js` serves
`/api/version` unauthenticated and *outside* `/api/v1`, and 404s an unknown
path, because that is where this product has been caught out before: a stub that
answers whatever it is asked let a connection test pass against an endpoint that
does not exist upstream (§6.2). `smtp-stub.js` records the SMTP envelope rather
than the object the application built, because asserting on `sendMail` options
proves a list was assembled while asserting on `RCPT TO` proves the message is
addressed to those people — which is the only way "copy nobody" is meaningfully
tested.

---

## What belongs in this tier

A test earns its place here only if it needs the pieces **joined up**.

- "Does the merge produce the right recipient list" → `server.test.js`.
- "Do those addresses reach `RCPT TO`" → here.
- "Does `trendCarry` flag a carried day" → `dashboard.test.js`.
- "Does a carried day render without a marker" → here.

Anything provable with a stub belongs in `server.test.js`, which runs in two
seconds and offline. This tier is slower and needs a database; spending it on
something a unit test could catch makes every future run more expensive for no
extra confidence.

State is shared across tests **within** a section on purpose: an end-to-end flow
is a sequence, and re-registering an account per assertion would test the
registration route forty times and everything else once.

---

## Adding to it as the product changes

1. Put the assertion in the section it belongs to, or add a `describe` if the
   feature is genuinely new.
2. If it needs a new payload shape, add a helper to `client.js` rather than
   inlining the shape. Every shape in that file was guessed wrong the first
   time; naming them once is what stops the next person paying that again.
3. **Then break the code on purpose and check the test fails.** A test that has
   never failed has not been shown to test anything. The five mutations used to
   validate this suite when it was written:

   | Mutation | Assertions that failed |
   |---|---|
   | "copy nobody" falls back to the account CC | 2 |
   | `risk-series` decrypts the API key | 2 |
   | A carried day is given a data marker | 2 |
   | The snapshot crawl is not root-only | 5 |
   | `ccEnabled` is hard-coded true | 2 |

---

## When something fails

The stack's backend log is captured and printed with the failure when the
service will not start. For a test that fails once it is up, re-run with the
backend log streamed:

```bash
TEST_DATABASE_URL=… node --test e2e.test.js 2>&1 | tail -60
```

and inspect the database afterwards — the suite leaves it as it was at the end
of the run, and `SECRET_ENCRYPTION_KEY` is fixed to `aaaa…` precisely so a
failed run's rows can still be decrypted by hand.
