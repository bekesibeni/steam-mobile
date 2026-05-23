import { Buffer } from "node:buffer";
import type { HttpClient, HttpResponse } from "../http/HttpClient.js";

export interface ProtoResult {
  status: number;
  eresult: string | null;
  errorMessage: string | null;
  body: Buffer | Uint8Array;
}

export interface ProtoRequest {
  url: string;
  method: "GET" | "POST";
  body?: Uint8Array;
  accessToken?: string;
  multipart?: boolean;
  origin?: boolean;
  spoofSteamid?: string;
}

export type ProtoTransport = (req: ProtoRequest) => Promise<ProtoResult>;

export type ProtoPost = (
  url: string,
  base64Body: string,
  accessToken?: string,
) => Promise<ProtoResult>;

export function createProtoTransport(http: HttpClient): ProtoTransport {
  return async (req) => {
    const base64 = req.body && req.body.length > 0 ? Buffer.from(req.body).toString("base64") : "";
    const searchParams: Record<string, string> = {};
    if (req.accessToken) {
      searchParams.access_token = req.accessToken;
      searchParams.spoof_steamid = req.spoofSteamid ?? "";
    }
    if (req.origin) searchParams.origin = "SteamMobile";

    let res: HttpResponse<Buffer | Uint8Array>;
    if (req.method === "GET") {
      // Must be present even when empty, or Steam replies in JSON instead of protobuf.
      searchParams.input_protobuf_encoded = base64;
      res = await http.get<Buffer | Uint8Array>(req.url, { responseType: "buffer", searchParams });
    } else {
      const bodyOpt = req.multipart
        ? { multipart: [{ name: "input_protobuf_encoded", value: base64 }] }
        : { form: { input_protobuf_encoded: base64 } };
      res = await http.post<Buffer | Uint8Array>(req.url, {
        responseType: "buffer",
        ...(Object.keys(searchParams).length > 0 ? { searchParams } : {}),
        ...bodyOpt,
      });
    }

    return {
      status: res.statusCode,
      eresult: headerValue(res.headers["x-eresult"]) ?? null,
      errorMessage: headerValue(res.headers["x-error_message"]) ?? null,
      body: res.body,
    };
  };
}

// The mint keeps its urlencoded-form POST shape.
export function createProtoPost(http: HttpClient): ProtoPost {
  const transport = createProtoTransport(http);
  return (url, base64Body, accessToken) =>
    transport({
      url,
      method: "POST",
      body: Buffer.from(base64Body, "base64"),
      ...(accessToken ? { accessToken } : {}),
    });
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}
