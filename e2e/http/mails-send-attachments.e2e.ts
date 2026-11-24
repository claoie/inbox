import crypto from "crypto";
import fs from "fs";
import net from "net";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { startServer, type TestServer } from "../harness";
import {
  BAD_REQUEST,
  NOT_LOGGED_IN,
  UUID,
  attachmentPath,
  countMails,
  failed,
  fields,
  latestMail,
  multipart,
  newMailbox,
  type FormPart,
  type Mailbox,
} from "./mails-helpers";

let server: TestServer;
let box: Mailbox;

beforeAll(async () => {
  server = await startServer();
  box = await newMailbox(server);
}, 90_000);

afterAll(async () => {
  await server?.stop();
});

beforeEach(() => {
  server.mailgun.reset();
});

const SUCCESS = { status: "success" };
const MIB = 1024 * 1024;
const TEXT = { sender: "box", senderFullName: "Al Box", to: "friend@remote.example", subject: "With files", html: "<p>see attached</p>" };

const file = (filename: string, value: string | Uint8Array, contentType: string | undefined = "text/plain", name = "attachments"): FormPart => ({
  name,
  filename,
  value,
  contentType,
});

const sendForm = (parts: FormPart[], client = box.client, path = "/api/mails/send") => {
  const form = multipart(parts);
  return client.request("POST", path, { body: form.body, headers: form.headers });
};

const sha256 = (value: string | Uint8Array) => crypto.createHash("sha256").update(value).digest("hex");

interface StoredAttachment {
  size: number;
  content: { data: string };
  filename: string;
  contentType: string;
}
const storedAttachments = async (owner = box): Promise<StoredAttachment[]> =>
  ((await latestMail(server, owner.id)).attachments as StoredAttachment[]).sort((a, b) => a.filename.localeCompare(b.filename));

