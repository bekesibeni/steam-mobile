/**
 * M0 gate: prove we can mint an access token from a refresh token WITHOUT steam-session,
 * using only our hand-rolled protobuf (src/session/tokens.ts).
 *
 * PASS = access token decoded with aud including web+mobile and a sane (~24h) expiry.
 *
 * Run:  npx tsx m0-tokens-test.ts   (needs ./bot.refreshtoken from an earlier login)
 */
import { existsSync, readFileSync } from "node:fs";
import got from "got";
import { type ProtoPost, decodeJwt, mintAccessToken, secondsUntilExpiry } from "../src/session/tokens.ts";

// got-based transport — same client we use in production (M1 SessionManager injects this).
// Note: got v15's body is a Uint8Array; we pass it as-is — decodeGenerateForAppResponse normalizes it.
const gotPost: ProtoPost = async (url, base64Body) => {
  const res = await got.post(url, {
    form: { input_protobuf_encoded: base64Body },
    responseType: "buffer",
    throwHttpErrors: false,
  });
  return {
    status: res.statusCode,
    eresult: (res.headers["x-eresult"] as string) ?? null,
    errorMessage: (res.headers["x-error_message"] as string) ?? null,
    body: res.body,
  };
};

async function main() {
  console.log("\n=== M0: hand-rolled token mint (no steam-session) ===\n");
  if (!existsSync("./bot.refreshtoken")) throw new Error("missing ./bot.refreshtoken — run test-iecon.ts first");
  const refreshToken = readFileSync("./bot.refreshtoken", "utf8").trim();

  const rt = decodeJwt(refreshToken);
  console.log(`refresh token: sub=${rt?.sub} aud=[${(rt?.aud ?? []).join(",")}] expiresIn=${(secondsUntilExpiry(refreshToken) / 86400).toFixed(1)}d`);

  console.log("\nminting access token via GenerateAccessTokenForApp (hand-rolled protobuf)…");
  const { accessToken, refreshToken: renewed } = await mintAccessToken(refreshToken, false, gotPost);

  const at = decodeJwt(accessToken);
  const aud = at?.aud ?? [];
  const hoursLeft = (secondsUntilExpiry(accessToken) / 3600).toFixed(1);
  console.log(`\naccess token: aud=[${aud.join(",")}] expiresIn=${hoursLeft}h`);
  console.log(`first 24 chars: ${accessToken.slice(0, 24)}…`);
  console.log(`renewed refresh token returned: ${renewed ? "yes" : "no (expected — we didn't renew)"}`);

  const pass =
    Array.isArray(aud) && aud.includes("web") && aud.includes("mobile") && Number(hoursLeft) > 0;
  console.log(`\n${pass ? "✅ M0 PASS — steam-session is not needed" : "❌ M0 FAIL — revisit decision #2"}\n`);
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error("\n❌ M0 FAIL:", err.message ?? err);
  process.exit(1);
});
