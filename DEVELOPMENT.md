# Development Guide

## Quick Start

```bash
# Install dependencies
bun install

# Run tests
bun test

# Run development server (requires PostgreSQL)
bun run dev

# Build for production
bun run build

# Start production server
bun run start
```

## Project Structure

```
src/
├── client/           # React frontend
│   ├── Box/          # Main email UI components
│   ├── ErrorBoundary/ # Error handling
│   ├── lib/          # Client utilities
│   └── App.tsx       # Root component
├── server/           # Backend services
│   ├── lib/
│   │   ├── http/     # Express server + API routes
│   │   │   └── routes/ # API endpoints
│   │   ├── imap/     # IMAP server implementation
│   │   ├── mails/    # Mail processing utilities
│   │   ├── postgres/ # Database layer
│   │   ├── spam/     # Spam classification (rules + Naive Bayes)
│   │   └── smtp.ts   # SMTP server (single file)
│   └── start.ts      # Server entry point
└── common/           # Shared code
    └── models/       # Data models
```

## Services

Mail runs multiple services:

| Service | Default Port | Override Env | Description |
|---------|--------------|--------------|-------------|
| HTTP/API | 3000 | — | Web UI + REST API |
| IMAP | 143 | `IMAP_PORT` | IMAP server (STARTTLS) |
| IMAP/TLS | 993 | `IMAP_TLS_PORT` | IMAP server (Implicit TLS) |
| SMTP | 25 | `SMTP_PORT` | SMTP server (plain) |
| SMTP/TLS | 465 | `SMTPS_PORT` | SMTP server (Implicit TLS) |
| SMTP/STARTTLS | 587 | `SMTP_SUBMISSION_PORT` | SMTP server (STARTTLS) |

The IMAP/SMTP port env vars exist primarily to let non-root sandboxes bind high ports (143/25 require root). Production deployments typically leave them unset.

## Key Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `APP_HOSTNAME` | Recommended | The hostname mail clients use to connect to IMAP/SMTP. Must match the TLS certificate CN/SAN. Used in autoconfig XML and IMAP/SMTP TLS greetings. |
| `EMAIL_DOMAIN` | Yes | The domain used for email addresses (`*@EMAIL_DOMAIN`). MX records should point to this domain's mail server. |
| `MAILGUN_KEY` | For sending | Mailgun API key. Required to send outgoing mail. |
| `MAILGUN_URL` | Optional | Root of Mailgun's HTTP API. Defaults to `https://api.mailgun.net`; set `https://api.eu.mailgun.net` for an EU-region domain. |
| `DISCORD_ALARM_WEBHOOK` | Optional | Discord webhook URL for server error alarms (unhandled exceptions, 5xx errors). |

### `APP_HOSTNAME` vs `EMAIL_DOMAIN`

These two env vars serve different purposes and are **not always the same**:

- `EMAIL_DOMAIN` — the domain portion of email addresses (`user@example.com`). MX records direct inbound mail here. Non-TLS delivery paths use this domain.
- `APP_HOSTNAME` — the actual server hostname that TLS-enabled clients connect to for IMAP/SMTP. This must match the server's TLS certificate. Thunderbird, iOS Mail, and autoconfig XML all use this name.

**Example:** If your cert is for `mail.example.com` but your email domain is `example.com`:
- Set `EMAIL_DOMAIN=example.com` (addresses are `user@example.com`)
- Set `APP_HOSTNAME=mail.example.com` (IMAP/SMTP clients connect to `mail.example.com`)

If `APP_HOSTNAME` is not set, it falls back to `EMAIL_DOMAIN`. This works when both names are the same, but IMAP/SMTP TLS handshakes will fail if the cert doesn't match the domain.

See PR #374 (autoconfig XML) for the implementation in `src/server/lib/http/index.ts`.

## API Patterns

### Route Definition

Routes use Express router with a custom `Route` class:

```typescript
import { Route } from "../route";

export const myRoute = new Route<ResponseType>("POST", "/path", async (req, res) => {
  return { status: "success", body: data };
});
```

### Response Format

```typescript
interface ApiResponse<T> {
  status: "loading" | "streaming" | "success" | "failed" | "error";
  body?: T;
  message?: string;
}
```

