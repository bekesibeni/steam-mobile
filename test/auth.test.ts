import { Buffer } from "node:buffer";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { AuthClient } from "../src/auth/AuthClient.js";
import { LoginError } from "../src/core/errors.js";
import type { HttpClient } from "../src/http/HttpClient.js";
import {
  CAuthentication_BeginAuthSessionViaCredentials_RequestSchema as BeginReq,
  CAuthentication_BeginAuthSessionViaCredentials_ResponseSchema as BeginRes,
  CAuthentication_GetAuthSessionsForAccount_ResponseSchema as GetSessRes,
  CAuthentication_RefreshToken_Revoke_ResponseSchema as RevokeRes,
  CAuthentication_GetPasswordRSAPublicKey_RequestSchema as RsaReq,
  CAuthentication_GetPasswordRSAPublicKey_ResponseSchema as RsaRes,
} from "../src/protobufs/steammessages_auth_pb.js";

interface Call {
  method: "GET" | "POST";
  url: string;
  searchParams: Record<string, unknown> | undefined;
  multipart: { name: string; value: string }[] | undefined;
}

class FakeHttp {
  calls: Call[] = [];
  eresult = "1";
  private body: Uint8Array = new Uint8Array();

  setBody(b: Uint8Array): void {
    this.body = b;
  }

  async get(url: string, opts: { searchParams?: Record<string, unknown> }) {
    this.calls.push({ method: "GET", url, searchParams: opts.searchParams, multipart: undefined });
    return this.respond();
  }

  async post(
    url: string,
    opts: { searchParams?: Record<string, unknown>; multipart?: { name: string; value: string }[] },
  ) {
    this.calls.push({
      method: "POST",
      url,
      searchParams: opts.searchParams,
      multipart: opts.multipart,
    });
    return this.respond();
  }

  private respond() {
    return { statusCode: 200, headers: { "x-eresult": this.eresult }, body: this.body };
  }
}

function client(http: FakeHttp): AuthClient {
  return new AuthClient(http as unknown as HttpClient);
}

describe("AuthClient wire format", () => {
  it("GETs GetPasswordRSAPublicKey with payload + origin in the query, no access_token", async () => {
    const http = new FakeHttp();
    http.setBody(
      toBinary(
        RsaRes,
        create(RsaRes, { publickeyMod: "ab", publickeyExp: "010001", timestamp: 7n }),
      ),
    );

    const res = await client(http).getPasswordRSAPublicKey("bob");

    const call = http.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url).toBe(
      "https://api.steampowered.com/IAuthenticationService/GetPasswordRSAPublicKey/v1",
    );
    expect(call.searchParams!.origin).toBe("SteamMobile");
    expect(call.searchParams!.access_token).toBeUndefined();
    expect(call.searchParams!.spoof_steamid).toBeUndefined(); // unauthenticated → no spoof_steamid
    const decodedReq = fromBinary(
      RsaReq,
      new Uint8Array(Buffer.from(String(call.searchParams!.input_protobuf_encoded), "base64")),
    );
    expect(decodedReq.accountName).toBe("bob");
    expect(res.publickeyExp).toBe("010001");
    expect(res.timestamp).toBe(7n);
  });

  it("POSTs BeginAuthSessionViaCredentials as multipart input_protobuf_encoded, no origin", async () => {
    const http = new FakeHttp();
    http.setBody(toBinary(BeginRes, create(BeginRes, { clientId: 42n })));

    await client(http).beginAuthSessionViaCredentials({ accountName: "bob", websiteId: "Mobile" });

    const call = http.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.multipart?.[0]?.name).toBe("input_protobuf_encoded");
    expect(call.searchParams?.origin).toBeUndefined();
    const decodedReq = fromBinary(
      BeginReq,
      new Uint8Array(Buffer.from(String(call.multipart![0]!.value), "base64")),
    );
    expect(decodedReq.accountName).toBe("bob");
    expect(decodedReq.websiteId).toBe("Mobile");
  });

  it("GETs GetAuthSessionsForAccount with access_token + origin and an (empty) payload present", async () => {
    const http = new FakeHttp();
    http.setBody(toBinary(GetSessRes, create(GetSessRes, { clientIds: [1n, 2n] })));

    const res = await client(http).getAuthSessionsForAccount("ACCESS");

    const call = http.calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.searchParams!.access_token).toBe("ACCESS");
    expect(call.searchParams!.origin).toBe("SteamMobile");
    expect(call.searchParams!.spoof_steamid).toBe(""); // iOS sends it empty
    // present even though the request is empty (else Steam answers in JSON, not protobuf)
    expect(call.searchParams!.input_protobuf_encoded).toBe("");
    expect(res.clientIds).toEqual([1n, 2n]);
  });

  it("POSTs RevokeRefreshToken as multipart with access_token in the query", async () => {
    const http = new FakeHttp();
    http.setBody(toBinary(RevokeRes, create(RevokeRes, {})));

    await client(http).revokeRefreshToken("ACCESS", 0);

    const call = http.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.searchParams!.access_token).toBe("ACCESS");
    expect(call.searchParams!.spoof_steamid).toBe(""); // authenticated → empty spoof_steamid too
    expect(call.multipart?.[0]?.name).toBe("input_protobuf_encoded");
  });

  it("throws LoginError on a non-OK eresult", async () => {
    const http = new FakeHttp();
    http.eresult = "5"; // InvalidPassword
    await expect(client(http).getPasswordRSAPublicKey("bob")).rejects.toBeInstanceOf(LoginError);
  });
});
