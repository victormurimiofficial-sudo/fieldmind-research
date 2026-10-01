import { createClient, type User } from '@supabase/supabase-js';

export const ADMIN_EMAIL = 'victormurimiofficial@gmail.com';
const ACCESS_COOKIE = 'fieldmind_access';
const REFRESH_COOKIE = 'fieldmind_refresh';

type AuthUser = {
  id: string;
  email: string;
  isAdmin: boolean;
};

function client() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Supabase is not configured');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

function cookies(req: any): Record<string,string> {
  if (req?.cookies && typeof req.cookies === 'object') return req.cookies;
  const raw = String(req?.headers?.cookie || '');
  return Object.fromEntries(raw.split(';').map((part: string) => {
    const [key, ...rest] = part.trim().split('=');
    return [key, decodeURIComponent(rest.join('=') || '')];
  }).filter(([key]) => key));
}

function setSessionCookies(res: any, accessToken: string, refreshToken: string) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const base = '; Path=/; HttpOnly; SameSite=Lax' + secure;
  res.setHeader('Set-Cookie', [
    ACCESS_COOKIE + '=' + encodeURIComponent(accessToken) + base + '; Max-Age=3600',
    REFRESH_COOKIE + '=' + encodeURIComponent(refreshToken) + base + '; Max-Age=2592000',
  ]);
}

export function clearSessionCookies(res: any) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const base = '; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=0';
  res.setHeader('Set-Cookie', [
    ACCESS_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=0',
    REFRESH_COOKIE + '=; Path=/; HttpOnly; SameSite=Lax' + secure + '; Max-Age=0',
  ]);
}

function publicUser(user: User): AuthUser {
  const email = String(user.email || '').trim().toLowerCase();
  return {
    id: user.id,
    email,
    isAdmin: email === ADMIN_EMAIL,
  };
}

async function resolveAccess(accessToken: string) {
  if (!accessToken) return null;
  const { data, error } = await client().auth.getUser(accessToken);
  if (error || !data.user) return null;
  return data.user;
}

export async function getAuthUser(req: any, res?: any): Promise<AuthUser | null> {
  const jar = cookies(req);
  let user = await resolveAccess(jar[ACCESS_COOKIE] || '');

  if (!user && jar[REFRESH_COOKIE]) {
    try {
      const { data, error } = await client().auth.setSession({
        access_token: jar[ACCESS_COOKIE] || '',
        refresh_token: jar[REFRESH_COOKIE],
      });
      if (!error && data.session && data.user) {
        user = data.user;
        if (res) setSessionCookies(res, data.session.access_token, data.session.refresh_token);
      }
    } catch {}
  }

  return user ? publicUser(user) : null;
}

export async function requireAuth(req: any, res: any): Promise<AuthUser | null> {
  const user = await getAuthUser(req, res);
  if (!user) {
    res.status(401).setHeader('Cache-Control', 'no-store, max-age=0').json({
      message: 'Please sign in to continue.',
      code: 'AUTH_REQUIRED',
    });
    return null;
  }
  return user;
}

export async function signIn(email: string, password: string, res: any) {
  const { data, error } = await client().auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
  if (!data.session || !data.user) throw new Error('Sign-in completed without an active session.');
  setSessionCookies(res, data.session.access_token, data.session.refresh_token);
  return publicUser(data.user);
}

export async function signUp(email: string, password: string, name: string, res: any) {
  const { data, error } = await client().auth.signUp({
    email,
    password,
    options: { data: { full_name: name.trim() } },
  });
  if (error) throw new Error(error.message);
  if (data.session && data.user) {
    setSessionCookies(res, data.session.access_token, data.session.refresh_token);
    return { user: publicUser(data.user), requiresEmailConfirmation: false };
  }
  return {
    user: data.user ? publicUser(data.user) : null,
    requiresEmailConfirmation: true,
  };
}

export async function signOut(req: any, res: any) {
  const jar = cookies(req);
  try {
    if (jar[ACCESS_COOKIE]) {
      const sb = client();
      const { data } = await sb.auth.getUser(jar[ACCESS_COOKIE]);
      if (data.user) {
        await sb.auth.signOut({ scope: 'local' });
      }
    }
  } catch {}
  clearSessionCookies(res);
}

export function ownerMatches(record: any, user: AuthUser) {
  return user.isAdmin || String(record?.ownerId || '') === user.id;
}

export function withOwner(record: AnyRecord, user: AuthUser) {
  return { ...record, ownerId: user.id };
}

type AnyRecord = Record<string, any>;
