import { describe, it, expect } from "bun:test";

import {
  isSecureRequest,
  parseQuery,
  readJsonBody,
  requestTarget,
  resolveClientIp,
  trustLoopbackAndPrivate,
  trustNoProxy,
} from "./request";

describe("trustLoopbackAndPrivate", () => {
  it("trusts loopback and the private ranges, edges included", () => {
    const trusted = [
      "127.0.0.1",
      "127.255.255.255",
      "::ffff:127.0.0.1",
      "10.0.0.0",
      "10.255.255.255",
      "172.16.0.0",
      "172.31.255.255",
      "192.168.0.0",
      "192.168.255.255",
      "::1",
      "fc00::1",
      "fdff:ffff::1"
    ];
    expect(trusted.filter((address) => !trustLoopbackAndPrivate(address))).toEqual([]);
  });

  it("refuses the addresses just outside each range, and non-addresses", () => {
    const untrusted = [
      "126.255.255.255",
      "128.0.0.0",
      "9.255.255.255",
      "11.0.0.0",
      "172.15.255.255",
      "172.32.0.0",
      "192.167.255.255",
      "192.169.0.0",
      "100.64.0.1",
      "::ffff:8.8.8.8",
      "::2",
      "fbff:ffff::1",
      "fe00::1",
      "fe80::1",
      "",
      "localhost"
    ];
    expect(untrusted.filter((address) => trustLoopbackAndPrivate(address))).toEqual([]);
  });
});

describe("resolveClientIp", () => {
  const trust = trustLoopbackAndPrivate;

  it("answers with an untrusted peer's own address whatever it forwards", () => {
    expect(resolveClientIp("198.51.100.66", "203.0.113.1", trust)).toBe("198.51.100.66");
    expect(resolveClientIp("fe80::1", "203.0.113.1, 10.0.0.1", trust)).toBe("fe80::1");
  });

  it("takes the forwarded client when the peer is the proxy", () => {
    expect(resolveClientIp("172.20.0.2", "203.0.113.9", trust)).toBe("203.0.113.9");
    expect(resolveClientIp("::ffff:127.0.0.1", "203.0.113.9", trust)).toBe("203.0.113.9");
  });

  it("walks back through trusted hops and stops at the first untrusted one", () => {
    // A client-supplied left-hand entry cannot pass for the client: the
    // nearest untrusted hop is the answer.
    expect(resolveClientIp("127.0.0.1", "1.1.1.1, 203.0.113.9, 10.0.0.5", trust)).toBe("203.0.113.9");
    expect(resolveClientIp("127.0.0.1", " 203.0.113.9 ,, 10.0.0.5 ", trust)).toBe("203.0.113.9");
  });

  it("answers with the farthest hop when every hop is trusted", () => {
    expect(resolveClientIp("127.0.0.1", "10.0.0.7, 10.0.0.5", trust)).toBe("10.0.0.7");
  });

  it("answers with the peer when there is nothing forwarded", () => {
    expect(resolveClientIp("127.0.0.1", null, trust)).toBe("127.0.0.1");
    expect(resolveClientIp("172.20.0.2", "", trust)).toBe("172.20.0.2");
  });

  it("never believes a forwarding header outside production", () => {
    expect(resolveClientIp("127.0.0.1", "203.0.113.9", trustNoProxy)).toBe("127.0.0.1");
  });
});

describe("isSecureRequest", () => {
  it("honours X-Forwarded-Proto from the proxy and ignores it from an untrusted peer", () => {
    expect(isSecureRequest("172.20.0.2", "https", trustLoopbackAndPrivate)).toBe(true);
    expect(isSecureRequest("172.20.0.2", "https, http", trustLoopbackAndPrivate)).toBe(true);
    expect(isSecureRequest("172.20.0.2", null, trustLoopbackAndPrivate)).toBe(false);
    expect(isSecureRequest("172.20.0.2", "http", trustLoopbackAndPrivate)).toBe(false);
    expect(isSecureRequest("198.51.100.66", "https", trustLoopbackAndPrivate)).toBe(false);
    expect(isSecureRequest("127.0.0.1", "https", trustNoProxy)).toBe(false);
  });
});

describe("requestTarget", () => {
  const target = (url: string) => requestTarget({ url } as Request);

  it("splits path and query exactly as sent, with no normalization", () => {
    expect(target("http://localhost/a//b/../c?x=1&y")).toEqual({ pathname: "/a//b/../c", search: "?x=1&y" });
    expect(target("http://[fe80::1%lo0]:3004/api/ping")).toEqual({ pathname: "/api/ping", search: "" });
  });

  it("does not depend on the Host header being a valid authority", () => {
    expect(target("//api/users/login?x")).toEqual({ pathname: "//api/users/login", search: "?x" });
    expect(target("http://localhost")).toEqual({ pathname: "/", search: "" });
  });
});

describe("parseQuery", () => {
  it("collects a repeated key into an array and keeps a bare key as empty", () => {
    expect(parseQuery(new URLSearchParams("a=1&a=2&b=x+y&c"))).toEqual({ a: ["1", "2"], b: "x y", c: "" });
  });
});

describe("readJsonBody", () => {
  const post = (body: BodyInit | null, headers: Record<string, string> = { "Content-Type": "application/json" }) =>
    readJsonBody(new Request("http://localhost/", { method: "POST", headers, body }));

  it("parses an object or array", async () => {
    expect(await post('{"a":1}')).toEqual({ a: 1 });
    expect(await post("[1,2]")).toEqual([1, 2]);
    expect(await post('﻿  {"bom":true}')).toEqual({ bom: true });
  });

  it("answers {} for a request that carries no JSON", async () => {
    expect(await post(null)).toEqual({});
    expect(await post("")).toEqual({});
    expect(await post('{"a":1}', { "Content-Type": "text/plain" })).toEqual({});
    expect(await post("a=1", { "Content-Type": "application/x-www-form-urlencoded" })).toEqual({});
  });

  it("refuses malformed JSON and a top-level scalar with 400", async () => {
    await expect(post("{ not json")).rejects.toMatchObject({ status: 400 });
    await expect(post("123")).rejects.toMatchObject({ status: 400 });
    await expect(post('"text"')).rejects.toMatchObject({ status: 400 });
  });

  it("refuses a body over 10 MiB with 413", async () => {
    await expect(post(`{"a":"${"x".repeat(10 * 1024 * 1024)}"}`)).rejects.toMatchObject({ status: 413 });
  });

  it("refuses a non-UTF charset and an unknown encoding with 415", async () => {
    await expect(post("{}", { "Content-Type": "application/json; charset=latin1" })).rejects.toMatchObject({
      status: 415,
    });
    await expect(
      post("{}", { "Content-Type": "application/json", "Content-Encoding": "br" })
    ).rejects.toMatchObject({ status: 415 });
  });

  it("inflates a gzip body", async () => {
    const gzipped = Bun.gzipSync(new TextEncoder().encode('{"zipped":true}'));
    expect(await post(gzipped, { "Content-Type": "application/json", "Content-Encoding": "gzip" })).toEqual({
      zipped: true,
    });
  });
});