describe("POST /api/mails/send as multipart — one attachment", () => {
  test("sends the fields and the file to Mailgun, stores the file and records it on the Sent mail", async () => {
    const fresh = await newMailbox(server);
    const { status, text } = await sendForm([...fields(TEXT), file("hello.txt", "hello file")], fresh.client);
    expect(status).toBe(200);
    expect(text).toBe('{"status":"success"}');

    expect(server.mailgun.requests).toHaveLength(1);
    const [request] = server.mailgun.requests;
    expect(request!.fields).toEqual({
      from: [`Al Box <${fresh.address()}>`],
      to: ["friend@remote.example"],
      subject: ["With files"],
      html: ["<p>see attached</p>"],
      text: ["see attached"],
    });
    // The file parts come after the text fields and before any reply header.
    expect(request!.fieldOrder).toEqual(["from", "to", "subject", "html", "text", "attachment"]);
    expect(request!.attachments).toEqual([
      { filename: "hello.txt", contentType: "text/plain;charset=utf-8", size: 10, sha256: sha256("hello file"), text: "hello file" },
    ]);

    const row = await latestMail(server, fresh.id);
    expect(row.attachments).toHaveLength(1);
    const [stored] = row.attachments as StoredAttachment[];
    expect(stored).toEqual({ size: 10, content: { data: stored!.content.data }, filename: "hello.txt", contentType: "text/plain" });
    expect(stored!.content.data).toMatch(UUID);
    expect(fs.readFileSync(attachmentPath(server, stored!.content.data), "utf8")).toBe("hello file");
    expect({ subject: row.subject, sent: row.sent, read: row.read }).toEqual({ subject: "With files", sent: true, read: true });

    // The stored file is served back to its owner, and the body lists it.
    const download = await fresh.client.get(`/api/mails/attachment/${stored!.content.data}`);
    expect(download.text).toBe("hello file");
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
    const body = await fresh.client.get(`/api/mails/body/${row.mail_id}`);
    expect(body.body.body.attachments).toEqual([stored]);
    expect((await box.client.get(`/api/mails/attachment/${stored!.content.data}`)).body).toEqual(failed("Not found"));
  });

  test("binary content arrives and is stored unchanged", async () => {
    const bytes = new Uint8Array(100_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) % 256;
    expect((await sendForm([...fields(TEXT), file("data.bin", bytes, "application/octet-stream")])).body).toEqual(SUCCESS);
    const [sent] = server.mailgun.requests[0]!.attachments;
    expect({ filename: sent!.filename, size: sent!.size, sha256: sent!.sha256 }).toEqual({ filename: "data.bin", size: 100_000, sha256: sha256(bytes) });
    const [stored] = await storedAttachments();
    expect(stored).toMatchObject({ size: 100_000, filename: "data.bin", contentType: "application/octet-stream" });
    expect(sha256(fs.readFileSync(attachmentPath(server, stored!.content.data)))).toBe(sha256(bytes));
  });

  test("an empty file with a name is attached with size 0", async () => {
    expect((await sendForm([...fields(TEXT), file("empty.txt", "")])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.attachments).toMatchObject([{ filename: "empty.txt", size: 0 }]);
    const [stored] = await storedAttachments();
    expect(stored).toMatchObject({ size: 0, filename: "empty.txt", contentType: "text/plain" });
    expect(fs.readFileSync(attachmentPath(server, stored!.content.data)).byteLength).toBe(0);
  });

  test("a reply with an attachment puts the file before the reply headers", async () => {
    await sendForm([...fields({ ...TEXT, inReplyTo: "<orig@x>" }), file("a.txt", "a")]);
    expect(server.mailgun.requests[0]!.fieldOrder).toEqual(["from", "to", "subject", "html", "text", "attachment", "h:In-Reply-To", "h:References"]);
    expect(server.mailgun.requests[0]!.fields["h:References"]).toEqual(["<orig@x>"]);
  });

  test("a part's position in the form does not matter: files first, fields last", async () => {
    expect((await sendForm([file("first.txt", "1"), ...fields(TEXT)])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.fieldOrder).toEqual(["from", "to", "subject", "html", "text", "attachment"]);
  });
});

describe("POST /api/mails/send as multipart — several attachments", () => {
  test("every file is sent in upload order and stored", async () => {
    const fresh = await newMailbox(server);
    const files = [file("a.txt", "aaa"), file("b.bin", new Uint8Array([0, 1, 2, 255]), "application/octet-stream"), file("c.html", "<p>x</p>", "text/html"), file("a.txt", "same name")];
    expect((await sendForm([...fields(TEXT), ...files], fresh.client)).body).toEqual(SUCCESS);
    const [request] = server.mailgun.requests;
    expect(request!.fieldOrder).toEqual(["from", "to", "subject", "html", "text", "attachment", "attachment", "attachment", "attachment"]);
    expect(request!.attachments.map((a) => [a.filename, a.size, a.sha256])).toEqual([
      ["a.txt", 3, sha256("aaa")],
      ["b.bin", 4, sha256(new Uint8Array([0, 1, 2, 255]))],
      ["c.html", 8, sha256("<p>x</p>")],
      ["a.txt", 9, sha256("same name")],
    ]);
    const stored = await storedAttachments(fresh);
    expect(stored.map((a) => [a.filename, a.size, a.contentType]).sort()).toEqual([
      ["a.txt", 3, "text/plain"],
      ["a.txt", 9, "text/plain"],
      ["b.bin", 4, "application/octet-stream"],
      ["c.html", 8, "text/html"],
    ]);
    // Each under its own id.
    expect(new Set(stored.map((a) => a.content.data)).size).toBe(4);
    for (const attachment of stored) {
      expect(fs.statSync(attachmentPath(server, attachment.content.data)).size).toBe(attachment.size);
    }
  });

  test("a mail may carry 20 attachments", async () => {
    const files = Array.from({ length: 20 }, (_, i) => file(`f${String(i).padStart(2, "0")}.txt`, `content ${i}`));
    expect((await sendForm([...fields(TEXT), ...files])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.attachments.map((a) => a.filename)).toEqual(files.map((f) => f.filename!));
    expect((await storedAttachments()).map((a) => a.filename)).toEqual(files.map((f) => f.filename!));
  });

  test("21 or more attachments are refused and nothing is sent or stored", async () => {
    for (const count of [21, 22, 40]) {
      const before = await countMails(server, box.id);
      const files = Array.from({ length: count }, (_, i) => file(`f${i}.txt`, `content ${i}`));
      const { status, text } = await sendForm([...fields(TEXT), ...files]);
      expect({ count, status, text }).toEqual({ count, status: 200, text: '{"status":"failed","message":"A mail may carry at most 20 attachments"}' });
      expect(server.mailgun.requests).toEqual([]);
      expect(await countMails(server, box.id)).toBe(before);
    }
  });

  test("the attachment count is checked before the fields are validated", async () => {
    const files = Array.from({ length: 21 }, (_, i) => file(`f${i}.txt`, "x"));
    expect((await sendForm([{ name: "to", value: "not-an-address" }, ...files])).body).toEqual(failed("A mail may carry at most 20 attachments"));
    expect((await sendForm([{ name: "to", value: "not-an-address" }, ...files.slice(0, 20)])).body).toEqual(failed("Sender is required"));
  });

  test("with outside Bcc only, every per-recipient message carries the attachments", async () => {
    const { to: _to, ...rest } = TEXT;
    expect((await sendForm([...fields({ ...rest, bcc: "b1@remote.example,b2@remote.example" }), file("a.txt", "shared")])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests).toHaveLength(2);
    for (const request of server.mailgun.requests) {
      expect(request.attachments.map((a) => [a.filename, a.sha256])).toEqual([["a.txt", sha256("shared")]]);
    }
    expect(await storedAttachments()).toHaveLength(1);
  });

  test("an internal-only send stores its attachments without calling Mailgun", async () => {
    expect((await sendForm([...fields({ ...TEXT, to: "hello@mail.test" }), file("kept.txt", "kept")])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests).toEqual([]);
    const [stored] = await storedAttachments();
    expect(stored).toMatchObject({ filename: "kept.txt", size: 4 });
    expect(fs.readFileSync(attachmentPath(server, stored!.content.data), "utf8")).toBe("kept");
  });
});

describe("POST /api/mails/send as multipart — file names and types", () => {
  const storedFor = async (part: FormPart) => {
    server.mailgun.reset();
    expect((await sendForm([...fields(TEXT), part])).body).toEqual(SUCCESS);
    const [stored] = await storedAttachments();
    return { stored: stored!, sent: server.mailgun.requests[0]!.attachments[0]! };
  };

  test("the content type is stored lower-cased and without parameters; a part without one is text/plain", async () => {
    expect((await storedFor(file("a.html", "x", "TEXT/HTML; charset=UTF-8"))).stored.contentType).toBe("text/html");
    expect((await storedFor(file("a.pdf", "x", "application/pdf"))).stored.contentType).toBe("application/pdf");
    expect((await storedFor(file("a.x", "x", "application/x-custom+json;v=1"))).stored.contentType).toBe("application/x-custom+json");
    expect((await storedFor(file("a.none", "x", undefined))).stored.contentType).toBe("text/plain");
    expect((await storedFor(file("a.odd", "x", "not a type"))).stored.contentType).toBe("not a type");
  });

  test("any directory part is cut from the file name", async () => {
    const names: [string, string][] = [
      ["../../etc/passwd", "passwd"],
      ["/abs/path/report.pdf", "report.pdf"],
      ["C:\\\\Users\\\\me\\\\doc.txt", "doc.txt"],
      ["dir/sub\\\\mixed.txt", "mixed.txt"],
      ["plain name with spaces.txt", "plain name with spaces.txt"],
      ["ünï cödé 😀.txt", "ünï cödé 😀.txt"],
      [".hidden", ".hidden"],
    ];
    for (const [given, kept] of names) {
      const { stored, sent } = await storedFor(file(given, "x"));
      expect({ given, stored: stored.filename, sent: sent.filename }).toEqual({ given, stored: kept, sent: kept });
    }
  });

  test("a quoted file name may escape characters with a backslash", async () => {
    const { stored } = await storedFor({
      name: "attachments",
      value: "x",
      contentType: "text/plain",
      disposition: 'form-data; name="attachments"; filename="we\\"ird.txt"',
    });
    expect(stored.filename).toBe('we"ird.txt');
    // On the way out a quote in the name is percent-encoded, as browsers do.
    expect(server.mailgun.requests[0]!.attachments[0]!.filename).toBe("we%22ird.txt");
  });

  test("filename* (RFC 5987) wins over filename when it decodes", async () => {
    const extended = await storedFor({
      name: "attachments",
      value: "x",
      contentType: "text/plain",
      disposition: "form-data; name=\"attachments\"; filename=\"fallback.txt\"; filename*=UTF-8''%C3%BCn%C3%AF%20%F0%9F%98%80.txt",
    });
    expect(extended.stored.filename).toBe("ünï 😀.txt");
    const broken = await storedFor({
      name: "attachments",
      value: "x",
      contentType: "text/plain",
      disposition: "form-data; name=\"attachments\"; filename=\"fallback.txt\"; filename*=UTF-8''%E0%A4%A",
    });
    expect(broken.stored.filename).toBe("fallback.txt");
  });

  test("an unquoted file name and parameters in another order are read", async () => {
    const { stored } = await storedFor({
      name: "attachments",
      value: "x",
      contentType: "text/plain",
      disposition: "form-data; filename=unquoted.txt; name=attachments",
    });
    expect(stored.filename).toBe("unquoted.txt");
  });

  test("a file name is cut to 255 characters", async () => {
    const { stored } = await storedFor(file(`${"n".repeat(300)}.txt`, "x"));
    expect(stored.filename).toBe("n".repeat(255));
  });

  test("a file part with an empty name and content is named after its upload", async () => {
    const { stored, sent } = await storedFor(file("", "has content"));
    expect(stored.filename).toMatch(/^upload-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(sent.filename).toBe(stored.filename);
    expect(stored.size).toBe(11);
  });

  test("a file part with an empty name and no content — a file input left blank — is ignored", async () => {
    expect((await sendForm([...fields(TEXT), file("", ""), file("", "")])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.attachments).toEqual([]);
    expect(await storedAttachments()).toEqual([]);
  });
});

describe("POST /api/mails/send as multipart — which parts count", () => {
  test("only file parts named `attachments` are attached", async () => {
    expect(
      (
        await sendForm([
          ...fields(TEXT),
          file("x.txt", "x", "text/plain", "attachment"),
          file("y.txt", "y", "text/plain", "file"),
          file("z.txt", "z", "text/plain", "Attachments"),
          file("w.txt", "w", "text/plain", "attachments[]"),
        ])
      ).body
    ).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.attachments).toEqual([]);
    expect(await storedAttachments()).toEqual([]);
  });

  test("files under other names still count toward the 21 the parser reads", async () => {
    // 21 stray files use up the parser's allowance, so the real attachment after them is dropped silently.
    const stray = Array.from({ length: 21 }, (_, i) => file(`s${i}.txt`, "s", "text/plain", "other"));
    expect((await sendForm([...fields(TEXT), ...stray, file("real.txt", "real")])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.attachments).toEqual([]);
    server.mailgun.reset();
    expect((await sendForm([...fields(TEXT), ...stray.slice(0, 20), file("real.txt", "real")])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.attachments.map((a) => a.filename)).toEqual(["real.txt"]);
  });

  test("a text part named `attachments` is not a file", async () => {
    expect((await sendForm([...fields(TEXT), { name: "attachments", value: "just text" }])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.attachments).toEqual([]);
  });

  test("the text fields go through the same validation as a JSON body", async () => {
    const { sender: _sender, ...withoutSender } = TEXT;
    expect((await sendForm(fields(withoutSender))).body).toEqual(failed("Sender is required"));
    expect((await sendForm(fields({ ...TEXT, sender: "a b" }))).body).toEqual(failed("Invalid sender format"));
    expect((await sendForm(fields({ ...TEXT, to: "nope" }))).body).toEqual(failed("Invalid recipient address: nope"));
    expect((await sendForm(fields({ ...TEXT, to: "" }))).body).toEqual(failed("Recipient email address is required"));
    expect((await sendForm(fields({ ...TEXT, subject: "s".repeat(999) }))).body).toEqual(failed("Subject exceeds maximum length of 998 characters"));
    expect(server.mailgun.requests).toEqual([]);
  });

  test("a text field sent twice becomes a list, which the checks then refuse or flatten", async () => {
    expect((await sendForm([...fields(TEXT), { name: "to", value: "second@remote.example" }])).body).toEqual(failed("Recipient email address is required"));
    expect((await sendForm([...fields(TEXT), { name: "sender", value: "other" }])).body).toEqual(failed("Sender is required"));
    expect((await sendForm([...fields(TEXT), { name: "subject", value: "Second subject" }])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.fields.subject).toEqual(["With files", "Second subject"]);
  });

  test("`references` and prototype-polluting field names are dropped", async () => {
    expect(
      (
        await sendForm([
          ...fields(TEXT),
          { name: "references", value: "<planted@x>" },
          { name: "__proto__", value: "x" },
          { name: "constructor", value: "y" },
          { name: "prototype", value: "z" },
        ])
      ).body
    ).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.fieldOrder).toEqual(["from", "to", "subject", "html", "text"]);
  });

  test("parts without a name or that are not form-data are skipped", async () => {
    expect(
      (
        await sendForm([
          ...fields(TEXT),
          { name: "x", value: "skipped", disposition: "form-data" },
          { name: "x", value: "skipped", disposition: 'attachment; name="attachments"; filename="nope.txt"' },
          { name: "x", value: "skipped", disposition: 'inline; name="to"' },
        ])
      ).body
    ).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.fields.to).toEqual(["friend@remote.example"]);
    expect(server.mailgun.requests[0]!.attachments).toEqual([]);
  });

  test("unicode in text fields survives", async () => {
    expect((await sendForm(fields({ ...TEXT, subject: "Ünï 😀 日本語", senderFullName: "Näme", html: "<p>Ünï 😀</p>" }))).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.fields).toMatchObject({ subject: ["Ünï 😀 日本語"], html: ["<p>Ünï 😀</p>"], text: ["Ünï 😀"] });
    expect(server.mailgun.requests[0]!.fields.from).toEqual([`Näme <${box.address()}>`]);
  });

  test("a text field longer than 1 MiB arrives whole", async () => {
    const html = `<p>${"ü".repeat(MIB)}</p>`;
    expect((await sendForm(fields({ ...TEXT, html }))).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.fields.html).toEqual([html]);
    const row = await latestMail(server, box.id);
    expect(row.html).toBe(html);
  });

  test("a text field over 10 MiB is a 413 with its message; nothing is sent or stored", async () => {
    const before = await countMails(server, box.id);
    const { status, body } = await sendForm(fields({ ...TEXT, html: "x".repeat(10 * MIB + 1) }));
    expect(status).toBe(413);
    expect(body).toEqual(failed("Each form field must be at most 10MB"));
    expect(server.mailgun.requests).toEqual([]);
    expect(await countMails(server, box.id)).toBe(before);
  });
});

describe("POST /api/mails/send as multipart — size limits", () => {
  test("a file of 25 MiB minus one byte is accepted", async () => {
    const bytes = new Uint8Array(25 * MIB - 1);
    bytes[0] = 7;
    bytes[bytes.length - 1] = 9;
    const before = await countMails(server, box.id);
    expect((await sendForm([...fields(TEXT), file("under.bin", bytes, "application/octet-stream")])).body).toEqual(SUCCESS);
    expect(server.mailgun.requests[0]!.attachments).toMatchObject([{ filename: "under.bin", size: 25 * MIB - 1, sha256: sha256(bytes) }]);
    expect(await countMails(server, box.id)).toBe(before + 1);
    expect((await storedAttachments())[0]).toMatchObject({ size: 25 * MIB - 1, filename: "under.bin" });
  }, 120_000);

  test("a file of exactly 25 MiB is a 413 with its message; nothing is sent or stored", async () => {
    const before = await countMails(server, box.id);
    const { status, text, headers } = await sendForm([
      ...fields(TEXT),
      file("small.txt", "small"),
      file("exact.bin", new Uint8Array(25 * MIB), "application/octet-stream"),
    ]);
    expect(status).toBe(413);
    expect(text).toBe('{"status":"failed","message":"Each attachment must be smaller than 25MB"}');
    expect(headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(server.mailgun.requests).toEqual([]);
    expect(await countMails(server, box.id)).toBe(before);
    // The server keeps answering.
    expect((await sendForm(fields(TEXT))).body).toEqual(SUCCESS);
  }, 120_000);

  test("an oversized file is a 413 even when the rest of the request would be refused", async () => {
    const { status, body } = await sendForm([{ name: "to", value: "nope" }, file("big.bin", new Uint8Array(25 * MIB + 5), "application/octet-stream")]);
    expect(status).toBe(413);
    expect(body).toEqual(failed("Each attachment must be smaller than 25MB"));
  }, 120_000);

  // NOTE: files that each fit the per-file limit can together exceed what the
  // server will post to Mailgun (50 MiB). That is answered with the internal
  // error code as the user-facing message.
  test("attachments over 50 MiB in total are refused with a raw error code", async () => {
    const before = await countMails(server, box.id);
    const { status, body } = await sendForm([
      ...fields(TEXT),
      file("a.bin", new Uint8Array(24 * MIB), "application/octet-stream"),
      file("b.bin", new Uint8Array(24 * MIB), "application/octet-stream"),
      file("c.bin", new Uint8Array(3 * MIB), "application/octet-stream"),
    ]);
    expect(status).toBe(200);
    expect(body).toEqual(failed("ERR_FR_MAX_BODY_LENGTH_EXCEEDED"));
    expect(server.mailgun.requests).toEqual([]);
    expect(await countMails(server, box.id)).toBe(before);
  }, 120_000);
});

describe("POST /api/mails/send as multipart — the limit on the whole body", () => {
  // Every file the parser keeps at full size, plus 64 MiB for the rest.
  const MAX_REQUEST_BODY_SIZE = 21 * 25 * MIB + 64 * MIB;

  /** The status line of what the server answers to `head` followed by `body`, written as the server takes it. */
  const statusFor = (head: string, body: Iterable<Uint8Array> = []) =>
    new Promise<string>((resolve) => {
      const socket = net.createConnection({ port: server.ports.http, host: "127.0.0.1" });
      let received = "";
      const done = () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1] ?? `no answer: ${received.slice(0, 80)}`);
      };
      const timer = setTimeout(done, 60_000);
      socket.on("error", () => undefined);
      socket.on("close", done);
      socket.on("data", (chunk) => {
        received += chunk.toString("latin1");
        if (/\r\n\r\n/.test(received)) done();
      });
      socket.on("connect", async () => {
        socket.write(head);
        for (const piece of body) {
          if (socket.destroyed || received) return;
          if (!socket.write(piece)) await new Promise((drained) => socket.once("drain", drained));
        }
      });
    });

  test("a declared length over the limit is refused with 413 before the body arrives", async () => {
    const head = (cookie: string) =>
      `POST /api/mails/send HTTP/1.1\r\nHost: localhost\r\n${cookie}Content-Type: multipart/form-data; boundary=b\r\n` +
      `Content-Length: ${MAX_REQUEST_BODY_SIZE + 1}\r\n\r\n--b\r\n`;
    expect(await statusFor(head(`Cookie: ${box.client.cookieHeader()}\r\n`))).toBe("413");
    expect(await statusFor(head(""))).toBe("413");
    expect(server.mailgun.requests).toEqual([]);
  }, 120_000);

  test("a body streamed past the limit is refused with 413, however little of it the parser keeps", async () => {
    // Parts that are not form data are read and thrown away, so only the
    // limit on the whole body can stop this one.
    const piece = Buffer.concat([
      Buffer.from("--b\r\nContent-Disposition: attachment\r\n\r\n"),
      Buffer.alloc(8 * MIB, 0x61),
      Buffer.from("\r\n"),
    ]);
    const chunk = Buffer.concat([Buffer.from(`${piece.length.toString(16)}\r\n`), piece, Buffer.from("\r\n")]);
    function* body() {
      for (let sent = 0; sent <= MAX_REQUEST_BODY_SIZE; sent += piece.length) yield chunk;
      const end = Buffer.from("--b--\r\n");
      yield Buffer.concat([Buffer.from(`${end.length.toString(16)}\r\n`), end, Buffer.from("\r\n0\r\n\r\n")]);
    }
    const head =
      `POST /api/mails/send HTTP/1.1\r\nHost: localhost\r\nCookie: ${box.client.cookieHeader()}\r\n` +
      "Content-Type: multipart/form-data; boundary=b\r\nTransfer-Encoding: chunked\r\n\r\n";
    expect(await statusFor(head, body())).toBe("413");
    expect(server.mailgun.requests).toEqual([]);
    // The server keeps answering.
    expect((await sendForm(fields(TEXT))).body).toEqual(SUCCESS);
  }, 120_000);
});

describe("POST /api/mails/send as multipart — malformed and misplaced bodies", () => {
  test("a body that ends before its closing boundary is a 400", async () => {
    const { status, body } = await box.client.request("POST", "/api/mails/send", {
      body: '--abc\r\nContent-Disposition: form-data; name="sender"\r\n\r\nbox',
      headers: { "Content-Type": "multipart/form-data; boundary=abc" },
    });
    expect(status).toBe(400);
    expect(body).toEqual(BAD_REQUEST);
    const noBoundaryInBody = await box.client.request("POST", "/api/mails/send", {
      body: "no boundary anywhere",
      headers: { "Content-Type": "multipart/form-data; boundary=abc" },
    });
    expect(noBoundaryInBody.status).toBe(400);
    expect(server.mailgun.requests).toEqual([]);
  });

  test("a part header line over 16 KiB, or more than 64 header lines in a part, is a 400", async () => {
    const longLine = await sendForm([...fields(TEXT), file("n".repeat(17_000), "x")]);
    expect(longLine.status).toBe(400);
    expect(longLine.body).toEqual(BAD_REQUEST);
    const justUnder = await sendForm([...fields(TEXT), file("n".repeat(15_000), "x")]);
    expect(justUnder.body).toEqual(SUCCESS);

    const boundary = "many-headers";
    const part = (headerCount: number) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="sender"\r\n` +
      Array.from({ length: headerCount - 1 }, (_, i) => `X-Extra-${i}: v\r\n`).join("") +
      `\r\nbox\r\n--${boundary}--\r\n`;
    const post = (body: string) =>
      box.client.request("POST", "/api/mails/send", { body, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });
    const tooMany = await post(part(66));
    expect(tooMany.status).toBe(400);
    expect(tooMany.body).toEqual(BAD_REQUEST);
    // 64 header lines are read: the request then fails only for its missing recipient.
    expect((await post(part(64))).body).toEqual(failed("Recipient email address is required"));
  });

  test("multipart without a boundary parameter, or with an empty body, is treated as no body", async () => {
    for (const [label, options] of [
      ["no boundary", { body: "x", headers: { "Content-Type": "multipart/form-data" } }],
      ["empty body", { body: "", headers: { "Content-Type": "multipart/form-data; boundary=abc" } }],
    ] as const) {
      const { status, body } = await box.client.request("POST", "/api/mails/send", options);
      expect({ label, status, body }).toEqual({ label, status: 200, body: failed("Sender is required") });
    }
  });

  test("an empty form is a send with no fields", async () => {
    expect((await sendForm([])).body).toEqual(failed("Sender is required"));
  });

  test("a quoted boundary and other multipart subtypes are read", async () => {
    const form = multipart(fields(TEXT), "quoted-boundary");
    const quoted = await box.client.request("POST", "/api/mails/send", {
      body: form.body,
      headers: { "Content-Type": 'multipart/form-data; boundary="quoted-boundary"' },
    });
    expect(quoted.body).toEqual(SUCCESS);
    const mixed = await box.client.request("POST", "/api/mails/send", {
      body: form.body,
      headers: { "Content-Type": "multipart/mixed; boundary=quoted-boundary" },
    });
    expect(mixed.body).toEqual(SUCCESS);
  });

  test("the route answers multipart in upper case and with a trailing slash; other methods and longer paths are 404", async () => {
    expect((await sendForm(fields(TEXT), box.client, "/api/mails/SEND/")).body).toEqual(SUCCESS);
    expect((await sendForm(fields(TEXT), box.client, "/api/mails/send/extra")).status).toBe(404);
    const form = multipart(fields(TEXT));
    expect((await box.client.request("PUT", "/api/mails/send", { body: form.body, headers: form.headers })).status).toBe(404);
  });

  test("without a session a multipart send is a 401 and nothing is read", async () => {
    const anon = server.client();
    const { status, body } = await sendForm([...fields(TEXT), file("a.txt", "a")], anon);
    expect(status).toBe(401);
    expect(body).toEqual(NOT_LOGGED_IN);
    // Even a malformed or oversized body is a plain 401.
    const malformed = await anon.request("POST", "/api/mails/send", { body: "--abc\r\nbroken", headers: { "Content-Type": "multipart/form-data; boundary=abc" } });
    expect(malformed.status).toBe(401);
    expect(server.mailgun.requests).toEqual([]);
  });
});
