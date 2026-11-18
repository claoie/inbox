import crypto from "crypto";
import fs from "fs";
import path from "path";

import { logger } from "../logger";
import { HttpError, hasBody, type HttpRequest } from "./request";
import { json } from "./respond";

const MAX_FILE_SIZE = 25 * 1024 * 1024;

export const MAX_ATTACHMENTS_PER_MAIL = 20;

// Parsing one more than the mail cap is what lets the route answer "too many
// attachments" instead of dropping the surplus without telling the sender.
const MAX_PARSED_FILES = MAX_ATTACHMENTS_PER_MAIL + 1;

/** Matches the send validator's ceiling on the mail body, the largest field a form carries. */
const MAX_FIELD_BYTES = 10 * 1024 * 1024;

/**
 * The largest request body the server reads: every file the parser keeps at
 * full size, plus room for the form's text fields.
 */
export const MAX_REQUEST_BODY_SIZE = MAX_PARSED_FILES * MAX_FILE_SIZE + 64 * 1024 * 1024;
const MAX_HEADER_LINE_BYTES = 16 * 1024;
const MAX_PART_HEADERS = 64;

const TEMP_DIR = "/tmp/";

/** One uploaded file, written to a temp file as it arrived. */
export interface UploadedFile {
  /** The client's file name, without any directory part. */
  name: string;
  mimetype: string;
  size: number;
  tempFilePath: string;
}

/** A field holds one `UploadedFile` when a single part carried its name. */
export const toUploadList = (
  files: UploadedFile | UploadedFile[] | undefined
): UploadedFile[] => (files ? (Array.isArray(files) ? files : [files]) : []);

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** A repeated name collects its values into an array. */
const addField = <T>(target: Record<string, T | T[]>, name: string, value: T) => {
  if (UNSAFE_KEYS.has(name)) return;
  const existing = target[name];
  if (existing === undefined) target[name] = value;
  else if (Array.isArray(existing)) existing.push(value);
  else target[name] = [existing, value];
};

