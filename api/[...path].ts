import { createClient } from '@supabase/supabase-js';
import { ownerMatches, requireAuth, signIn, signOut, signUp, type AuthUser } from './_auth';

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
  id?: string;
  projectId: string;
  label: string;
  mode: 'synthetic';
  fields: DraftField[];
  createdAt: string;
  status?: 'review' | 'confirmed' | 'deployed';
};

const TABLE = 'fieldmind_records';

const LEGACY_DEMO_NAME = 'thika level 5 ncd study';
const LEGACY_DEMO_KOBO_UID = 'iowlqblk';

function isLegacyDemoProject(project: AnyRecord) {
  const name = String(project.name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const kobo = String(project.koboUrl || '').toLowerCase();
  return name === LEGACY_DEMO_NAME && kobo.includes(LEGACY_DEMO_KOBO_UID);
}

function db() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('Supabase is not configured');
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function list<T>(collection: string, user: AuthUser, limit = 500) {
  const { data, error } = await db()
    .from(TABLE)
    .select('id,record')
    .eq('collection', collection)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  const rows = (data || []).map((row: any) => ({ ...row.record, id: row.id })) as T[];
  return rows.filter((record: any) => ownerMatches(record, user));
}

async function insert(collection: string, records: AnyRecord[], user: AuthUser) {
  const { data, error } = await db()
    .from(TABLE)
    .insert(records.map(record => ({ collection, record: { ...record, ownerId: user.id } })))
    .select('id');
  if (error) throw error;
  return (data || []).map((row: any) => row.id);
}

async function getById(id: string) {
  const { data, error } = await db().from(TABLE).select('id,record,collection').eq('id', id).maybeSingle();
  if (error) throw error;
  return data ? { id: data.id, collection: data.collection, ...(data.record || {}) } : null;
}

async function update(id: string, record: AnyRecord, user: AuthUser) {
  const current = await getById(id);
  if (!current || !ownerMatches(current, user)) return false;
  const safeRecord = { ...record, id, ownerId: current.ownerId || user.id };
  const { data, error } = await db()
    .from(TABLE)
    .update({ record: safeRecord, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('id');
  if (error) throw error;
  return Boolean(data?.length);
}

async function remove(id: string, user: AuthUser) {
  const current = await getById(id);
  if (!current || !ownerMatches(current, user)) return false;
  const { data, error } = await db().from(TABLE).delete().eq('id', id).select('id');
  if (error) throw error;
  return Boolean(data?.length);
}

async function projectsWithStats(user: AuthUser) {
  const [projects, drafts, sources] = await Promise.all([
    list<AnyRecord>('projects', user, 500),
    list<Draft>('drafts', user, 1000),
    list<AnyRecord>('sources', user, 1000),
  ]);

  return projects.map(project => {
    const projectDrafts = drafts.filter(draft => draft.projectId === project.id);
    const projectSources = sources.filter(source => source.projectId === project.id);
    return {
      ...project,
      researchCount: projectSources.length,
      draftCount: projectDrafts.length,
      approvedCount: projectDrafts.filter(
        draft => draft.status === 'confirmed' || draft.status === 'deployed'
      ).length,
      updatedAt: project.updatedAt || 'Saved',
    };
  });
}
function send(res: any, status: number, payload: any) {
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

function clean(value: string) {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function attr(source: string, key: string) {
  const match = source.match(new RegExp('\\b' + key + '=["\\\']([^"\\\']*)["\\\']', 'i'));
  return match?.[1] || '';
}

function safeKoboUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname.endsWith('kobotoolbox.org') ||
        url.hostname.endsWith('humanitarianresponse.info'))
    );
  } catch {
    return false;
  }
}

function uidFrom(value: string) {
  const raw = String(value || '').trim();
  const urlMatch = raw.match(/(?:\/forms\/|\/assets\/)([A-Za-z0-9_-]+)/);
  if (urlMatch?.[1]) return urlMatch[1];
  const hashMatch = raw.match(/#\/forms\/([A-Za-z0-9_-]+)/i);
  if (hashMatch?.[1]) return hashMatch[1];
  return /^[A-Za-z0-9_-]{12,}$/.test(raw) ? raw : '';
}

function parseXForm(xml: string): { title: string; fields: FormField[] } {
  const title =
    clean(
      xml.match(/<(?:h:)?title[^>]*>([\s\S]*?)<\/(?:h:)?title>/i)?.[1] || ''
    ) || 'KoboToolbox form';

  const binds = new Map<string, AnyRecord>();

  for (const match of xml.matchAll(
    /<(?:bind|xf:bind)\b([^>]*)\/?>(?:<\/(?:bind|xf:bind)>)?/gi
  )) {
    const raw = match[1] || '';
    const ref = attr(raw, 'nodeset') || attr(raw, 'ref');
    if (!ref) continue;
    binds.set(ref, {
      type: attr(raw, 'type'),
      required: attr(raw, 'required'),
      relevant: attr(raw, 'relevant'),
      constraint: attr(raw, 'constraint'),
      calculation: attr(raw, 'calculate') || attr(raw, 'jr:calculate'),\n      readonly: attr(raw, 'readonly'),
    });
  }

  const fields: FormField[] = [];
  const seen = new Set<string>();

  const addField = (ref: string, fallbackType: string, body: string) => {
    const name = ref.replace(/^\//, '').replace(/^data\//, '');
    if (!name || seen.has(name) || /^meta\//i.test(name)) return;

    const binding = binds.get(ref) || binds.get('/' + name) || binds.get(name) || {};
    const label =
      clean(
        body.match(/<(?:h:)?label\b[^>]*>([\s\S]*?)<\/(?:h:)?label>/i)?.[1] || ''
      ) || name.replace(/[_-]+/g, ' ');

    const options: FormOption[] = [];
    for (const item of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
      const itemBody = item[1] || '';
      const value = itemBody.match(
        /<(?:h:)?value\b[^>]*>([\s\S]*?)<\/(?:h:)?value>/i
      )?.[1];
      if (!value) continue;
      const optionLabel =
        itemBody.match(
          /<(?:h:)?label\b[^>]*>([\s\S]*?)<\/(?:h:)?label>/i
        )?.[1] || value;
      options.push({ name: clean(value), label: clean(optionLabel) });
    }

    const type = binding.type || fallbackType || 'text';
    if (/calculate|note|hidden/i.test(type) || binding.calculation || /true\\(\\)|true|1/i.test(binding.readonly || '')) return;

    seen.add(name);
    fields.push({
      name,
      label,
      type,
      required: /true\(\)|true|1/i.test(binding.required || ''),
      ...(binding.relevant ? { relevant: binding.relevant } : {}),
      ...(binding.constraint ? { constraint: binding.constraint } : {}),
      ...(options.length ? { options } : {}),
    });
  };

  const control = /<(?:input|select1|select|textarea|upload|range|geopoint|date|datetime|time)\b([^>]*)(?:\/>|>([\s\S]*?)<\/(?:input|select1|select|textarea|upload|range|geopoint|date|datetime|time)>)/gi;

  for (const match of xml.matchAll(control)) {
    const raw = match[0];
    const attributes = match[1] || '';
    const body = match[2] || '';
    const ref = attr(attributes, 'ref');
    const fallback = raw.match(/^<([a-z0-9:_-]+)/i)?.[1]?.replace(/^.*:/, '') || 'input';
    if (ref) addField(ref, fallback, body);
  }

  if (!fields.length) {
    for (const [ref, binding] of binds) {
      if (binding.type && !/calculate|note|hidden/i.test(binding.type)) {
        addField(ref, binding.type, '');
      }
    }
  }

  return { title, fields };
}

async function fetchText(url: string, headers: AnyRecord = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'FieldMind-Research/6.0',
      Accept: 'text/html,application/xml,text/xml,application/json',
      ...headers,
    },
  });
  return { response, text: await response.text() };
}

async function aiJson(
  system: string,
  prompt: string,
  name: string,
  schema: AnyRecord
) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      store: false,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: prompt }] },
      ],
      text: {
        format: { type: 'json_schema', name, strict: true, schema },
      },
      max_output_tokens: 8192,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error('AI request failed (' + response.status + ')' + (detail ? ': ' + detail.slice(0, 300) : ''));
  }

  const data = (await response.json()) as any;
  if (!data.output_text) throw new Error('AI returned no structured output.');
  return JSON.parse(data.output_text);
}

