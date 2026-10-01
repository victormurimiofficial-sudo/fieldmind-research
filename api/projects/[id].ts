import { createClient } from '@supabase/supabase-js';

type AnyRecord = Record<string, any>;

const TABLE = 'fieldmind_records';

function db() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Supabase is not configured');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function send(res: any, status: number, payload: AnyRecord) {
  res
    .status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .setHeader('Cache-Control', 'no-store, max-age=0')
    .json(payload);
}

function bodyOf(req: any): AnyRecord {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return req.body;
}

export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'PUT') {
    send(res, 405, { message: 'Method not allowed' });
    return;
  }

  try {
    const id = String(req.query?.id || '').trim();
    if (!id) {
      send(res, 400, { message: 'Project id is required' });
      return;
    }

    const body = bodyOf(req);
    const project = { ...body, id };

    const { data, error } = await db()
      .from(TABLE)
      .update({ record: project, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('collection', 'projects')
      .select('id')
      .maybeSingle();

    if (error) throw error;

    if (!data) {
      send(res, 404, { message: 'Project not found: ' + id });
      return;
    }

    send(res, 200, { project });
  } catch (error) {
    console.error('FieldMind project update error', error);
    send(res, 500, {
      message: error instanceof Error ? error.message : 'Project update failed',
    });
  }
}
