import { URLS } from "../core/constants.js";
import { httpError } from "../http/checkers.js";
import type { HttpClient } from "../http/HttpClient.js";

// 2025 trade-protection notice; Steam blocks send() until it's acknowledged once. Plain community POST
// — no mobileconf, no identitySecret. Idempotent on the server side.
export async function acknowledgeTradeProtection(http: HttpClient): Promise<void> {
  const sessionid = await http.getSessionId();
  const res = await http.post<unknown>(`${URLS.community}/trade/new/acknowledge`, {
    form: { sessionid, message: 1 },
  });
  if (res.statusCode !== 200) throw httpError(res);
}