async function inspectKobo(url: string, source: string, token: string) {
  const uid = uidFrom(source) || uidFrom(url);
  const auth = token || process.env.KOBO_API_TOKEN || '';
  const headers = auth ? { Authorization: 'Token ' + auth } : {};
  const inputHost = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  // ee.kobotoolbox.org is the Enketo web-form host, not the KPI v2 API host.
  // A global Kobo form normally resolves through kf.kobotoolbox.org; an EU
  // form uses eu.kobotoolbox.org. For an ee/Enketo link, try both API servers
  // instead of incorrectly forcing every /x/ link to the EU server.
  const preferred = inputHost === 'kf.kobotoolbox.org'
    ? 'https://kf.kobotoolbox.org'
    : inputHost === 'eu.kobotoolbox.org' || inputHost === 'ee-eu.kobotoolbox.org'
      ? 'https://eu.kobotoolbox.org'
      : '';
  const bases = inputHost === 'ee.kobotoolbox.org'
    ? ['https://kf.kobotoolbox.org', 'https://eu.kobotoolbox.org']
    : preferred
      ? [preferred]
      : ['https://kf.kobotoolbox.org', 'https://eu.kobotoolbox.org'];
  const diagnostics: Array<{ endpoint: string; status: number; contentType?: string }> = [];
  let assetStatus: number | undefined;

  if (uid) {
    for (const base of bases) {
      const directCandidates = [
        base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform/',
        base + '/api/v2/assets/' + encodeURIComponent(uid) + '.xml',
        base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform.xml',
      ];

      for (const endpoint of directCandidates) {
        try {
          const result = await fetchText(endpoint, headers);
          diagnostics.push({
            endpoint: endpoint.replace(/https?:\/\//, ''),
            status: result.response.status,
            contentType: result.response.headers.get('content-type') || undefined,
          });
          if (!result.response.ok) continue;
          const parsed = parseXForm(result.text);
          if (parsed.fields.length) {
            return { ...parsed, source: 'Kobo API XForm', resolvedUrl: result.response.url || endpoint, diagnostics };
          }
        } catch {}
      }

      try {
        const detail = await fetchText(base + '/api/v2/assets/' + encodeURIComponent(uid) + '/', headers);
        assetStatus = detail.response.status;
        diagnostics.push({
          endpoint: ('asset:' + base).replace(/https?:\/\//, ''),
          status: detail.response.status,
          contentType: detail.response.headers.get('content-type') || undefined,
        });
        if (detail.response.ok) {
          try {
            const metadata = JSON.parse(detail.text) as AnyRecord;
            const candidates = [
              typeof metadata.xform_link === 'string' ? metadata.xform_link : '',
              typeof metadata.downloads?.find === 'function'
                ? metadata.downloads.find((item: AnyRecord) => /xform/i.test(String(item?.format || item?.type || '')))?.url || ''
                : '',
            ].filter(Boolean);

            for (const endpoint of Array.from(new Set(candidates))) {
              try {
                const result = await fetchText(endpoint, headers);
                diagnostics.push({
                  endpoint: endpoint.replace(/https?:\/\//, ''),
                  status: result.response.status,
                  contentType: result.response.headers.get('content-type') || undefined,
                });
                if (!result.response.ok) continue;
                const parsed = parseXForm(result.text);
                if (parsed.fields.length) {
                  return { ...parsed, source: 'Kobo API XForm', resolvedUrl: result.response.url || endpoint, diagnostics };
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }
  }

  // The /x/<id> value is an Enketo share/form ID, not a KPI asset UID.
  // Resolve it through the authenticated v2 asset list before falling back to
  // scraping the public form shell. This is the reliable path for private forms.
  // If a direct XForm URL returns 404, verify the UID through the
  // authenticated survey list and use Kobo's canonical xform_link/download
  // URLs from the asset serializer.
  if (uid && auth) {
    for (const base of bases) {
      try {
        let next = base + '/api/v2/assets/?asset_type=survey&limit=100';
        const seenPages = new Set<string>();
        let matchedAsset: AnyRecord | null = null;

        while (next && !seenPages.has(next) && seenPages.size < 10) {
          seenPages.add(next);
          const listResult = await fetchText(next, headers);
          diagnostics.push({
            endpoint: ('assets-list-for-uid:' + next).replace(/^https?:\/\//, ''),
            status: listResult.response.status,
            contentType: listResult.response.headers.get('content-type') || undefined,
          });
          if (!listResult.response.ok) break;

          const listData = JSON.parse(listResult.text) as AnyRecord;
          const results = Array.isArray(listData?.results) ? listData.results : [];
          matchedAsset = results.find(item => String(item?.uid || '') === uid) || null;
          if (matchedAsset) break;

          const nextUrl = typeof listData?.next === 'string' ? listData.next : '';
          next = nextUrl && nextUrl.startsWith(base) ? nextUrl : '';
        }

        if (!matchedAsset) continue;

        const links: string[] = [
          typeof matchedAsset.xform_link === 'string' ? matchedAsset.xform_link : '',
          ...(Array.isArray(matchedAsset.downloads)
            ? matchedAsset.downloads
                .filter((item: AnyRecord) => /xform|xml/i.test(String(item?.format || item?.type || '')))
                .map((item: AnyRecord) => String(item?.url || ''))
            : []),
        ].filter(Boolean);

        for (const endpoint of Array.from(new Set(links))) {
          try {
            const xform = await fetchText(endpoint, headers);
            diagnostics.push({
              endpoint: endpoint.replace(/^https?:\/\//, ''),
              status: xform.response.status,
              contentType: xform.response.headers.get('content-type') || undefined,
            });
            if (!xform.response.ok) continue;
            const parsed = parseXForm(xform.text);
            if (parsed.fields.length) {
              return {
                ...parsed,
                source: 'Kobo API XForm',
                resolvedUrl: xform.response.url || endpoint,
                diagnostics,
              };
            }
          } catch {}
        }
      } catch {}
    }
  }

  const shareId = String(url.match(/\/x\/([A-Za-z0-9_-]+)/i)?.[1] || '');
  if (!uid && shareId && auth) {
    for (const base of bases) {
      try {
        let next = base + '/api/v2/assets/?asset_type=survey&limit=100';
        const seenPages = new Set<string>();
        const candidates: Array<{ uid: string; name: string; url: string }> = [];

        while (next && !seenPages.has(next) && seenPages.size < 10) {
          seenPages.add(next);
          const result = await fetchText(next, headers);
          diagnostics.push({
            endpoint: 'assets-list:' + next.replace(/^https?:\/\//, ''),
            status: result.response.status,
            contentType: result.response.headers.get('content-type') || undefined,
          });
          if (!result.response.ok) break;

          const data = JSON.parse(result.text) as AnyRecord;
          const results = Array.isArray(data?.results) ? data.results : [];

          for (const item of results) {
            const uidValue = String(item?.uid || '').trim();
            if (!uidValue) continue;
            const nameValue = String(item?.name || item?.settings?.name || item?.title || uidValue).trim();

            const collectStrings = (value: unknown): string[] => {
              if (typeof value === 'string') return [value];
              if (Array.isArray(value)) return value.flatMap(collectStrings);
              if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(collectStrings);
              return [];
            };

            const searchableUrls = [
              String(item?.url || ''),
              String(item?.xform_link || ''),
              ...collectStrings(item?.deployment__links),
            ].filter(Boolean);

            if (searchableUrls.some(value => value.toLowerCase().includes('/x/' + shareId.toLowerCase()))) {
              return await inspectKobo(url, uidValue, token);
            }

            candidates.push({ uid: uidValue, name: nameValue, url: String(item?.url || '').trim() });
          }

          const nextUrl = typeof data?.next === 'string' ? data.next : '';
          next = nextUrl && /^https:\/\/(?:kf|eu)\.kobotoolbox\.org\//i.test(nextUrl) ? nextUrl : '';
        }

        if (candidates.length === 1) {
          return await inspectKobo(url, candidates[0].uid, token);
        }

        if (candidates.length > 0) {
          return {
            needsSelection: true,
            candidates,
            shareId,
            source: 'Kobo API project list',
            diagnostics,
          };
        }
      } catch (error) {
        diagnostics.push({
          endpoint: 'assets-list-error:' + base.replace(/^https?:\/\//, ''),
          status: 0,
          contentType: error instanceof Error ? error.message : 'request failed',
        });
      }
    }
  }

  try {
    const result = await fetchText(url);
    diagnostics.push({
      endpoint: 'web-form:' + url.replace(/^https?:\/\//, ''),
      status: result.response.status,
      contentType: result.response.headers.get('content-type') || undefined,
    });
    if (result.response.ok) {
      const parsed = parseXForm(result.text);
      if (parsed.fields.length) {
        return { ...parsed, source: 'Kobo web form XForm', resolvedUrl: result.response.url || url, diagnostics };
      }
      const extracted = await aiJson(
        'Extract only the questionnaire structure actually present in this KoboToolbox web-form page. Never invent questions, field names, choices, citations, or answers. If the page is only an application shell and does not expose the questionnaire, return an empty fields array.',
        'Kobo web-form HTML:\n' + clean(result.text).slice(0, 60000),
        'kobo_form_definition',
        {
          type: 'object',
          properties: {
            title: { type: 'string' },
            fields: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  label: { type: 'string' },
                  type: { type: 'string' },
                  required: { type: 'boolean' },
                  relevant: { type: 'string' },
                  options: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        label: { type: 'string' },
                      },
                      required: ['name', 'label'],
                      additionalProperties: false,
                    },
                  },
                },
                required: ['name', 'label', 'type', 'required', 'relevant', 'options'],
                additionalProperties: false,
              },
            },
          },
          required: ['title', 'fields'],
          additionalProperties: false,
        }
      );
      if (extracted?.fields?.length) {
        return {
          title: extracted.title || 'KoboToolbox form',
          fields: extracted.fields,
          source: 'Kobo web form structured extraction',
          resolvedUrl: result.response.url || url,
          diagnostics,
        };
      }
    }
  } catch {}

  return { failure: true, uid, shareId: String(url.match(/\/x\/([A-Za-z0-9_-]+)/i)?.[1] || ''), diagnostics };
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

function chunks(count: number, size: number) {
  const output: number[][] = [];
  for (let i = 0; i < count; i += size) {
    output.push(Array.from({ length: Math.min(size, count - i) }, (_, j) => i + j));
  }
  return output;
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
  const sourceText = sources
    .map(source =>
      JSON.stringify({
        title: source.title,
        facility: source.facility,
        year: source.year,
        type: source.type,
        finding: source.finding,
      })
    )
    .join('\n');

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

function csvCell(value: any) {
  return '"' + String(value ?? '').replace(/"/g, '""') + '"';
}

function toCsv(items: Draft[]) {
  if (!items.length) return '';
  const names = Array.from(new Set(items.flatMap(draft => draft.fields.map(field => field.name))));
  const header = ['record_id', 'label', 'status', ...names];
  const rows = items.map(draft => [
    draft.id,
    draft.label,
    draft.status || 'review',
    ...names.map(name => draft.fields.find(field => field.name === name)?.value ?? ''),
  ]);
  return [header, ...rows].map(row => row.map(csvCell).join(',')).join('\n');
}

export default async function handler(req: any, res: any) {
  try {
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }

    const requestUrl = new URL(req.url || '/', 'https://fieldmind.local');
    const pathname = requestUrl.pathname.replace(/\/$/, '') || '/';
    const queryPath = req.query?.path;
    const catchallPath = Array.isArray(queryPath)
      ? queryPath.join('/')
      : typeof queryPath === 'string'
        ? queryPath
        : '';
    const path = (catchallPath ? '/api/' + catchallPath.replace(/^\/+/, '') : pathname).replace(/\/$/, '') || '/';
    const body = bodyOf(req);

    if (req.method === 'POST' && path === '/api/auth/signup') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();
      if (!email || !password || password.length < 8) {
        send(res, 400, { message: 'Use a valid email and a password of at least 8 characters.' });
        return;
      }
      try {
        const result = await signUp(email, password, name, res);
        send(res, 200, {
          user: result.user,
          requiresEmailConfirmation: result.requiresEmailConfirmation,
          message: result.requiresEmailConfirmation
            ? 'Account created. Check your email to confirm the account, then sign in.'
            : 'Account created. Welcome to FieldMind.',
        });
      } catch (error) {
        send(res, 400, { message: error instanceof Error ? error.message : 'Could not create the account.' });
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/auth/login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!email || !password) {
        send(res, 400, { message: 'Email and password are required.' });
        return;
      }
      try {
        const user = await signIn(email, password, res);
        send(res, 200, { user, message: user.isAdmin ? 'Welcome back, Victor.' : 'Welcome to FieldMind.' });
      } catch (error) {
        send(res, 401, { message: error instanceof Error ? error.message : 'Invalid email or password.' });
      }
      return;
    }

    if (req.method === 'POST' && path === '/api/auth/logout') {
      await signOut(req, res);
      send(res, 200, { signedOut: true });
      return;
    }

    if (req.method === 'GET' && path === '/api/auth/me') {
      const user = await requireAuth(req, res);
      if (!user) return;
      send(res, 200, { user });
      return;
    }

    if (req.method === 'GET' && path === '/api/_healthcheck') {
      const database = Boolean(
        process.env.SUPABASE_URL &&
        (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY)
      );
      const ai = Boolean(process.env.OPENAI_API_KEY);
      send(res, 200, { ok: database, database: database ? 'configured' : 'missing', ai: ai ? 'configured' : 'optional-local-fallback' });
      return;
    }

    const authUser = await requireAuth(req, res);
    if (!authUser) return;

    if (req.method === 'POST' && path === '/api/admin/reset-workspace') {
      if (!authUser!.isAdmin) {
        send(res, 403, { message: 'Admin access required.' });
        return;
      }
      const { error } = await db().from(TABLE).delete().not('id', 'is', null);
      if (error) throw error;
      send(res, 200, { cleared: true, message: 'All previous FieldMind research records were cleared.' });
      return;
    }

    if (req.method === 'GET' && path === '/api/projects') {
      send(res, 200, { projects: await projectsWithStats(authUser!) });
      return;
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch && req.method === 'PUT') {
      const id = projectMatch[1];
      const ok = await update(id, { ...body, id }, authUser!);
      send(res, ok ? 200 : 404, { project: { ...body, id } });
      return;
    }

    if (req.method === 'POST' && path === '/api/projects') {
      if (!body.name || !body.location || !body.topic) {
        send(res, 400, { message: 'Project name, location and topic are required' });
        return;
      }
      const ids = await insert('projects', [body], authUser!);
      send(res, 200, { project: { ...body, id: ids[0] } });
      return;
    }

    if (req.method === 'GET' && path === '/api/drafts') {
      send(res, 200, { drafts: await list<Draft>('drafts', authUser!, 500) });
      return;
    }

    if (req.method === 'GET' && path === '/api/sources') {
      const projectId = new URL(req.url || '/', 'https://fieldmind.local').searchParams.get('projectId') || '';
      const all = await list<AnyRecord>('sources', authUser!, 500);
      send(res, 200, { sources: projectId ? all.filter(source => String(source.projectId || '') === projectId) : all });
      return;
    }

    if (req.method === 'POST' && path === '/api/sources') {
      if (!body.projectId || !body.title || !body.finding) {
        send(res, 400, { message: 'Project, title and finding are required' });
        return;
      }
      const ids = await insert('sources', [body], authUser!);
      send(res, 200, { source: { ...body, id: ids[0] } });
      return;
    }

    const sourceMatch = path.match(/^\/api\/sources\/([^/]+)$/);
    if (sourceMatch && req.method === 'PUT') {
      const id = sourceMatch[1];
      const ok = await update(id, { ...body, id }, authUser!);
      send(res, ok ? 200 : 404, { source: { ...body, id } });
      return;
    }

    if (sourceMatch && req.method === 'DELETE') {
      const ok = await remove(sourceMatch[1], authUser!);
      send(res, ok ? 200 : 404, { deleted: ok });
      return;
    }

    const draftMatch = path.match(/^\/api\/drafts\/([^/]+)$/);
    if (draftMatch && req.method === 'PUT') {
      const id = draftMatch[1];
      const ok = await update(id, { ...body, id }, authUser!);
      send(res, ok ? 200 : 404, { draft: { ...body, id } });
      return;
    }

    if (draftMatch && req.method === 'DELETE') {
      const ok = await remove(draftMatch[1], authUser!);
      send(res, ok ? 200 : 404, { deleted: ok });
      return;
    }

    if (req.method === 'POST' && path === '/api/kobo/inspect') {
      const url = String(body.url || '');
      if (!safeKoboUrl(url)) {
        send(res, 400, { message: 'Use a valid KoboToolbox HTTPS form URL' });
        return;
      }
      const resolved = await inspectKobo(url, String(body.assetUid || ''), String(body.apiToken || ''));
      if ((resolved as any)?.needsSelection) {
        send(res, 200, {
          reachable: true,
          mapped: false,
          needsSelection: true,
          shareId: (resolved as any).shareId || '',
          candidates: (resolved as any).candidates || [],
          questionCount: 0,
          fields: [],
          message: 'This /x/ link was found through your Kobo account. Select the matching project below; FieldMind will retrieve its XForm automatically.',
        });
        return;
      }
      if (!resolved || (resolved as any).failure) {
        const failure = resolved as any;
        const diagnostics = Array.isArray(failure?.diagnostics) ? failure.diagnostics : [];
        const authRequired = diagnostics.some((item: any) => item.status === 401 || item.status === 403);
        const notFound = Number(failure?.assetStatus) === 404;
        send(res, 422, {
          reachable: true,
          mapped: false,
          code: authRequired ? 'KOBO_AUTH_REQUIRED' : notFound && failure?.uid ? 'KOBO_ASSET_NOT_FOUND' : 'KOBO_XFORM_UNAVAILABLE',
          questionCount: 0,
          fields: [],
          assetUid: failure?.uid || '',
          shareId: failure?.shareId || '',
          needsAssetUid: !failure?.uid,
          diagnostics,
          message: authRequired
            ? 'Kobo requires an API key to read this questionnaire definition. Enter it under Advanced options.'
            : notFound && failure?.uid
              ? 'Kobo could not find that Asset UID on the selected server. Check that the Summary URL belongs to the same Kobo server.'
              : failure?.uid
                ? 'Kobo exposed the project but FieldMind could not retrieve a usable XForm. Endpoint diagnostics are included.'
                : 'FieldMind could not resolve the questionnaire definition from this web-form link. Paste the Kobo Summary URL if needed.',
        });
        return;
      }
      send(res, 200, {
        reachable: true,
        mapped: true,
        title: resolved.title,
        offlineReady: true,
        questionCount: resolved.fields.length,
        fields: resolved.fields,
        source: resolved.source,
        resolvedUrl: resolved.resolvedUrl,
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/ai/drafts') {
      const fields = (Array.isArray(body.fields) ? body.fields : []) as FormField[];
      if (!fields.length) {
        send(res, 400, { message: 'Inspect the Kobo form first; no questionnaire definition is available' });
        return;
      }

      const count = Math.max(1, Math.min(100, Number(body.count) || 1));
      const project = (body.project || {}) as AnyRecord;
      const sources = Array.isArray(body.sources) ? body.sources : [];
      const output: Draft[] = [];

      // Run independent 20-record AI batches in parallel so a 100-record
      // compile uses five concurrent model calls instead of five sequential calls.
      const batches = chunks(count, 20);
      const batchOutputs = await Promise.all(
        batches.map(batch =>
          generate(
            project,
            fields,
            batch,
            String(body.ageMix || ''),
            String(body.majority || ''),
            sources
          )
        )
      );

      batchOutputs.forEach((aiOutput, batchIndex) => {
        const batch = batches[batchIndex];
        batch.forEach((recordIndex, offset) => {
          const generated = aiOutput?.drafts?.[offset];
          const map = new Map(
            (generated?.fields || []).map((field: any) => [String(field.name || ''), field])
          );

          output.push({
            projectId: String(project.id || ''),
            label:
              String(generated?.label || '') ||
              'Synthetic QA fixture ' + String(recordIndex + 1).padStart(3, '0'),
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

      const ids = await insert('drafts', output as AnyRecord[], authUser!);
      send(res, 200, {
        drafts: output.map((draft, index) => ({ ...draft, id: ids[index] })),
        mode: 'synthetic',
        questionCount: fields.length,
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/drafts/confirm-all') {
      const projectId = String(body.projectId || '');
      const items = (await list<Draft>('drafts', authUser!, 500)).filter(draft => draft.projectId === projectId);

      if (!projectId || !items.length) {
        send(res, 400, { message: 'No records found for this project' });
        return;
      }

      if (
        items.some(
          draft =>
            !draft.fields.length ||
            draft.fields.some(field => !field.name || !field.value) ||
            draft.fields.some(field => field.status === 'rejected')
        )
      ) {
        send(res, 400, { message: 'Resolve rejected or incomplete fields before final confirmation.' });
        return;
      }

      await Promise.all(
        items.map(draft =>
          update(String(draft.id), {
            ...draft,
            status: 'confirmed',
            fields: draft.fields.map(field => ({ ...field, status: 'approved' })),
          })
        )
      );

      send(res, 200, {
        confirmed: true,
        message: 'Everything is confirmed. Controlled package preparation is unlocked.',
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/drafts/export') {
      const projectId = String(body.projectId || '');
      const items = (await list<Draft>('drafts', authUser!, 500)).filter(draft => draft.projectId === projectId);

      if (!items.length) {
        send(res, 400, { message: 'No records found for this project' });
        return;
      }

      if (items.some(draft => draft.status !== 'confirmed' && draft.status !== 'deployed')) {
        send(res, 409, { message: 'Export locked until every record is confirmed' });
        return;
      }

      send(res, 200, {
        filename: 'fieldmind-reviewed-synthetic-qa.csv',
        csv: toCsv(items),
        recordCount: items.length,
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/drafts/deploy') {
      const projectId = String(body.projectId || '');
      const items = (await list<Draft>('drafts', 500)).filter(draft => draft.projectId === projectId);

      if (!items.length) {
        send(res, 400, { message: 'No records found for this project' });
        return;
      }

      if (items.some(draft => draft.status !== 'confirmed' && draft.status !== 'deployed')) {
        send(res, 409, { message: 'Package preparation locked until every record is confirmed' });
        return;
      }

      await Promise.all(
        items.map(draft => update(String(draft.id), { ...draft, status: 'deployed' }))
      );

      send(res, 200, {
        deployed: true,
        packagePrepared: true,
        message: 'Controlled synthetic QA package prepared. No live Kobo submission was performed.',
      });
      return;
    }

    send(res, 404, { message: 'Route not found: ' + path });
  } catch (error) {
    console.error('FieldMind API error', error);
    send(res, 500, {
      message: error instanceof Error ? error.message : 'Internal server error',
    });
  }
}
