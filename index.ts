// Edge function: lets an admin create staff logins, reset passwords and issue QR sign-in cards.
// Needs the service role key, which must never be in the browser, so it lives here.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const EMAIL_DOMAIN = 'sasa.local';
const ROLES = ['admin', 'cashier', 'chef'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

// A QR token is 32 random bytes (256 bits), written as 43 URL-safe characters.
// It cannot be guessed. Only its SHA-256 hash is stored in the database.
function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Issue (or replace) a person's QR token. Replacing it kills the old card at once.
async function issueQr(admin: any, userId: string): Promise<string> {
  const token = newToken();
  const { error } = await admin.from('staff_qr').upsert({
    user_id: userId,
    token_hash: await sha256Hex(token),
    created_at: new Date().toISOString(),
    last_used_at: null,
  });
  if (error) throw new Error(error.message);
  return token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

    // Who is calling?
    const caller = createClient(url, anon, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await caller.auth.getUser();
    if (!user) return json({ error: 'Not signed in' }, 401);

    const admin = createClient(url, service);
    const { data: me } = await admin
      .from('profiles').select('role, active').eq('id', user.id).maybeSingle();
    if (!me || !me.active || me.role !== 'admin') return json({ error: 'Admins only' }, 403);

    const body = await req.json();

    if (body.action === 'create') {
      const username = String(body.username ?? '').trim().toLowerCase();
      const fullName = String(body.full_name ?? '').trim();
      const password = String(body.password ?? '');
      const role = String(body.role ?? '');

      if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
        return json({ error: 'Username must be 3-30 letters, numbers, dots, dashes or underscores' }, 400);
      }
      if (!fullName) return json({ error: 'Full name is required' }, 400);
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
      if (!ROLES.includes(role)) return json({ error: 'Invalid role' }, 400);

      const { data: created, error: createErr } = await admin.auth.admin.createUser({
        email: `${username}@${EMAIL_DOMAIN}`,
        password,
        email_confirm: true,
      });
      if (createErr || !created.user) {
        const taken = createErr?.message?.toLowerCase().includes('already');
        return json({ error: taken ? 'That username is already taken' : (createErr?.message ?? 'Could not create user') }, 400);
      }

      const { error: profileErr } = await admin.from('profiles').insert({
        id: created.user.id, username, full_name: fullName, role,
      });
      if (profileErr) {
        await admin.auth.admin.deleteUser(created.user.id);
        return json({ error: profileErr.message }, 400);
      }

      await admin.from('activity_log').insert({
        user_id: user.id, action: 'staff_created', details: { username, role },
      });

      // The login is already made at this point. If the QR card fails (for example the
      // v3 database upgrade has not been run yet) we still succeed and say so, and the
      // admin can issue the card later from the Staff screen.
      let qr_token: string | null = null;
      let qr_error: string | null = null;
      try {
        qr_token = await issueQr(admin, created.user.id);
      } catch (e) {
        qr_error = (e as Error).message;
      }
      return json({ ok: true, qr_token, qr_error, username, full_name: fullName, role });
    }

    if (body.action === 'regenerate_qr') {
      if (typeof body.user_id !== 'string') return json({ error: 'Staff member not found' }, 404);
      const { data: target } = await admin
        .from('profiles').select('username, full_name, role').eq('id', body.user_id).maybeSingle();
      if (!target) return json({ error: 'Staff member not found' }, 404);

      const qr_token = await issueQr(admin, body.user_id);
      await admin.from('activity_log').insert({
        user_id: user.id, action: 'staff_qr_issued', details: { username: target.username },
      });
      return json({
        ok: true, qr_token, username: target.username, full_name: target.full_name, role: target.role,
      });
    }

    if (body.action === 'reset_password') {
      const password = String(body.password ?? '');
      if (password.length < 8) return json({ error: 'Password must be at least 8 characters' }, 400);
      const { data: target } = await admin
        .from('profiles').select('username').eq('id', body.user_id).maybeSingle();
      if (!target) return json({ error: 'Staff member not found' }, 404);

      const { error } = await admin.auth.admin.updateUserById(body.user_id, { password });
      if (error) return json({ error: error.message }, 400);

      await admin.from('activity_log').insert({
        user_id: user.id, action: 'staff_password_reset', details: { username: target.username },
      });
      return json({ ok: true });
    }

    return json({ error: 'Unknown action' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});