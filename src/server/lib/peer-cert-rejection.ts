// A peer rejecting our certificate (expired, wrong hostname, unknown CA) is a
// server-side defect even though it surfaces as a TLS-layer error, so it pages.
const PEER_CERT_REJECTION_ALERTS = [
  "ALERT_BAD_CERTIFICATE",
  "ALERT_UNSUPPORTED_CERTIFICATE",
  "ALERT_CERTIFICATE_REVOKED",
  "ALERT_CERTIFICATE_EXPIRED",
  "ALERT_CERTIFICATE_UNKNOWN",
  "ALERT_UNKNOWN_CA"
];

export const isPeerCertRejection = (err: Error): boolean => {
  const { reason } = err as Error & { reason?: string };
  const text = `${reason ?? ""} ${err.message ?? ""}`.toUpperCase().replace(/ /g, "_");
  return PEER_CERT_REJECTION_ALERTS.some((alert) => text.includes(alert));
};