### Client-Side API Calls

Use the `call` utility:

```typescript
import { call } from "client";

const { status, body, message } = await call.get<ResponseType>("/api/endpoint");
const { status, body } = await call.post<ResponseType, BodyType>("/api/endpoint", body);
```

## Testing

### Test Requirements (Mandatory)

**Always write unit tests for new code files.** This is a project rule.

- New files: Create a corresponding `*.test.ts` file
- New functions: Add test cases covering expected behavior and edge cases
- Bug fixes: Add regression tests that would have caught the bug
- Security-critical code: Must have tests (auth, parsers, validation)

Check coverage with `bun run test:coverage`. Coverage thresholds are enforced by `scripts/check-coverage.ts` against the aggregate over `src/` — CI fails if coverage drops below the configured minimum. (They are not in `bunfig.toml`: Bun 1.4.1+ applies `coverageThreshold` per file, which zero-function files such as icon components can never meet.) When adding significant new code, update the thresholds upward as coverage improves.

### Running Tests

```bash
bun run test               # All tests (use this — not bare `bun test`)
bun test --watch           # Watch mode
bun test src/path/file.test.ts  # Single file
bun run test:coverage      # With coverage report
```

> **Always use `bun run test`, not bare `bun test`.** The `test` npm script runs client and server tests in separate passes with correct preload setup. Bare `bun test` mixes client and server contexts and can cause spurious failures from mock leakage.

### Test Location

Tests are adjacent to source files:
- `src/server/lib/imap/util.test.ts`
- `src/server/lib/imap/index.test.ts`

### IMAP Parser Tests

Security-critical parsers have dedicated test coverage:
- Auth parsers (LOGIN, AUTHENTICATE)
- APPEND parser (message upload)
- Mailbox parsers (SELECT, EXAMINE, STATUS, etc.)

### Bun `mock.module` — Global Scope Warning

**`mock.module()` replaces modules globally for the entire test run**, not just the current test file. This has caused repeated CI failures.

**Rules:**
1. **Mock only what the module under test actually imports.** Don't mock extra exports "just in case" — they leak into other test files.
2. **Never mock utility functions** (`getDomain`, `getUserDomain`, `isValidEmail`) unless the code under test directly calls them.
3. **If a mock must override a barrel** (`'server'`), re-export everything the barrel normally exports to avoid breaking downstream tests.
4. **Restore what you mock in `afterAll`**, from the snapshot `scripts/test-preload.ts` took before any file ran (`__REAL_SERVER`, `__REAL_ALARM`, `__REAL_FS`, …; `restoreLeaves()` for the pool driver / `web-push`). Mocking `"server"` writes through the barrel's re-exports into the source module, so a stub `logger` on the barrel replaces `lib/logger.ts`'s export for every importer. A snapshot taken inside the test file is not enough: it can capture an earlier file's leaked stub.

**Example of the bug pattern:**
```typescript
// ❌ smtp.test.ts mocked 'server' with getDomain: () => 'test.com'
// → mails/util.test.ts also imports getDomain from 'server'
// → getDomain resolves to the mock stub, 4 tests fail

// ✅ Only mock what smtp.ts actually uses
mock.module("server", () => ({
  getUser: mockGetUser,
  saveMailHandler: mockSave,
  sendMail: mockSend,
  // Don't include getDomain — smtp.ts doesn't import it
}));
```

### React Component Cleanup

Always return cleanup functions from `useEffect` when adding event listeners:

```typescript
useEffect(() => {
  const handler = (e: Event) => { /* ... */ };
  window.addEventListener("focus", handler);
  return () => window.removeEventListener("focus", handler);
}, []);
```

## Code Style

### TypeScript

- Avoid `any` - use proper types or `unknown`
- Use explicit return types for exports
- Prefer interfaces for object shapes

### Error Handling

Server routes wrap handlers with try/catch:

```typescript
try {
  const result = await callback(req, res, stream);
  if (result) res.json(result);
} catch (error: any) {
  console.error(error);
  res.status(500).json({ status: "error", message: error?.message });
}
```

### Async Error Propagation

**Don't swallow errors with `.catch(console.error)`.** This pattern silently hides failures:

