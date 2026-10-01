import { createClient } from '@supabase/supabase-js';
import { ownerMatches, requireAuth, type AuthUser } from './_auth';

type AnyRecord = Record<string, any>;
type FormOption = { name: string; label: string };
type FormField = {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  relevant?: string;
  constraint?: string;
  options?: FormOption[];
};
type DraftField = {
  name: string;
  label: string;
  value: string;
  confidence: number;
  evidence: string;
  status: 'review';
};
type Draft = {
  projectId: string;
  label: string;
  mode: 'synthetic';
  fields: DraftField[];
  createdAt: string;
  status: 'review';
};

const TABLE = 'fieldmind_records';

function db() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Supabase is not configured');
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function insert(records: AnyRecord[], user: AuthUser) {
  const { data, error } = await db()
    .from(TABLE)
    .insert(records.map(record => ({ collection: 'drafts', record: { ...record, ownerId: user.id } })))
    .select('id');
  if (error) throw error;
  return (data || []).map((row: any) => row.id);
}

async function verifyProject(projectId: string, user: AuthUser) {
  const { data, error } = await db()
    .from(TABLE)
    .select('id,record,collection')
    .eq('id', projectId)
    .eq('collection', 'projects')
    .maybeSingle();
  if (error) throw error;
  if (!data || !ownerMatches(data.record, user)) return false;
  return true;
}

function send(res: any, status: number, payload: any) {
  res.status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .setHeader('Cache-Control', 'no-store, max-age=0')
    .json(payload);
}

function bodyOf(req: any): AnyRecord {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

async function aiJson(system: string, prompt: string, name: string, schema: AnyRecord) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OpenAI is not configured');

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      store: false,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: prompt }] },
      ],
      text: { format: { type: 'json_schema', name, strict: true, schema } },
      max_output_tokens: 10000,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('AI request failed (' + response.status + ')' + (detail ? ': ' + detail.slice(0, 240) : ''));
  }
  const data = await response.json() as any;
  if (!data.output_text) throw new Error('AI returned no structured output.');
  return JSON.parse(data.output_text);
}

function chunks(count: number, size: number) {
  const output: number[][] = [];
  for (let i = 0; i < count; i += size) {
    output.push(Array.from({ length: Math.min(size, count - i) }, (_, j) => i + j));
  }
  return output;
}

function fallbackValue(field: FormField, fieldIndex: number, recordIndex: number) {
  const id = 'SYNTHETIC_TEST_' + String(recordIndex + 1).padStart(3, '0');
  if (field.options?.length) return field.options[(fieldIndex + recordIndex) % field.options.length].name;
  if (/integer|decimal|range/i.test(field.type)) return String((fieldIndex % 9) + 1);
  if (/date/i.test(field.type)) return '2099-01-' + String((recordIndex % 28) + 1).padStart(2, '0');
  if (/time/i.test(field.type)) return '12:00:00';
  if (/geopoint/i.test(field.type)) return '0 0 0 0';
  return id + '_' + field.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function localSyntheticBatch(project: AnyRecord, fields: FormField[], indexes: number[]) {
  return {
    drafts: indexes.map((recordIndex, offset) => ({
      label: 'Local synthetic QA fixture ' + String(recordIndex + 1).padStart(3, '0'),
      fields: fields.map((field, fieldIndex) => {
        if (field.relevant) {
          return {
            name: field.name,
            value: '__NOT_APPLICABLE_BY_FORM_LOGIC__',
            confidence: 100,
            evidence: 'Local QA compiler followed the questionnaire conditional rule; not participant data.',
          };
        }
        const value = field.options?.length
          ? field.options[(fieldIndex + recordIndex) % field.options.length].name
          : fallbackValue(field, fieldIndex, recordIndex);
        return {
          name: field.name,
          value,
          confidence: 100,
          evidence: 'Local QA compiler generated a deterministic test value; not participant data.',
        };
      }),
    })),
  };
}

function isQuotaError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /429|insufficient_quota|credit_balance|no credits remaining|quota/i.test(message);
}

