# Security Policy

## Reporting a Vulnerability

**Do not open a public issue for a suspected vulnerability.** This is a mail
server: a public report can disclose a live defect in software that handles
real credentials and message content before a fix exists.

Report vulnerabilities privately through GitHub's private vulnerability
reporting: open the repository's **Security** tab and choose
**"Report a vulnerability"**. This opens a private draft security advisory
visible only to you and the maintainers — no contact address needed, nothing
is published.

We aim to acknowledge your report within 72 hours and to keep you updated as
a fix is developed. If you have not heard back within a week, a polite
follow-up on the same advisory thread is welcome.

## Scope

**In scope:**

- The mail server itself: IMAP and SMTP handling, the HTTP API, session and
  credential lifecycle, spam-filtering layers, push notification delivery.
- Anything in this repository that processes untrusted input from the
  network: parsers, authentication paths, webhook handlers.

**Out of scope:**

- Operator misconfiguration of the documented environment variables
  (`docs/how_to_setup.md`, `.env.example`). If the documented setup is
  followed and the software still misbehaves, that is in scope.
- Vulnerabilities in third-party dependencies themselves — report those to
  the upstream project. (How this project *uses* a dependency unsafely is in
  scope.)
- Social engineering, physical access, or attacks requiring a compromised
  operator device.
- Automated scanner output without a demonstrated impact on this project.

## Supported Versions

Security fixes land on the `main` branch. There are no long-term-support
releases; if you run a fork or a pinned commit, the fix is the `main`
commit that closes the advisory, which we will point you to.

## After You Report

- We will confirm receipt and give you a rough timeline.
- We ask that you give us a reasonable window to ship a fix before any
  public disclosure, and we will credit you in the advisory unless you ask
  not to be named.
- `CONTRIBUTING.md`'s "Never Commit Secrets" rules apply to reports too:
  please redact credentials, tokens, and real message content from anything
  you attach.
