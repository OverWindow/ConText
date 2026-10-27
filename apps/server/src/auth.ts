import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify } from 'jose';
import { randomUUID } from 'node:crypto';
import type { ServerConfig } from './config.ts';
import type { Database } from './database.ts';
import { ApiError, uuidPattern } from './errors.ts';
export interface Actor { id: string; auth_user_id: string; email: string; display_name: string | null; }
export class Authenticator {
  private jwks;
  constructor(private config: ServerConfig, private db: Database) {
    this.jwks = config.supabaseUrl ? createRemoteJWKSet(new URL(`${config.supabaseUrl}/auth/v1/.well-known/jwks.json`),{timeoutDuration:5000}) : undefined;
  }
  async authenticate(header?: string): Promise<Actor> {
    if (!header?.startsWith('Bearer ')) throw new ApiError(401,'AUTHENTICATION_REQUIRED','Authentication required');
    if (!this.config.supabaseUrl) throw new ApiError(503,'AUTH_NOT_CONFIGURED','Authentication is not configured');
    let claims;
    try {
      const token = header.slice(7); const alg = decodeProtectedHeader(token).alg;
      const key = alg === 'HS256' && this.config.supabaseJwtSecret ? new TextEncoder().encode(this.config.supabaseJwtSecret) : ['RS256','ES256'].includes(alg || '') ? this.jwks : undefined;
      if (!key) throw new Error('Unsupported algorithm');
      const options={algorithms:[alg!],issuer:`${this.config.supabaseUrl}/auth/v1`,audience:this.config.audience,requiredClaims:['exp','iat','sub','aud','iss','role']};
      claims = (await (key instanceof Uint8Array?jwtVerify(token,key,options):jwtVerify(token,key,options))).payload;
      if (!claims.sub || !uuidPattern.test(claims.sub) || claims.role !== 'authenticated' || claims.is_anonymous || typeof claims.email !== 'string' || !claims.email || claims.email.length > 320) throw new Error('Invalid identity');
    } catch { throw new ApiError(401,'INVALID_TOKEN','Invalid or expired access token'); }
    const metadata = claims.user_metadata as Record<string, unknown> | undefined;
    const name = metadata?.full_name || metadata?.name;
    const displayName = typeof name === 'string' ? name.slice(0,200) : null;
    return this.db.transaction(async db => {
      // Reuse the app's existing user UUID without modifying its authentication account.
      // The schema can also run in a fresh standalone database.
      let id: string | undefined;
      if ((await db.query("SELECT to_regclass('public.users') AS name")).rows[0].name) {
        const existing = await db.query('INSERT INTO public.users(id,auth_user_id,email,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(auth_user_id) DO UPDATE SET email=EXCLUDED.email RETURNING id',[randomUUID(),claims.sub,claims.email,displayName]);
        id = existing.rows[0].id;
      }
      const result = await db.query('INSERT INTO unified.users(id,auth_user_id,email,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(auth_user_id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name RETURNING *',[id || claims.sub,claims.sub,claims.email,displayName]);
      return result.rows[0] as Actor;
    });
  }
}