function validateCandidate(candidate: any, fields: FormField[]) {
  const errors: string[] = [];
  const supplied = Array.isArray(candidate?.fields) ? candidate.fields : [];
  const expected = new Set(fields.map(f => f.name));
  const actual = new Set(supplied.map((f: any) => String(f?.name || '')));

  for (const field of fields) {
    if (!actual.has(field.name)) errors.push('missing:' + field.name);
    const item = supplied.find((f: any) => String(f?.name || '') === field.name);
    if (!item) continue;
    const value = String(item.value ?? '').trim();
    if (field.required && !value) errors.push('required-empty:' + field.name);
    if (field.options?.length && value && !field.options.some(o => o.name === value)) {
      errors.push('invalid-choice:' + field.name);
    }
  }
  for (const name of actual) if (name && !expected.has(name)) errors.push('unexpected:' + name);
  return errors;
}

function schema() {
  return {
    type: 'object',
    properties: {
      drafts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  value: { type: 'string' },
                  confidence: { type: 'number' },
                  evidence: { type: 'string' },
                },
                required: ['name', 'value', 'confidence', 'evidence'],
                additionalProperties: false,
              },
            },
          },
          required: ['label', 'fields'],
          additionalProperties: false,
        },
      },
    },
    required: ['drafts'],
    additionalProperties: false,
  };
}

async function think(project: AnyRecord, fields: FormField[], indexes: number[], ageMix: string, majority: string, sources: AnyRecord[]) {
  const form = fields.map((f, i) => JSON.stringify({ order: i + 1, ...f })).join('\n');
  const evidence = sources.map(s => JSON.stringify({
    title: s.title, facility: s.facility, year: s.year, type: s.type, finding: s.finding
  })).join('\n');

  const system = [
    'You are the FieldMind research QA brain.',
    'Produce synthetic QA fixtures only. Never create or imply genuine participant data.',
    'Think about questionnaire structure before answering: required fields, choices, constraints and relevant/conditional expressions.',
    'Every supplied field must appear exactly once. Never add fields.',
    'For a conditionally inactive field use __NOT_APPLICABLE_BY_FORM_LOGIC__.',
    'Choice fields may use only supplied option values.',
    'Free text must clearly identify itself as synthetic/test content.',
    'Evidence is contextual guidance only. Never invent a citation, statistic, identity, facility fact or observed result.',
    'Confidence describes confidence in the fixture construction, not confidence that a fictional answer is true.'
  ].join(' ');

  const prompt = [
    'PROJECT:', String(project.name || ''), 'LOCATION:', String(project.location || ''),
    'TOPIC:', String(project.topic || ''),
    'QA CONFIG: age mix=', ageMix, '; response tendency=', majority,
    'EVIDENCE LIBRARY:', evidence || '(none supplied)',
    'AUTHORITATIVE KOBO FORM DEFINITION:', form,
    'RECORD INDEXES:', indexes.join(', '),
  ].join('\n');

  return aiJson(system, prompt, 'fieldmind_brain_batch', schema());
}

function materialize(project: AnyRecord, fields: FormField[], indexes: number[], output: any) {
  const drafts: Draft[] = [];
  const aiDrafts = Array.isArray(output?.drafts) ? output.drafts : [];

  indexes.forEach((recordIndex, offset) => {
    const candidate = aiDrafts[offset] || {};
    const map = new Map(
      (Array.isArray(candidate.fields) ? candidate.fields : [])
        .map((f: any) => [String(f?.name || ''), f])
    );

    drafts.push({
      projectId: String(project.id),
      label: String(candidate.label || '').trim() || 'Synthetic QA fixture ' + String(recordIndex + 1).padStart(3, '0'),
      mode: 'synthetic',
      fields: fields.map((field, fieldIndex) => {
        const item = map.get(field.name) as any;
        const raw = String(item?.value ?? '').trim();
        const value = raw || fallbackValue(field, fieldIndex, recordIndex);
        const confidence = Math.max(0, Math.min(100, Number(item?.confidence) || 100));
        const evidence = String(item?.evidence || 'Synthetic QA value; not observed participant data.');
        return {
          name: field.name,
          label: field.label,
          value,
          confidence,
          evidence,
          status: 'review',
        };
      }),
      createdAt: new Date().toISOString(),
      status: 'review',
    });
  });

  return drafts;
}

