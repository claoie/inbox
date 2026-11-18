/**
 * Drives the multipart parser with real request bodies: the disk footprint of
 * a request is only observable on the filesystem afterwards.
 */
import { describe, it, expect } from "bun:test";
import fs from "fs";

import type { HttpRequest } from "./request";
import {
  MAX_ATTACHMENTS_PER_MAIL,
  parseUploads,
  removeTempFiles,
  toUploadList,
  type UploadedFile,
} from "./upload";

const TEMP_DIR = "/tmp";
const ownTempFiles = () => new Set(fs.readdirSync(TEMP_DIR).filter((name) => name.startsWith("upload-")));

/** Temp files created since `before` that still exist; the unlink is asynchronous. */
const leftoverSince = async (before: Set<string>) => {
  for (let attempt = 0; attempt < 50; attempt++) {
    const left = [...ownTempFiles()].filter((name) => !before.has(name));
    if (left.length === 0) return left;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [...ownTempFiles()].filter((name) => !before.has(name));
};

const BOUNDARY = "----uploadtest";

type Part =
  | { field: string; value: string }
  | { field?: string; filename: string; payload: string | Uint8Array; type?: string | null };

const multipart = (parts: Part[]) => {
  const chunks: Uint8Array[] = [];
  const text = (value: string) => chunks.push(new TextEncoder().encode(value));
  for (const part of parts) {
    if ("value" in part) {
      text(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.field}"\r\n\r\n${part.value}\r\n`);
      continue;
    }
    const type = part.type === undefined ? "text/plain" : part.type;
    text(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${part.field ?? "attachments"}"; ` +
        `filename="${part.filename}"\r\n${type ? `Content-Type: ${type}\r\n` : ""}\r\n`
    );
    if (typeof part.payload === "string") text(part.payload);
    else chunks.push(part.payload);
    text("\r\n");
  }
  text(`--${BOUNDARY}--\r\n`);
  return Buffer.concat(chunks);
};

/** A body delivered in pieces of `chunkSize` bytes, so delimiters straddle reads. */
const chunked = (body: Uint8Array, chunkSize: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < body.byteLength; at += chunkSize) {
        controller.enqueue(body.slice(at, at + chunkSize));
      }
      controller.close();
    },
  });

