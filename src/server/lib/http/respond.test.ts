import { describe, it, expect } from "bun:test";
import { json, jsonList } from "./respond";

const whole = <R>(rows: R[], toItem: (row: R) => unknown) =>
  json({ status: "success", body: rows.map(toItem) });

const rowsOf = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `mail-${i}`,
    subject: `Subject ${i} — ünïcödé ✉️ "quoted" \\ back\nslash`,
    text: "x".repeat(i % 7 === 0 ? 2000 : 40),
    dropped: undefined,
  }));

const toItem = (row: ReturnType<typeof rowsOf>[number]) => ({
  id: row.id,
  subject: row.subject,
  snippet: row.text.slice(0, 160),
  missing: undefined,
});

async function* inBatches<R>(rows: R[], size: number): AsyncGenerator<R[]> {
  for (let start = 0; start < rows.length; start += size) yield rows.slice(start, start + size);
}

const expectSameAsJson = async <R>(rows: R[], map: (row: R) => unknown, batchSize = 500) => {
  const expected = whole(rows, map);
  const actual = await jsonList(inBatches(rows, batchSize), map);
  const [expectedBytes, actualBytes] = await Promise.all([
    expected.arrayBuffer(),
    actual.arrayBuffer(),
  ]);
  expect(new Uint8Array(actualBytes)).toEqual(new Uint8Array(expectedBytes));
  expect(actual.headers.get("etag")).toBe(expected.headers.get("etag"));
  expect(actual.headers.get("content-type")).toBe(expected.headers.get("content-type"));
  expect(actual.headers.get("content-length")).toBe(String(expectedBytes.byteLength));
  expect(actual.status).toBe(200);
};

describe("jsonList", () => {
  it("sends the bytes and ETag of the whole-list json() for an empty list", async () => {
    await expectSameAsJson([], toItem);
  });

  it("sends the bytes and ETag of the whole-list json() for one row", async () => {
    await expectSameAsJson(rowsOf(1), toItem);
  });

  it("joins rows across batch boundaries, including an empty batch", async () => {
    async function* withEmpty() {
      yield rowsOf(2);
      yield [];
      yield rowsOf(3);
    }
    const rows = [...rowsOf(2), ...rowsOf(3)];
    const expected = whole(rows, toItem);
    const actual = await jsonList(withEmpty(), toItem);
    expect(await actual.text()).toBe(await expected.text());
  });

  it("sends the bytes and ETag of the whole-list json() across many chunks", async () => {
    const rows = rowsOf(3000);
    expect(JSON.stringify(rows.map(toItem)).length).toBeGreaterThan(4 * 64 * 1024);
    await expectSameAsJson(rows, toItem);
  });

  it("maps every row exactly once, in order", async () => {
    const seen: number[] = [];
    const rows = rowsOf(500);
    const response = await jsonList(inBatches(rows, 37), (row) => {
      seen.push(Number(row.id.slice("mail-".length)));
      return toItem(row);
    });
    expect(seen).toEqual(rows.map((_, i) => i));
    const parsed = (await response.json()) as { body: { id: string }[] };
    expect(parsed.body.map((item) => item.id)).toEqual(rows.map((row) => row.id));
  });
});