export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { send(res, 405, { message: 'Method not allowed' }); return; }

  try {
    const user = await requireAuth(req, res);
    if (!user) return;
    const body = bodyOf(req);
    const fields = (Array.isArray(body.fields) ? body.fields : []) as FormField[];
    const project = (body.project || {}) as AnyRecord;
    if (!project.id) { send(res, 400, { message: 'Select a project before running the FieldMind brain.' }); return; }
    if (!(await verifyProject(String(project.id), user))) { send(res, 403, { message: 'You do not have access to this research project.' }); return; }
    if (!fields.length) { send(res, 400, { message: 'Inspect the Kobo questionnaire first; the brain needs its authoritative form definition.' }); return; }

    const count = Math.max(1, Math.min(100, Number(body.count) || 1));
    const sources = Array.isArray(body.sources) ? body.sources : [];
    const batches = chunks(count, 20);
    const started = Date.now();

    let usedLocalFallback = false;
    const results = await Promise.all(batches.map(async indexes => {
      let output: any;
      try {
        output = await think(project, fields, indexes, String(body.ageMix || ''), String(body.majority || ''), sources);
      } catch (error) {
        if (!isQuotaError(error)) throw error;
        usedLocalFallback = true;
        output = localSyntheticBatch(project, fields, indexes);
      }

      let errors = output?.drafts?.flatMap((draft: any) => validateCandidate(draft, fields)) || [];

      if (errors.length && !usedLocalFallback) {
        try {
          output = await aiJson(
            'Repair a synthetic QA fixture batch. Do not change the questionnaire. Return every field exactly once, remove unexpected fields, add missing fields, use only supplied choices, and preserve the synthetic QA-only requirement.',
            'FORM: ' + fields.map(f => JSON.stringify(f)).join('\n') +
            '\nINVALID BATCH: ' + JSON.stringify(output) +
            '\nVALIDATION ERRORS: ' + errors.join(', '),
            'fieldmind_brain_repair',
            schema()
          );
          errors = output?.drafts?.flatMap((draft: any) => validateCandidate(draft, fields)) || [];
        } catch (error) {
          if (!isQuotaError(error)) throw error;
          usedLocalFallback = true;
          output = localSyntheticBatch(project, fields, indexes);
          errors = output?.drafts?.flatMap((draft: any) => validateCandidate(draft, fields)) || [];
        }
      }

      return { indexes, output, errors };
    }));

    const drafts = results.flatMap(result => materialize(project, fields, result.indexes, result.output));
    const ids = await insert(drafts as AnyRecord[], user);

    send(res, 200, {
      drafts: drafts.map((draft, i) => ({ ...draft, id: ids[i] })),
      mode: 'synthetic',
      questionCount: fields.length,
      brain: {
        version: '1.1',
        provider: usedLocalFallback ? 'local-qa-compiler' : 'openai',
        fallbackUsed: usedLocalFallback,
        batches: batches.length,
        repairPasses: 0,
        validationErrors: results.flatMap(r => r.errors),
        elapsedMs: Date.now() - started,
        evidenceSourcesUsed: sources.length,
      },
    });
  } catch (error) {
    console.error('FieldMind brain error', error);
    send(res, 500, { message: error instanceof Error ? error.message : 'FieldMind brain failed' });
  }
}
