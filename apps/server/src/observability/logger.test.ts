import { Writable } from "node:stream";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { loggerOptions } from "./logger.js";

describe("logger redaction", () => {
  it("redacts auth secrets and credentials", () => {
    let line = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        line += chunk.toString();
        callback();
      }
    });
    const logger = pino(loggerOptions, stream);
    logger.info({ req: { headers: { authorization: "Bearer secret", cookie: "sid=secret" } }, password: "p", accessToken: "a", refreshToken: "r", token: "t" }, "redaction test");
    expect(line).toContain("[REDACTED]");
    expect(line).not.toContain("Bearer secret");
    expect(line).not.toContain("sid=secret");
    expect(line).not.toContain('"password":"p"');
    expect(line).not.toContain('"accessToken":"a"');
    expect(line).not.toContain('"refreshToken":"r"');
    expect(line).not.toContain('"token":"t"');
  });
});