```typescript
// ❌ Bad - Error is logged but not propagated
await doSomething().catch(console.error);
// Calling code thinks this succeeded

// ✅ Good - Log and re-throw
await doSomething().catch((error) => {
  console.error("Operation failed:", error);
  throw error;  // Propagate to caller
});

// ✅ Good - Let caller handle it
await doSomething();  // Throws naturally
```

This is especially important in background tasks where failures need to be tracked.

### IMAP Implementation Notes

- Sessions track state per connection
- IDLE manager handles long-lived connections with 29-minute refresh
- Parser functions return structured results or throw on invalid input

### Mailbox Hierarchy

After the accounts/ restructure (PR #317), the IMAP mailbox tree is:

```
INBOX                          ← unified inbox (all accounts aggregated)
INBOX/accounts/                ← non-selectable parent (\HasChildren \Noselect)
INBOX/accounts/{username}      ← per-account received mail (e.g. INBOX/accounts/alice)
Sent Messages                  ← unified sent (all accounts aggregated)
Sent Messages/accounts/        ← non-selectable parent (\HasChildren \Noselect)
Sent Messages/accounts/{name}  ← per-account sent mail
Drafts                         ← user-created mailbox (if present)
Trash                          ← user-created mailbox (if present)
```

**Unified INBOX** (`INBOX`) aggregates mail from all accounts belonging to the user. Selecting it returns messages regardless of which account received them.

**Per-account sub-folders** (`INBOX/accounts/{name}`) are generated dynamically from `accountToBox()` in `src/server/lib/imap/util.ts`:

```typescript
export const accountToBox = (accountName: string): string => {
  const localPart = accountName.split("@")[0]; // strip domain
  return `INBOX/accounts/${localPart}`;
};
```

Only accounts with existing mail appear in `LIST` output — `listMailboxes()` in `store.ts` queries `getAccountStats()` and adds sub-folders only for addresses with data.

**NAMESPACE advertisement** — the server responds per RFC 2342 with a single personal namespace using `/` as delimiter and empty prefix:

```
* NAMESPACE (("" "/")) NIL NIL
```

This means mailbox paths use `/` as the hierarchy separator with no prefix, matching the tree above.

**Supported IMAP extensions** (as of PR #322):

| Extension | RFC | Behavior |
|-----------|-----|----------|
| `NAMESPACE` | RFC 2342 | Returns single personal namespace |
| `ENABLE` | RFC 5161 | Acknowledged but no extensions activated |
| `UNSELECT` | RFC 3691 | Deselects current mailbox without expunging |
| `GETQUOTAROOT` | RFC 2087 | Returns `NO Quota not supported` |

Base capabilities advertised: `IMAP4rev1 LITERAL+ SASL-IR LOGIN-REFERRALS ID ENABLE IDLE AUTH=PLAIN` (plus `STARTTLS` on port 143, and only when `SSL_CERTIFICATE` / `SSL_CERTIFICATE_KEY` point at files this process can read).

### Sent Mail Detection

Sent mail is detected by **address matching**, not a boolean `sent` flag:

- A mail appears in "Received" if any of `to_address`, `cc_address`, `bcc_address`, or `envelope_to` matches the account
- A mail appears in "Sent" if the sender's `from_address` matches the account
- Self-sent emails (same from and to) appear in **both** views correctly

This was changed in PR #199 from the previous `sent` column approach. The address-based method handles edge cases better:
- Self-email: one DB row, visible in both views
- Multi-recipient: each user's copy is scoped correctly (CC and BCC recipients land in the received view)
- Listserv / sub-addressed delivery: `envelope_to` (the SMTP-level RCPT TO) often differs from MIME `to_address` for GitHub notifications and mailing-list relays — including it ensures the actual delivery target surfaces (PRs #525, #526)
- No ambiguity about what "sent" means for forwarded or relayed mail

Key functions:
- `getMailHeaders()` — for received view, filters on `to_address`, `cc_address`, `bcc_address`, and `envelope_to`; for sent view, filters on `from_address`
- `getAccountStats()` — counts using the same address-column set (not `sent` flag)

**Self-email:** When a user sends mail to themselves, the sent-mail copy is saved with the sender's address as `from_address` and the recipient's address (same address) as `to_address`. It appears in the Sent view because `from_address` matches the user, and in the Received view because `to_address` matches the user — no special-casing required.

### IMAP Mailbox Hierarchy

Mailboxes are organized under a flat namespace with `/` as delimiter:

```
INBOX                              ← Unified inbox (all accounts)
accounts/user@example.com          ← Per-account received mail
Sent Messages                     ← Unified sent mail
Sent Messages/accounts/user@...   ← Per-account sent mail
```

Key implementation details (see `src/server/lib/imap/util.ts`):
- `accountToBox()` / `boxToAccount()` map between email addresses and IMAP mailbox names
- `isSentBox()` detects sent-mail mailboxes at any level
- Mailboxes are filtered by user domain — only addresses belonging to the server's domain are exposed
- NAMESPACE response declares `("" "/")` as the personal namespace

### IMAP Parser Implementation Rules

**Always call `skipWhitespace(context)` before parsing an argument.** After parsing a keyword atom (e.g., `FROM`), the context cursor is positioned at the space separator. Argument parsers (`parseAtom`, `parseDate`, `parseNumber`, etc.) do not skip leading whitespace themselves — calling them without first skipping the space causes them to return empty/fail immediately.

```typescript
// ❌ Bug — cursor is at " user@example.com" (space before value)
case "FROM": {
  const value = parseAtom(context); // returns "" — space not skipped
  return { type: "FROM", value };
}

// ✅ Correct — skip the separator first
case "FROM": {
  skipWhitespace(context);           // cursor now at "user@example.com"
  const value = parseAtom(context);  // returns "user@example.com"
  return { type: "FROM", value };
}
```

This was the root cause of all SEARCH criteria with arguments silently failing (PR #416). Applies to every argument-taking case in `search-parsers.ts`, `fetch-parsers.ts`, and any future parser.

**Rule:** After parsing a keyword, always call `skipWhitespace(context)` before parsing its argument.


### IMAP Parser-to-Consumer Contract

**Parsers produce self-contained criterion objects.** Each parsed criterion has its value embedded as a property — never rely on adjacent array indices.

```typescript
// Parser output for "SEARCH FROM user@example.com UNSEEN":
[
  { type: "FROM", value: "user@example.com" },  // value is a property
  { type: "UNSEEN" }                              // no value needed
]

// ✅ Correct — read from the criterion object
for (const criterion of criteria) {
  switch (criterion.type) {
    case "FROM":
      filter.from = criterion.value;  // value is on the object
      break;
  }
}

// ❌ Wrong — don't index into the array for values
for (let i = 0; i < criteria.length; i++) {
  if (criteria[i].type === "FROM") {
    value = criteria[++i];  // BUG: next element is a separate criterion
  }
}
```

This pattern also applies to FETCH data items and STORE operations — each parsed item is self-contained.

### IMAP Client Compatibility

The IMAP server targets compatibility with standard mail clients (Apple Mail, iOS Mail, Thunderbird). Key patterns learned from client testing:

- **BODYSTRUCTURE must match BODY[] encoding**: If BODYSTRUCTURE declares `base64`, the corresponding `BODY[n]` fetch must return base64-encoded content (not raw UTF-8)
- **RFC822.SIZE must account for encoding**: Size should reflect the encoded (wire-format) message size
- **CAPABILITY response must match TLS mode and cert availability**: Implicit-TLS connections must NOT advertise STARTTLS; plain connections advertise it only when a certificate is actually readable, since a client that honours the advertisement would otherwise drive the upgrade into an ENOENT (RFC 2595 §3 — do not advertise what the server cannot honour). (`getCapabilities(isTls)` in `src/server/lib/imap/capabilities.ts`, gated on `isTlsAvailable()` from `src/server/lib/tls.ts`.)
- **AUTHENTICATE PLAIN**: Support both inline initial response and challenge-response flow (some clients omit the initial response)
- **Supported extensions**: NAMESPACE (RFC 2342), ENABLE (RFC 5161), UNSELECT (RFC 3691); GETQUOTAROOT returns NO (not supported)
- **Flags on sub-mailboxes**: Per-account mailboxes should NOT have `\Noselect` — clients need to be able to select them

Per-client known quirks:

- **iOS Mail**: Expects `BODY[1]` to return decoded content, uses `BODY.PEEK[HEADER.FIELDS (...)]`, requires accurate `RFC822.SIZE` for display
- **Thunderbird**: Uses `UID FETCH ... (FLAGS BODY.PEEK[HEADER.FIELDS (Date From Subject ...)])` in batches
- **Apple Mail (macOS)**: Similar to iOS but also uses `NAMESPACE` and `GETQUOTAROOT`

When fixing IMAP bugs, always test with the affected client and document which client triggered the issue in the PR description.

### Graceful Shutdown Order

Shutdown must follow this order to avoid connection errors:

1. Stop accepting new connections (HTTP, IMAP, SMTP servers)
2. Close idle IMAP connections via `idleManager.shutdown()`
3. Wait for in-flight requests to complete
4. Close database pool

```typescript
// Correct order (see start.ts)
httpServer.close();
imapServer.close();
smtpServer.close();
await idleManager.shutdown();
await pool.end();
```

Closing DB before servers causes "connection terminated" errors on active requests.

## Database

### PostgreSQL Setup

Configure via environment variables:
- `POSTGRES_HOST`
- `POSTGRES_PORT` (default: 5432)
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `POSTGRES_DATABASE`

### Repository Pattern

Database operations are in `src/server/lib/postgres/repositories/`:

```typescript
import { getMails, saveMail } from "./repositories/mails";
```

### Table Class Methods (IMPORTANT)

**Always use table class methods instead of direct SQL/pool operations.**

```typescript
// ✓ Correct - use table methods
import { sessionsTable } from "./models";
await sessionsTable.deleteByIds(sessionIds);
await sessionsTable.insertOne(sessionData);

// ✗ Avoid - direct pool/SQL usage
import { pool } from "./client";
await pool.query("DELETE FROM sessions WHERE ...");
```

This pattern ensures consistent transaction handling, logging, and type safety.

**Exception — use direct SQL when table methods are inefficient:**

When the generic table method would require fetching all rows and filtering in JavaScript (e.g., fetching all user mailboxes to find one by name), use a targeted SQL query or a specialized repository method instead. Fetching N rows to find 1 is unacceptable at scale.

```typescript
// ❌ Bad - fetches everything, filters in JS
const boxes = await mailboxesTable.findAll({ user_id });
const target = boxes.find(b => b.name === name);

// ✅ Good - single targeted query
const result = await pool.query(
  "SELECT * FROM mailboxes WHERE user_id = $1 AND name = $2",
  [userId, name]
);
```

Alternatively, add a specialized method to the Table class for the pattern and reuse it.

### Migrations

Schema migrations run automatically on startup via `src/server/lib/postgres/migrate.ts`.

### Data Integrity Constraints

**Add UNIQUE constraints for natural keys** to prevent duplicate data at the database level, not just the application level. Application-level dedup is insufficient — race conditions, retries, and concurrent connections can all create duplicates.

```sql
-- Add unique constraint with conflict handling for existing data
ALTER TABLE mails ADD CONSTRAINT mails_user_message_unique
  UNIQUE (user_id, message_id);
```

When inserting data that may conflict, use `ON CONFLICT`:

```typescript
// ✅ Good — upsert handles duplicates gracefully
await pool.query(
  `INSERT INTO mails (...) VALUES (...)
   ON CONFLICT (user_id, message_id) DO UPDATE SET ...`,
  values
);
```

For manual migration scripts (DDL changes the automatic migration system can't handle), place them in `migrations/` with a numbered prefix. See `migrations/001_unique_user_message_id.sql` for a complete example that safely deduplicates existing data before adding the constraint.

**Rule:** If a combination of columns should be unique (e.g., user + email message ID), enforce it at the database level, not just in code.

## Security Considerations

### Authentication

- Tokens use `crypto.randomBytes()` (cryptographically secure)
- Rate limiting on auth endpoints (15 min window, 10 attempts)

### Email Display Security

**Email HTML is untrusted content.** Always use iframe sandboxing:

```tsx
<iframe
  srcDoc={processHtmlForViewer(data.html)}
  sandbox="allow-same-origin"
/>
```

The `sandbox` attribute restricts:
- ❌ Script execution (no JS in emails)
- ❌ Form submissions
- ❌ Popups and new windows
- ❌ Top navigation hijacking
- ✅ `allow-same-origin` enables CSS styling

**Never add `allow-scripts` to email iframes** - this would enable XSS attacks via malicious emails.

When rendering search highlights from `ts_headline`, **sanitize the output** before using `dangerouslySetInnerHTML`. PostgreSQL's `ts_headline` strips most tags by default but can pass through crafted content:

```typescript
// ✅ Good — sanitize ts_headline output
const sanitize = (html: string) =>
  html.replace(/<(?!\/?b>)[^>]*>/gi, ""); // allow only <b> tags

<div dangerouslySetInnerHTML={{ __html: sanitize(highlight) }} />
```

See `src/client/Box/components/Mails/index.tsx` for the implementation (PR #174).

Additional defense layers:
- **HTML sanitization** — `sanitizeEmailHtml()` in `src/client/lib/html.ts` runs before email HTML reaches the iframe. It strips `<script>`/`<iframe>`/`<object>`/`<embed>`/`<applet>`/`<base>` elements, `on*` event-handler attributes, `javascript:`/`vbscript:` URIs in URL-bearing attributes (`href`, `src`, `action`, `xlink:href`, `formaction`), and `data:` URIs in the same set minus `src` (kept on `<img src>` since inline data images are harmless). It also adds `referrerpolicy="no-referrer"` and `loading="lazy"` to every `<img>` so external images load without leaking the inbox origin and only when scrolled into view.
- **CSP headers** — set in `src/server/lib/http/index.ts`. `img-src 'self' data: blob: https:` allows external email images while blocking plain `http:` to avoid mixed content. `script-src 'self'`, `object-src 'none'`, `base-uri 'self'`, and `frame-src 'self'` (combined with the email-iframe `sandbox`) keep emails from executing code or framing hostile content.

### Data Deletion Strategy

Prefer **soft-delete** over hard-delete for user-facing data:

- Mark records as deleted (e.g., `expunged` flag) rather than removing rows
- Soft-deleted records are excluded from normal queries but preserved for recovery
- Hard deletion is reserved for cleanup tasks or explicit user requests

This pattern is used in the IMAP EXPUNGE implementation where deleted messages retain their data until explicitly purged.

**Every mail query must include `AND expunged = FALSE`.** This has been a recurring bug source — when adding new queries or modifying existing ones, always filter out soft-deleted records:

```sql
-- ✅ Correct - always filter expunged
WHERE user_id = $1 AND expunged = FALSE
  AND search_vector @@ plainto_tsquery('english', $2)

-- ❌ Bug - expunged emails appear in results
WHERE user_id = $1
  AND search_vector @@ plainto_tsquery('english', $2)
```

Affected queries: header listings, IMAP search, UID range queries, unread counts, full-text search, account stats. See PRs #195, #198 for examples of this bug.

### Sent Mail Detection

Detect sent mail by matching `from_address` against the user's configured addresses, not by relying on IMAP `\Sent` flags or folder names:

```typescript
// ✅ Correct - reliable across all IMAP clients
const isSent = userAddresses.includes(mail.from_address);

// ❌ Unreliable - flag/folder naming varies by client
const isSent = mail.flags?.includes("\\Sent");
```

See PR #199 for the rationale — IMAP clients use different conventions for sent folders and flags.

### IMAP Security

- Password comparison uses constant-time comparison
- Session IDs are cryptographically random
- Per-user UIDVALIDITY tracking prevents cross-user data leaks

### Timer and Resource Cleanup

Server-side timers and resource references must be cleaned up when they expire or are replaced:

```typescript
// BAD: stale references accumulate
const timers: Record<string, Timeout> = {};
const startTimer = (id: string) => {
  timers[id] = setTimeout(() => { /* ... */ }, DURATION);
  // ← old timer for same id still fires, reference leaks
};

// GOOD: clear previous timer, clean up reference
const startTimer = (id: string) => {
  if (timers[id]) clearTimeout(timers[id]);
  timers[id] = setTimeout(() => {
    delete timers[id]; // clean up reference after firing
    // ...
  }, DURATION);
};
```

### Process Lifecycle Handlers

Process-level handlers (`SIGINT`, `SIGTERM`, `unhandledRejection`, `uncaughtException`) belong in the application entry point (`start.ts`), not in library modules. Shutdown should drain resources in order:

1. Stop accepting new connections (close HTTP/IMAP/SMTP servers)
2. Close database pool
3. Exit process

Library modules should not register global process handlers as side effects of import.

## Query Optimization

### Select Only Needed Columns

**Never `SELECT *` when you only need a subset of columns**, especially for tables with large text/blob columns. The mail table's `text` and `html` columns can be several MB per row.

```typescript
// ❌ Bad - loads full mail bodies into memory
const result = await pool.query("SELECT * FROM mails WHERE account_id = $1", [accountId]);

// ✅ Good - select only header columns
const result = await pool.query(
  "SELECT id, account_id, from_address, to_address, subject, date, read, saved, expunged FROM mails WHERE account_id = $1",
  [accountId]
);
```

This pattern was critical in PR #161 where `getMailHeaders` was selecting all columns including mail bodies, causing OOM crashes when accounts had thousands of emails.

**Rule:** Repository functions that return lists should explicitly select only the columns they need.

## Accessibility

### Interactive Elements

**Use semantic HTML for interactive elements.** Clickable `<div>` elements are not keyboard-accessible.

```tsx
// ❌ Bad - invisible to keyboard and screen readers
<div className="mail-card" onClick={onClickMail}>

// ✅ Good - focusable, keyboard-accessible, announced as interactive
<button className="mail-card" onClick={onClickMail}>

// ✅ Acceptable - when button styling is impractical
<div role="button" tabIndex={0} onClick={onClickMail}
  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClickMail(); }}>
```

### Form Inputs

**Every `<input>` must have an associated label:**

```tsx
<label htmlFor="search">Search</label>
<input id="search" value={query} onChange={onChange} />
// or
<input aria-label="Search emails" value={query} onChange={onChange} />
```

### File I/O in Async Context

**Use async filesystem APIs, not sync wrappers in Promise constructors.**

```typescript
// ❌ Bad - sync I/O blocks the event loop despite Promise wrapper
return new Promise((resolve, reject) => {
  try {
    fs.writeFileSync(path, data);
    resolve(id);
  } catch (e) { reject(e); }
});

// ✅ Good - truly async
await fs.promises.writeFile(path, data);
return id;
```

**Directory creation:** Use `{ recursive: true }` instead of check-then-create:

```typescript
// ❌ TOCTOU race
if (!fs.existsSync(dir)) fs.mkdirSync(dir);

// ✅ Idempotent
await fs.promises.mkdir(dir, { recursive: true });
```

### IMAP/SMTP Authentication Rate Limiting

IMAP and SMTP auth attempts should be rate-limited per IP, similar to the HTTP login limiter. Unlike HTTP connections behind a reverse proxy, IMAP/SMTP connections are direct — an attacker can try unlimited passwords on a single persistent connection.

Rate limit counters should be shared across HTTP/IMAP/SMTP to prevent protocol-switching attacks.

## CI/CD

### Pull Request Checks

- ESLint linting
- Unit tests

> **TypeScript type checking runs in the Dockerfile builder stage**, not in CI. This prevents accidentally bypassing type checks via a PR that skips the Docker build. Do **not** add a separate `typecheck` step to GitHub Actions workflows.

### Deployment

Merges to `main` trigger Docker image build and deployment. The Dockerfile builder stage runs `bun run typecheck`, `bun run test`, and `bun run build` — the deployment fails if any of these fail. CD does not require a passing CI run for the same reason (redundant checks).

The production image runs the server bundle on Bun (`oven/bun:<version>-slim`), the same release the builder stage and CI use. Keep the three pinned to one version, and do not go below Bun 1.4.4: releases before 1.4 cannot upgrade an accepted socket to TLS server-side (`new tls.TLSSocket(socket, { isServer: true })`), so SMTP port 465, SMTP STARTTLS and IMAP STARTTLS hang during the handshake without raising an error, and before 1.4.4 `Bun.SQL` returns no column metadata, which the database pool needs to shape its results (it refuses to run without it).

## Common Tasks

### Adding a New API Route

1. Create file in `src/server/lib/http/routes/<domain>/`
2. Define route with `new Route<T>(method, path, handler)`
3. Add to domain index file
4. Export response type

### Adding IMAP Commands

After PR #424, `session.ts` was decomposed into focused modules. The correct module depends on the command type:

| Command type | Module |
|---|---|
| Mailbox ops (CREATE, DELETE, RENAME, SELECT, LIST, etc.) | `src/server/lib/imap/mailbox-ops.ts` |
| Message ops (FETCH, SEARCH, STORE, COPY, APPEND, EXPUNGE) | `src/server/lib/imap/message-ops.ts` |
| Auth / capability / state transitions | `src/server/lib/imap/session.ts` |
| Shared utilities (e.g. `shouldMarkAsRead`) | `src/server/lib/imap/session-utils.ts` |
| Request dispatch | `src/server/lib/imap/handler.ts` |

Steps to add a new IMAP command:

1. Add parser in `src/server/lib/imap/parsers/`
2. Add handler in the appropriate module above
3. Wire dispatch in `src/server/lib/imap/handler.ts`
4. Add tests for parser and handler
5. Update capabilities if needed

### Testing IMAP Locally

```bash
# Connect via telnet/netcat
nc localhost 143

# Or use openssl for TLS
openssl s_client -connect localhost:993

# Login
a001 LOGIN user@domain.com password
a002 SELECT INBOX
a003 FETCH 1:* FLAGS
```

## IMAP Implementation Patterns

### Mailbox Layout

The IMAP mailbox hierarchy is:

| Mailbox | Selectable | Description |
|---------|-----------|-------------|
| `INBOX` | ✅ | Unified inbox — all received mail across accounts |
| `Sent Messages` | ✅ | Unified sent box — all sent mail across accounts |
| `accounts/` | ❌ (parent) | Non-selectable container for per-account inboxes |
| `accounts/<name>` | ✅ | Per-account received mail |
| `Sent Messages/accounts/` | ❌ (parent) | Non-selectable container for per-account sent boxes |
| `Sent Messages/accounts/<name>` | ✅ | Per-account sent mail |

IMAP clients typically see `INBOX` as the primary mailbox. The `accounts/<name>` subfolders allow per-account filtering within clients that support subfolder navigation (e.g., iOS Mail sidebar).

### RFC Compliance

IMAP clients vary widely in which commands and responses they use. Always test changes with multiple clients:
- **iOS Mail** — strict about BODYSTRUCTURE encoding; body parts must match declared encoding
- **Thunderbird** — uses AUTHENTICATE PLAIN (sometimes without inline initial response)
- **Apple Mail (macOS)** — uses FETCH macros (ALL, FAST, FULL) and expects correct sequence numbers

Key RFC 3501 rules to remember:
- `* <n> EXISTS` must report **total** mailbox message count, not incremental
- Sequence numbers are contiguous 1..N; gaps are not allowed
- FETCH responses must include UID when `UID FETCH` is used
- BODYSTRUCTURE encoding declarations must match actual body part encoding

### FETCH Limit Tiers

To prevent denial-of-service from unbounded FETCH requests, limits are tiered by data weight:

| Request type | Limit | Rationale |
|-------------|-------|-----------|
| FLAGS/UID/RFC822.SIZE/INTERNALDATE only | Unlimited | Metadata only, lightweight |
| HEADER/HEADER.FIELDS | 500 | Text parsing but no body fetch |
| BODY/FULL | 50 | Full message reconstruction |

### Sequence Number ↔ UID Mapping

The session maintains bidirectional mappings (`seqToUid[]` and `uidToSeq` Map) rebuilt on SELECT. All FETCH/SEARCH/STORE commands must translate between sequence numbers and UIDs:
- `FETCH` (non-UID): client sends sequence numbers → translate to UIDs for DB query → respond with sequence numbers
- `UID FETCH`: client sends UIDs → query directly → respond with UIDs
- `SEARCH`: returns sequence numbers; `UID SEARCH` returns UIDs

### Avoiding Duplicate Switch Cases

`session.ts` uses large switch statements. TypeScript/JavaScript allows duplicate `case` labels without error — only the first match executes. Always search for existing cases before adding new ones. The `/* eslint-disable no-case-declarations */` at file scope masks warnings; prefer scoping it to individual cases.
