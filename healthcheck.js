// Docker healthcheck for mail.
// Checks:
//   - HTTP API health endpoint (covers DB + all IMAP/SMTP ports via /api/health)
//   - HTTP frontend (catches missing static file serving)
//
// The /api/health endpoint internally verifies TCP connectivity on all ports:
//   SMTP: 25, 465, 587 | IMAP: 143, 993
// so a single fetch to /api/health is sufficient to detect mail server failures.

const BASE = "http://localhost:" + (process.env.PORT || 3004);

async function check(path, opts = {}) {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(path + " returned " + res.status);
  if (opts.contentType) {
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes(opts.contentType))
      throw new Error(path + " content-type was " + ct);
  }
  if (opts.allHealthy) {
    const body = await res.json();
    const checks = body?.body?.checks || {};
    const failed = Object.entries(checks)
      .filter(([, v]) => v !== "ok")
      .map(([k]) => k);
    if (failed.length > 0)
      throw new Error("Unhealthy services: " + failed.join(", "));
  }
}

try {
  await check("/api/health", { allHealthy: true });
  await check("/", { contentType: "text/html" });
  process.exit(0);
} catch (e) {
  console.error("Healthcheck failed:", e.message);
  process.exit(1);
}