const upload = async (body: Uint8Array | ReadableStream<Uint8Array>, contentType = `multipart/form-data; boundary=${BOUNDARY}`) => {
  const raw = new Request("http://localhost/api/mails/send", {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  const req = { method: "POST", body: {}, raw } as unknown as HttpRequest;
  const outcome = await parseUploads(req, raw);
  return { req, ...outcome };
};

const filler = (count: number): Part[] =>
  Array.from({ length: count }, (_, i) => ({ filename: `p${i}.txt`, payload: `p${i}` }));

describe("parseUploads", () => {
  it("hands readable temp files and fields to the route, and reclaims the files afterwards", async () => {
    const before = ownTempFiles();
    const { req, tempFiles, rejection } = await upload(
      multipart([
        { field: "subject", value: "hello" },
        { field: "to", value: "a@example.com" },
        { field: "to", value: "b@example.com" },
        { filename: "alpha.txt", payload: "alpha" },
        { filename: "beta.pdf", payload: "beta", type: "application/pdf" },
      ])
    );
    const uploads = toUploadList(req.files?.attachments);

    expect(rejection).toBeUndefined();
    expect(req.body).toEqual({ subject: "hello", to: ["a@example.com", "b@example.com"] });
    expect(uploads.map(({ name, mimetype, size }) => ({ name, mimetype, size }))).toEqual([
      { name: "alpha.txt", mimetype: "text/plain", size: 5 },
      { name: "beta.pdf", mimetype: "application/pdf", size: 4 },
    ]);
    expect(uploads.map((file) => fs.readFileSync(file.tempFilePath).toString())).toEqual(["alpha", "beta"]);

    removeTempFiles(tempFiles);
    expect(await leftoverSince(before)).toEqual([]);
  });

  it("parses the same bytes whatever the read boundaries", async () => {
    const binary = new Uint8Array(70_000).map((_, i) => (i * 31 + 7) % 256);
    const body = multipart([
      { field: "html", value: "<p>--not a boundary--</p>" },
      { filename: "blob.bin", payload: binary, type: "application/octet-stream" },
    ]);

    for (const chunkSize of [1, 7, BOUNDARY.length + 3, 4096]) {
      const { req, tempFiles } = await upload(chunked(body, chunkSize));
      const [file] = toUploadList(req.files?.attachments) as UploadedFile[];
      expect((req.body as Record<string, string>).html).toBe("<p>--not a boundary--</p>");
      expect(new Uint8Array(fs.readFileSync(file!.tempFilePath))).toEqual(binary);
      removeTempFiles(tempFiles);
    }
  });

  it("stops parsing one part past the mail cap so the route can reject the rest", async () => {
    const before = ownTempFiles();
    const { req, tempFiles } = await upload(multipart(filler(MAX_ATTACHMENTS_PER_MAIL + 30)));

    expect(toUploadList(req.files?.attachments)).toHaveLength(MAX_ATTACHMENTS_PER_MAIL + 1);
    removeTempFiles(tempFiles);
    expect(await leftoverSince(before)).toEqual([]);
  });

  it("answers an oversize part with the app's JSON envelope and reclaims its siblings", async () => {
    const before = ownTempFiles();
    const oversize = "0".repeat(26 * 1024 * 1024);
    const { rejection, tempFiles } = await upload(
      multipart([{ filename: "sibling.txt", payload: "sibling" }, { filename: "big.txt", payload: oversize }])
    );

    expect(rejection?.status).toBe(413);
    const body = (await rejection!.json()) as { status: string; message: string };
    expect(body.status).toBe("failed");
    expect(body.message).toMatch(/25MB/);
    expect(tempFiles).toEqual([]);
    expect(await leftoverSince(before)).toEqual([]);
  });

  it("refuses a part of exactly 25 MiB, as the limit has always counted", async () => {
    const { rejection } = await upload(
      multipart([{ filename: "exact.bin", payload: new Uint8Array(25 * 1024 * 1024) }])
    );
    expect(rejection?.status).toBe(413);
  });

  it("keeps a text field well past 1 MiB whole, through its last byte", async () => {
    const html = `<p>${"한".repeat(1024 * 1024)}</p>END`;
    const { req, rejection, tempFiles } = await upload(chunked(multipart([{ field: "html", value: html }]), 64 * 1024));

    expect(rejection).toBeUndefined();
    expect((req.body as Record<string, string>).html).toBe(html);
    removeTempFiles(tempFiles);
  });

  it("accepts a text field of exactly 10 MiB", async () => {
    const value = "a".repeat(10 * 1024 * 1024);
    const { req, rejection } = await upload(multipart([{ field: "html", value }]));

    expect(rejection).toBeUndefined();
    expect((req.body as Record<string, string>).html).toHaveLength(value.length);
  });

  it("refuses a text field over 10 MiB instead of cutting it, and reclaims its siblings", async () => {
    const before = ownTempFiles();
    const { req, rejection, tempFiles } = await upload(
      multipart([
        { filename: "sibling.txt", payload: "sibling" },
        { field: "html", value: "a".repeat(10 * 1024 * 1024 + 1) },
      ])
    );

    expect(rejection?.status).toBe(413);
    expect(await rejection!.json()).toEqual({ status: "failed", message: "Each form field must be at most 10MB" });
    expect(req.body).toEqual({});
    expect(tempFiles).toEqual([]);
    expect(await leftoverSince(before)).toEqual([]);
  });

  it("keeps the client's file name as UTF-8 without any directory part", async () => {
    const { req, tempFiles } = await upload(
      multipart([
        { filename: "C:\\\\Users\\\\me\\\\résumé ü.pdf", payload: "x", type: "application/pdf" },
        { filename: "../../etc/passwd", payload: "y" },
      ])
    );
    expect(toUploadList(req.files?.attachments).map((file) => file.name)).toEqual(["résumé ü.pdf", "passwd"]);
    removeTempFiles(tempFiles);
  });

  it("reads a part without Content-Type as text/plain and skips an empty file input", async () => {
    const { req, tempFiles } = await upload(
      multipart([
        { filename: "noctype.bin", payload: "abc", type: null },
        { filename: "", payload: "" },
      ])
    );
    const uploads = toUploadList(req.files?.attachments);
    expect(uploads.map(({ name, mimetype }) => ({ name, mimetype }))).toEqual([
      { name: "noctype.bin", mimetype: "text/plain" },
    ]);
    removeTempFiles(tempFiles);
  });

  it("leaves a request that is not multipart untouched", async () => {
    const { req, tempFiles } = await upload(new TextEncoder().encode('{"a":1}'), "application/json");
    expect([req.body, req.files, tempFiles]).toEqual([{}, undefined, []]);
  });

  it("refuses a body that ends before its closing boundary, leaving nothing on disk", async () => {
    const before = ownTempFiles();
    const truncated = multipart([{ filename: "a.txt", payload: "alpha" }]).subarray(0, 120);

    await expect(upload(truncated)).rejects.toMatchObject({ status: 400 });
    expect(await leftoverSince(before)).toEqual([]);
  });
});
