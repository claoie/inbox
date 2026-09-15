import { logger } from "server";

/** Parses a positive-integer concurrency setting, warning and falling back on anything invalid. */
export const parseConcurrencyValue = (
  raw: string | undefined,
  envVar: string,
  defaultValue: number,
  label: string
): number => {
  if (!raw) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    logger.warn(`[${label}] ${envVar} invalid, falling back to default`, {
      raw,
      default: defaultValue,
    });
    return defaultValue;
  }
  return parsed;
};
