import { createClient } from '@supabase/supabase-js';

type AnyRecord = Record<string, any>;
type FormOption = { name: string; label: string };
type FormField = {
  name: string;
  label: string;
  type: string;
  required: boolean;
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
  status: 'review' | 'approved' | 'rejected';
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

async function insert(collection: string, records: AnyRecord[]) {
  const { data, error } = await db()
    .from(TABLE)
    .insert(records.map(record => ({ collection, record })))
    .select('id');
  if (error) throw error;
  return (data || []).map((row: any) => row.id);
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
      max_output_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('AI request failed (' + response.status + ')' + (detail ? ': ' + detail.slice(0, 300) : ''));
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

function syntheticValue(field: FormField, index: number, recordIndex: number) {
  const prefix = 'SYNTHETIC_TEST_' + String(recordIndex + 1).padStart(3, '0');
  if (field.options?.length) return field.options[(index + recordIndex) % field.options.length].name;
  if (/integer|decimal|range/i.test(field.type)) return String((index % 9) + 1);
  if (/date/i.test(field.type)) return '2099-01-' + String((recordIndex % 28) + 1).padStart(2, '0');
  if (/time/i.test(field.type)) return '12:00:00';
  if (/geopoint/i.test(field.type)) return '0 0 0 0';
  return prefix + '_' + field.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

async function generate(
  project: AnyRecord,
  fields: FormField[],
  indexes: number[],
  ageMix: string,
  majority: string,
  sources: AnyRecord[]
) {
  const fieldText = fields.map((field, i) => JSON.stringify({ order: i + 1, ...field })).join('\n');
  const sourceText = sources.map(source => JSON.stringify({
    title: source.title,
    facility: source.facility,
    year: source.year,
    type: source.type,
    finding: source.finding,
  })).join('\n');

  return aiJson(
    'Create SYNTHETIC QA fixtures for a KoboToolbox questionnaire. These are test fixtures, not participant records. Include every supplied field exactly once. Use only supplied choice values. Respect required, relevant and constraint information. For conditional fields that are not applicable, use __NOT_APPLICABLE_BY_FORM_LOGIC__. Free text must be explicitly synthetic. Never invent real identities, observed participant facts, citations or statistics.',
    'PROJECT: ' + String(project.name || '') +
      '\nTOPIC: ' + String(project.topic || '') +
      '\nCONFIG: age mix=' + ageMix + '; majority guidance=' + majority +
      '\nEVIDENCE LIBRARY (context only; do not fabricate citations):\n' + sourceText +
      '\nFORM DEFINITION:\n' + fieldText +
      '\nRECORD INDEXES: ' + indexes.join(', '),
    'synthetic_qa_fixtures',
    {
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
    }
  );
}

export default async function handler(req: any, res: any) {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  if (req.method !== 'POST') {
    send(res, 405, { message: 'Method not allowed' });
    return;
  }

  try {
    const body = bodyOf(req);
    const fields = (Array.isArray(body.fields) ? body.fields : []) as FormField[];
    if (!fields.length) {
      send(res, 400, { message: 'Inspect the Kobo form first; no questionnaire definition is available' });
      return;
    }

    const project = (body.project || {}) as AnyRecord;
    if (!project.id) {
      send(res, 400, { message: 'Select a project before compiling QA fixtures' });
      return;
    }

    const count = Math.max(1, Math.min(100, Number(body.count) || 1));
    const sources = Array.isArray(body.sources) ? body.sources : [];
    const batches = chunks(count, 20);

    const batchOutputs = await Promise.all(
      batches.map(batch => generate(
        project,
        fields,
        batch,
        String(body.ageMix || ''),
        String(body.majority || ''),
        sources
      ))
    );

    const output: Draft[] = [];
    batchOutputs.forEach((aiOutput, batchIndex) => {
      const batch = batches[batchIndex];
      batch.forEach((recordIndex, offset) => {
        const generated = aiOutput?.drafts?.[offset];
        const map = new Map(
          (generated?.fields || []).map((field: any) => [String(field.name || ''), field])
        );

        output.push({
          projectId: String(project.id),
          label: String(generated?.label || '') || 'Synthetic QA fixture ' + String(recordIndex + 1).padStart(3, '0'),
          mode: 'synthetic',
          fields: fields.map((field, index) => {
            const candidate = map.get(field.name);
            return {
              name: field.name,
              label: field.label,
              value: String(candidate?.value || syntheticValue(field, index, recordIndex)),
              confidence: Math.max(0, Math.min(100, Number(candidate?.confidence) || 100)),
              evidence: String(candidate?.evidence || 'Synthetic QA value; not observed participant data.'),
              status: 'review',
            };
          }),
          createdAt: new Date().toISOString(),
          status: 'review',
        });
      });
    });

    const ids = await insert('drafts', output as AnyRecord[]);
    send(res, 200, {
      drafts: output.map((draft, index) => ({ ...draft, id: ids[index] })),
      mode: 'synthetic',
      questionCount: fields.length,
    });
  } catch (error) {
    console.error('FieldMind AI drafts error', error);
    send(res, 500, { message: error instanceof Error ? error.message : 'AI generation failed' });
  }
}