const MULTIPART_CONTENT_TYPE = /^multipart\/[\w'"()+-_?/:=,.]+(?:; ?[\w'"()+-_?/:=,.]*)+$/i;
const BODYLESS_METHODS = new Set(["GET", "HEAD", "DELETE", "OPTIONS", "CONNECT", "TRACE"]);

const boundaryOf = (contentType: string | null): string | undefined => {
  if (!contentType || !contentType.includes("boundary=") || !MULTIPART_CONTENT_TYPE.test(contentType)) {
    return undefined;
  }
  const match = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return match?.[1] ?? match?.[2];
};

const unquote = (value: string) =>
  value.startsWith('"') && value.endsWith('"') && value.length > 1
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;

/** `form-data; name="a"; filename="b"` → `{ name: "a", filename: "b" }`. */
const dispositionParams = (header: string): Record<string, string> => {
  const params: Record<string, string> = {};
  const pattern = /;\s*([^\s=;]+)\s*=\s*("(?:\\.|[^"\\])*"|[^;]*)/g;
  for (const [, key, raw] of header.matchAll(pattern)) {
    params[key!.toLowerCase()] = unquote(raw!.trim());
  }
  const extended = params["filename*"];
  if (extended) {
    const match = /^([^']*)'[^']*'(.*)$/.exec(extended);
    if (match) {
      try {
        params.filename = decodeURIComponent(match[2]!);
      } catch {
        // An undecodable extended name leaves the plain one in place.
      }
    }
  }
  return params;
};

/** Strips any directory part a client sent with the file name. */
const baseName = (name: string) => {
  const cut = Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\"));
  const base = cut === -1 ? name : name.slice(cut + 1);
  return base === "." || base === ".." ? "" : base;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CRLF = encoder.encode("\r\n");

const concat = (parts: Uint8Array[]): Uint8Array => {
  if (parts.length === 1) return parts[0]!;
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

const indexOf = (haystack: Uint8Array, needle: Uint8Array) =>
  Buffer.from(haystack.buffer, haystack.byteOffset, haystack.byteLength).indexOf(needle);

/** Pulls bytes from a body stream on demand, holding only what a search needs. */
class StreamCursor {
  private buffer: Uint8Array = new Uint8Array(0);
  private ended = false;

  constructor(private readonly reader: ReadableStreamDefaultReader<Uint8Array>) {}

  private async fill(): Promise<void> {
    if (this.ended) throw new HttpError(400, "Unexpected end of form");
    const { value, done } = await this.reader.read();
    if (done) {
      this.ended = true;
      throw new HttpError(400, "Unexpected end of form");
    }
    this.buffer = this.buffer.byteLength ? concat([this.buffer, value]) : value;
  }

  async peek(length: number): Promise<Uint8Array> {
    while (this.buffer.byteLength < length) await this.fill();
    return this.buffer.subarray(0, length);
  }

  /**
   * Hands every byte before `delimiter` to `sink` as it arrives, then consumes
   * the delimiter. Only a delimiter's length of bytes is ever held back.
   */
  async pipeUntil(
    delimiter: Uint8Array,
    sink: (chunk: Uint8Array) => Promise<void> | void
  ): Promise<void> {
    for (;;) {
      const at = indexOf(this.buffer, delimiter);
      if (at !== -1) {
        if (at > 0) await sink(this.buffer.subarray(0, at));
        this.buffer = this.buffer.subarray(at + delimiter.byteLength);
        return;
      }
      const flushable = this.buffer.byteLength - (delimiter.byteLength - 1);
      if (flushable > 0) {
        await sink(this.buffer.subarray(0, flushable));
        this.buffer = this.buffer.subarray(flushable);
      }
      await this.fill();
    }
  }

  /** Reads one CRLF-terminated line of at most `limit` bytes. */
  async readLine(limit: number): Promise<string> {
    const pieces: Uint8Array[] = [];
    let length = 0;
    await this.pipeUntil(CRLF, (chunk) => {
      length += chunk.byteLength;
      if (length > limit) throw new HttpError(400, "Malformed part header");
      pieces.push(chunk.slice());
    });
    return decoder.decode(concat(pieces));
  }

  cancel() {
    this.reader.cancel().catch(() => undefined);
  }
}

/** A part broke a size limit; its message is what the sender is told. */
class PartTooLargeError extends Error {}

const FILE_TOO_LARGE = `Each attachment must be smaller than ${MAX_FILE_SIZE / 1024 / 1024}MB`;
const FIELD_TOO_LARGE = `Each form field must be at most ${MAX_FIELD_BYTES / 1024 / 1024}MB`;

interface ParsedForm {
  fields: Record<string, string | string[]>;
  files: Record<string, UploadedFile | UploadedFile[]>;
  tempFiles: string[];
}

const writeFilePart = async (
  cursor: StreamCursor,
  delimiter: Uint8Array,
  tempFiles: string[]
): Promise<{ tempFilePath: string; size: number }> => {
  const tempFilePath = path.join(TEMP_DIR, `upload-${crypto.randomUUID()}`);
  tempFiles.push(tempFilePath);
  const handle = await fs.promises.open(tempFilePath, "w");
  let size = 0;
  try {
    await cursor.pipeUntil(delimiter, async (chunk) => {
      size += chunk.byteLength;
      if (size >= MAX_FILE_SIZE) throw new PartTooLargeError(FILE_TOO_LARGE);
      await handle.write(chunk);
    });
  } finally {
    await handle.close();
  }
  return { tempFilePath, size };
};

const parseForm = async (body: ReadableStream<Uint8Array>, boundary: string): Promise<ParsedForm> => {
  const form: ParsedForm = { fields: {}, files: {}, tempFiles: [] };
  const cursor = new StreamCursor(body.getReader());
  const delimiter = encoder.encode(`\r\n--${boundary}`);
  let fileCount = 0;

  try {
    await cursor.pipeUntil(encoder.encode(`--${boundary}`), () => undefined);
    for (;;) {
      if (decoder.decode(await cursor.peek(2)) === "--") break;
      await cursor.readLine(MAX_HEADER_LINE_BYTES);

      const headers = new Map<string, string>();
      for (let line = await cursor.readLine(MAX_HEADER_LINE_BYTES); line !== ""; ) {
        if (headers.size >= MAX_PART_HEADERS) throw new HttpError(400, "Malformed part header");
        const colon = line.indexOf(":");
        if (colon > 0) {
          headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
        }
        line = await cursor.readLine(MAX_HEADER_LINE_BYTES);
      }

      const disposition = headers.get("content-disposition") ?? "";
      const params = dispositionParams(disposition);
      const name = params.name;
      const isFormData = /^form-data\s*(;|$)/i.test(disposition);

      if (!isFormData || name === undefined) {
        await cursor.pipeUntil(delimiter, () => undefined);
      } else if (params.filename === undefined) {
        const pieces: Uint8Array[] = [];
        let length = 0;
        await cursor.pipeUntil(delimiter, (chunk) => {
          length += chunk.byteLength;
          if (length > MAX_FIELD_BYTES) throw new PartTooLargeError(FIELD_TOO_LARGE);
          pieces.push(chunk.slice());
        });
        addField(form.fields, name, decoder.decode(concat(pieces)));
      } else if (fileCount >= MAX_PARSED_FILES) {
        await cursor.pipeUntil(delimiter, () => undefined);
      } else {
        fileCount++;
        const fileName = baseName(params.filename).slice(0, 255);
        const { tempFilePath, size } = await writeFilePart(cursor, delimiter, form.tempFiles);
        // An empty name with no bytes is a file input the user left blank.
        if (!fileName && size === 0) continue;
        const contentType = headers.get("content-type");
        addField(form.files, name, {
          name: fileName || path.basename(tempFilePath),
          mimetype: contentType ? contentType.split(";")[0]!.trim().toLowerCase() : "text/plain",
          size,
          tempFilePath,
        });
      }
    }
    return form;
  } catch (error) {
    cursor.cancel();
    removeTempFiles(form.tempFiles);
    throw error;
  }
};

/** Deletes upload temp files; a file that is already gone is not an error. */
export const removeTempFiles = (tempFilePaths: string[]) => {
  for (const tempFilePath of tempFilePaths) {
    fs.unlink(tempFilePath, (error) => {
      if (error && error.code !== "ENOENT") {
        logger.warn("Failed to reclaim an upload temp file", { tempFilePath, error });
      }
    });
  }
};

/** What {@link parseUploads} leaves to the caller. */
export interface UploadOutcome {
  /** Answer this instead of running the route — the upload broke a limit. */
  rejection?: Response;
  /** Temp files to delete once the route has finished with them. */
  tempFiles: string[];
}

/**
 * Parses a multipart body onto `req.body` (fields) and `req.files` (file
 * parts), streaming each file to a temp file so no upload is held in memory.
 * A request that is not multipart, or has no body, is left untouched. Call it
 * only behind authentication, so unauthenticated bytes never reach disk.
 *
 * ```ts
 * const { rejection, tempFiles } = await parseUploads(req, request);
 * try { return rejection ?? (await route.handle(req)); } finally { removeTempFiles(tempFiles); }
 * ```
 *
 * A file or field over its size limit is answered 413; a malformed body throws an
 * {@link HttpError} with 400.
 */
export const parseUploads = async (req: HttpRequest, request: Request): Promise<UploadOutcome> => {
  const boundary = boundaryOf(request.headers.get("content-type"));
  if (!boundary || BODYLESS_METHODS.has(req.method) || !hasBody(request)) {
    return { tempFiles: [] };
  }

  try {
    const form = await parseForm(request.body!, boundary);
    const body = (req.body ?? {}) as Record<string, string | string[]>;
    for (const [name, value] of Object.entries(form.fields)) {
      for (const each of Array.isArray(value) ? value : [value]) addField(body, name, each);
    }
    req.body = body;
    if (Object.keys(form.files).length) req.files = form.files;
    return { tempFiles: form.tempFiles };
  } catch (error) {
    if (!(error instanceof PartTooLargeError)) throw error;
    return {
      tempFiles: [],
      rejection: json({ status: "failed", message: error.message }, 413),
    };
  }
};
