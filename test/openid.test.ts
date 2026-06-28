import { describe, expect, it } from "vitest";
import { parseOpenidForm } from "../src/community/openid.js";

const INTERSTITIAL = `
<html><body>
<form id="openidForm" action="https://steamcommunity.com/openid/login" method="POST">
  <input type="hidden" name="action" value="steam_openid_login">
  <input type="hidden" name="openid.mode" value="checkid_setup">
  <input type="hidden" name="openid.return_to" value="https://csgoempire.com/login?a=1&amp;b=2">
  <input type="hidden" name="openid.realm" value="https://csgoempire.com">
  <input type="hidden" name="nonce" value="abc123">
</form>
</body></html>`;

describe("parseOpenidForm", () => {
  it("parses the openid form action and fields, decoding &amp;", () => {
    const form = parseOpenidForm(INTERSTITIAL);
    expect(form).not.toBeNull();
    expect(form?.action).toBe("https://steamcommunity.com/openid/login");
    const byName = Object.fromEntries((form?.fields ?? []).map((f) => [f.name, f.value]));
    expect(byName["openid.mode"]).toBe("checkid_setup");
    expect(byName["openid.return_to"]).toBe("https://csgoempire.com/login?a=1&b=2");
    expect(form?.fields).toHaveLength(5);
  });

  it("picks the openid form out of a page with multiple forms", () => {
    const html = `<form action="/search"><input name="q" value="x"></form>${INTERSTITIAL}`;
    expect(parseOpenidForm(html)?.action).toBe("https://steamcommunity.com/openid/login");
  });

  it("resolves a relative form action against the steam openid endpoint", () => {
    const html = INTERSTITIAL.replace("https://steamcommunity.com/openid/login", "/openid/login");
    expect(parseOpenidForm(html)?.action).toBe("https://steamcommunity.com/openid/login");
  });

  it("returns null when there is no openid form (unauthenticated / sign-in page)", () => {
    expect(parseOpenidForm("<html><body><form action='/login'></form></body></html>")).toBeNull();
  });
});
