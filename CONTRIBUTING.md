# Contributing to Mail

## Development Setup

1. Clone the repository
2. Copy `.env.example` to `.env.local` (gitignored)
3. Run `bun install`
4. Run `bun run dev`

## Testing

Run tests with:
```bash
bun test
```

### Security Guidelines for Tests

**All test code is public.** Apply the same security scrutiny as production code.

#### Never Commit Secrets

- ❌ No hardcoded API keys, tokens, or credentials
- ❌ No real VAPID keys, even "just for tests"
- ❌ No private keys or certificates
- ✅ Use obviously fake values: `TEST_KEY_DO_NOT_USE`, `fake-token-12345`
- ✅ Use environment variables loaded from `.env.local`

#### Make Dependencies Optional

If a module requires secrets at import time, refactor to lazy initialization:

```typescript
// ❌ Bad: Fails if PUSH_VAPID_PRIVATE_KEY is missing
const vapidKey = process.env.PUSH_VAPID_PRIVATE_KEY!;
export const push = webpush.setVapidDetails(...);

// ✅ Good: Only fails when actually used
export const getPushService = () => {
  const vapidKey = process.env.PUSH_VAPID_PRIVATE_KEY;
  if (!vapidKey) throw new Error("PUSH_VAPID_PRIVATE_KEY required for push notifications");
  return webpush.setVapidDetails(...);
};
```

#### Test Fixtures

When tests need credential-like values:

```typescript
// ✅ Obviously fake values
const mockApiKey = "test_key_not_real_do_not_use";
const mockToken = "fake-jwt-token-for-testing";

// ✅ Use test utilities
const mockEnv = { PUSH_VAPID_PRIVATE_KEY: "TEST_VAPID_KEY_PLACEHOLDER" };
```

### Pre-Commit Checklist

Before committing, verify:

- [ ] `git diff --cached` — scan ALL files for secrets
- [ ] No hardcoded keys, tokens, or credentials
- [ ] Test files use obviously fake values
- [ ] Modules with required secrets have optional/mock paths

## Code Style

- TypeScript for all new code
- Use existing patterns in the codebase
- Run `bun run typecheck` to verify no type errors

## Pull Requests

- Keep PRs focused and small
- Include test coverage for new functionality
- Document breaking changes
- Use "Contributes to #X" instead of "Closes #X" in PR descriptions

## Environment Variables

Required for full functionality:
- `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE` — PostgreSQL connection
- `SECRET` — Express session secret
- `EMAIL_DOMAIN` — Domain used for `*@EMAIL_DOMAIN` mail addresses
- `ADMIN_PASSWORD` — Password the built-in `admin` user is created with, on the boot that creates it

Optional:
- `ADMIN_PASSWORD_RESET` — Set to `1` for one boot to replace `admin`'s stored password with `ADMIN_PASSWORD`
- `APP_HOSTNAME` — Server hostname for IMAP/SMTP TLS (falls back to `EMAIL_DOMAIN`)
- `PUSH_VAPID_PUBLIC_KEY`, `PUSH_VAPID_PRIVATE_KEY` — For push notifications
- `MAILGUN_KEY` — For outbound email via Mailgun

See `.env.example` for the full list.
