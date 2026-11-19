import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Vérifie le jeton que Cloudflare Access ajoute à chaque requête autorisée.
 * Access protège déjà le domaine ; cette vérification empêche d'atteindre le
 * Worker par un autre chemin (autre route, Access mal configuré).
 * https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
 */
export interface AccessConfig {
  teamDomain: string;
  aud: string;
}

const keySets = new Map<string, JWTVerifyGetKey>();

function keySet(teamDomain: string): JWTVerifyGetKey {
  let keys = keySets.get(teamDomain);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${teamDomain}/cdn-cgi/access/certs`));
    keySets.set(teamDomain, keys);
  }
  return keys;
}

export function accessToken(request: Request): string | null {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookie = request.headers.get("Cookie") ?? "";
  return /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie)?.[1] ?? null;
}

/** L'email de la personne connectée, ou null si le jeton manque ou est invalide. */
export async function verifyAccess(
  request: Request,
  config: AccessConfig,
  keys: JWTVerifyGetKey = keySet(config.teamDomain),
): Promise<string | null> {
  const token = accessToken(request);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, keys, {
      issuer: `https://${config.teamDomain}`,
      audience: config.aud,
    });
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}
