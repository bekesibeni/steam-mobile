import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import type { HttpResponse } from "../src/http/HttpClient.js";
import { SteamMobile } from "../src/SteamMobile.js";

const STEAMID = "76561198123456789";
const nowS = () => Math.floor(Date.now() / 1000);

function makeToken(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `eyJhbGciOiJFUzI1NiJ9.${body}.signature`;
}
const refreshToken = makeToken({ sub: STEAMID, exp: nowS() + 200 * 86_400 });

function makeBot() {
  const bot = new SteamMobile({ refreshToken });
  const getToken = vi.spyOn(bot.session, "getAccessToken").mockResolvedValue("tok");
  const httpReq = vi
    .spyOn(bot.http, "request")
    .mockResolvedValue({ statusCode: 200, headers: {}, body: "ok" } as HttpResponse);
  return { bot, getToken, httpReq };
}

describe("SteamMobile custom requests", () => {
  it("ensures the session before delegating to http", async () => {
    const { bot, getToken, httpReq } = makeBot();

    const res = await bot.get("https://steamcommunity.com/x", { searchParams: { a: 1 } });

    expect(getToken).toHaveBeenCalledOnce();
    expect(httpReq).toHaveBeenCalledWith("GET", "https://steamcommunity.com/x", {
      searchParams: { a: 1 },
    });
    expect(res.body).toBe("ok");
    // session must be live before the request fires
    expect(getToken.mock.invocationCallOrder[0]!).toBeLessThan(
      httpReq.mock.invocationCallOrder[0]!,
    );
  });

  it("post forwards method, json body, and opts unchanged", async () => {
    const { bot, httpReq } = makeBot();

    await bot.post("https://steamcommunity.com/y", { json: { hello: "world" } });

    expect(httpReq).toHaveBeenCalledWith("POST", "https://steamcommunity.com/y", {
      json: { hello: "world" },
    });
  });

  it("does not fire the request when the session can't be renewed", async () => {
    const bot = new SteamMobile({ refreshToken });
    vi.spyOn(bot.session, "getAccessToken").mockRejectedValue(new Error("dead"));
    const httpReq = vi.spyOn(bot.http, "request");

    await expect(bot.get("https://steamcommunity.com/x")).rejects.toThrow("dead");
    expect(httpReq).not.toHaveBeenCalled();
  });
});
