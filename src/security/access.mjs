import { createHash, createPublicKey, verify } from "node:crypto";
const decode = (part) =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
// Validates the Cloudflare Access token that the edge attaches to each request.
export function accessVerifier(
  { teamDomain, audience, emailHash },
  fetchKeys = async () => {
    const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok)
      throw new Error(`Access keys returned HTTP ${response.status}`);
    return (await response.json()).keys;
  },
) {
  const issuer = "https://" + teamDomain;
  let keys = new Map(),
    loadedAt = 0;
  const publicKey = async (kid) => {
    // Access rotates its signing keys; an unknown ID refetches at most once a minute.
    if (!keys.has(kid) && Date.now() - loadedAt > 60000) {
      keys = new Map(
        (await fetchKeys()).map((jwk) => [
          jwk.kid,
          createPublicKey({ key: jwk, format: "jwk" }),
        ]),
      );
      loadedAt = Date.now();
    }
    return keys.get(kid);
  };
  return async (token) => {
    try {
      const [head, payload, signature, ...rest] = String(token ?? "").split(
        ".",
      );
      if (!signature || rest.length) return false;
      const header = decode(head);
      if (header.alg !== "RS256" || typeof header.kid !== "string")
        return false;
      const key = await publicKey(header.kid);
      if (
        !key ||
        !verify(
          "RSA-SHA256",
          Buffer.from(head + "." + payload),
          key,
          Buffer.from(signature, "base64url"),
        )
      )
        return false;
      const claims = decode(payload),
        now = Date.now() / 1000;
      return (
        claims.iss === issuer &&
        [].concat(claims.aud).includes(audience) &&
        claims.exp > now &&
        !(claims.nbf > now + 60) &&
        typeof claims.email === "string" &&
        createHash("sha256")
          .update(claims.email.toLowerCase())
          .digest("hex") === emailHash
      );
    } catch {
      return false;
    }
  };
}
