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

function assetUidFrom(value: string) {
  const raw = String(value || '').trim();
  const match = raw.match(/(?:\/forms\/|\/assets\/)([A-Za-z0-9_-]+)/i);
  if (match?.[1]) return match[1];
  const hashMatch = raw.match(/#\/forms\/([A-Za-z0-9_-]+)/i);
  if (hashMatch?.[1]) return hashMatch[1];
  return /^[A-Za-z0-9_-]{12,}$/.test(raw) ? raw : '';
}

function shareIdFrom(value: string) {
  const match = String(value || '').match(/\/x\/([A-Za-z0-9_-]+)/i);
  return match?.[1] || '';
}

function safeKoboUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      (url.hostname.endsWith('kobotoolbox.org') || url.hostname.endsWith('humanitarianresponse.info'));
  } catch {
    return false;
  }
}

function parseXForm(xml: string): { title: string; fields: FormField[] } {
  const title = clean(xml.match(/<(?:h:)?title[^>]*>([\s\S]*?)<\/(?:h:)?title>/i)?.[1] || '') || 'KoboToolbox form';
  const binds = new Map<string, AnyRecord>();

  for (const match of xml.matchAll(/<(?:bind|xf:bind)\b([^>]*)\/?>(?:<\/(?:bind|xf:bind)>)?/gi)) {
    const raw = match[1] || '';
    const ref = attr(raw, 'nodeset') || attr(raw, 'ref');
    if (!ref) continue;
    binds.set(ref, {
      type: attr(raw, 'type'),
      required: attr(raw, 'required'),
      relevant: attr(raw, 'relevant'),
      constraint: attr(raw, 'constraint'),
      calculation: attr(raw, 'calculate') || attr(raw, 'jr:calculate'),
    });
  }

  const fields: FormField[] = [];
  const seen = new Set<string>();

  const addField = (ref: string, fallbackType: string, body: string) => {
    const name = ref.replace(/^\//, '').replace(/^data\//, '');
    if (!name || seen.has(name) || /^meta\//i.test(name)) return;
    const binding = binds.get(ref) || binds.get('/' + name) || binds.get(name) || {};
    const label = clean(body.match(/<(?:h:)?label\b[^>]*>([\s\S]*?)<\/(?:h:)?label>/i)?.[1] || '') ||
      name.replace(/[_-]+/g, ' ');

    const options: FormOption[] = [];
    for (const item of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
      const itemBody = item[1] || '';
      const value = itemBody.match(/<(?:h:)?value\b[^>]*>([\s\S]*?)<\/(?:h:)?value>/i)?.[1];
      if (!value) continue;
      const optionLabel = itemBody.match(/<(?:h:)?label\b[^>]*>([\s\S]*?)<\/(?:h:)?label>/i)?.[1] || value;
      options.push({ name: clean(value), label: clean(optionLabel) });
    }

    const type = binding.type || fallbackType || 'text';
    if (/calculate|note|hidden/i.test(type) || binding.calculation) return;
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
      if (binding.type && !/calculate|note|hidden/i.test(binding.type)) addField(ref, binding.type, '');
    }
  }
  return { title, fields };
}

async function fetchText(url: string, headers: AnyRecord = {}) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'FieldMind-Research/8.0',
      Accept: 'application/xml,text/xml,text/html,application/json',
      ...headers,
    },
  });
  return { response, text: await response.text() };
}

async function extractFromPage(html: string) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-5.6-luna',
      store: false,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: 'Extract only the questionnaire structure actually present in this KoboToolbox web-form page. Never invent a question, field name, choice, or answer. A /x/ share page may be an application shell; if no actual questionnaire structure is present, return an empty fields array.' }],
        },
        {
          role: 'user',
          content: [{ type: 'input_text', text: 'Kobo web-form HTML:\n' + clean(html).slice(0, 60000) }],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'kobo_form_definition',
          strict: true,
          schema: {
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
                    constraint: { type: 'string' },
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
                  required: ['name', 'label', 'type', 'required', 'relevant', 'constraint', 'options'],
                  additionalProperties: false,
                },
              },
            },
            required: ['title', 'fields'],
            additionalProperties: false,
          },
        },
      },
      max_output_tokens: 10000,
    }),
  });

  if (!response.ok) return null;
  const data = await response.json() as any;
  if (!data.output_text) return null;
  try {
    const parsed = JSON.parse(data.output_text);
    return Array.isArray(parsed?.fields) && parsed.fields.length ? parsed : null;
  } catch {
    return null;
  }
}

async function inspect(url: string, source: string, token: string) {
  const uid = assetUidFrom(source) || assetUidFrom(url);
  const shareId = shareIdFrom(source) || shareIdFrom(url);
  const auth = token || process.env.KOBO_API_TOKEN || '';
  const headers = auth ? { Authorization: 'Token ' + auth } : {};
  const inputHost = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  const preferred = inputHost === 'ee.kobotoolbox.org' || inputHost === 'eu.kobotoolbox.org'
    ? 'https://eu.kobotoolbox.org'
    : inputHost === 'kf.kobotoolbox.org'
      ? 'https://kf.kobotoolbox.org'
      : '';
  const bases = Array.from(new Set([preferred, 'https://eu.kobotoolbox.org', 'https://kf.kobotoolbox.org'].filter(Boolean)));
  const statuses: Array<{ endpoint: string; status: number }> = [];

  if (uid) {
    for (const base of bases) {
      try {
        const metadataResult = await fetchText(base + '/api/v2/assets/' + encodeURIComponent(uid) + '/', headers);
        statuses.push({ endpoint: 'asset:' + base, status: metadataResult.response.status });
        if (!metadataResult.response.ok) continue;
        const metadata = JSON.parse(metadataResult.text) as AnyRecord;
        const candidates = [
          typeof metadata.xform_link === 'string' ? metadata.xform_link : '',
          typeof metadata.deployment?.xform_link === 'string' ? metadata.deployment.xform_link : '',
          typeof metadata.downloads?.find === 'function' ? metadata.downloads.find((item: AnyRecord) => item?.format === 'xform')?.url || '' : '',
          base + '/api/v2/assets/' + encodeURIComponent(uid) + '.xml',
          base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform/',
          base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform.xml',
        ].filter(Boolean);

        for (const endpoint of Array.from(new Set(candidates))) {
          try {
            const result = await fetchText(endpoint, headers);
            statuses.push({ endpoint: endpoint.replace(/https?:\/\//, ''), status: result.response.status });
            if (!result.response.ok) continue;
            const parsed = parseXForm(result.text);
            if (parsed.fields.length) return { ...parsed, source: 'Kobo API XForm', resolvedUrl: result.response.url };
          } catch {}
        }
      } catch {}
    }
  }

  // A /x/<id> value is a public web-form share identifier, not the v2 asset UID.
  // Try the web form itself, but do not pretend its share id is an API asset id.
  try {
    const result = await fetchText(url);
    statuses.push({ endpoint: 'share:' + url.replace(/^https?:\/\//, ''), status: result.response.status });
    if (result.response.ok) {
      const parsed = parseXForm(result.text);
      if (parsed.fields.length) return { ...parsed, source: 'Kobo web form XForm', resolvedUrl: result.response.url };

      const extracted = await extractFromPage(result.text);
      if (extracted?.fields?.length) {
        return {
          title: extracted.title || 'KoboToolbox form',
          fields: extracted.fields as FormField[],
          source: 'Kobo web form structured extraction',
          resolvedUrl: result.response.url,
        };
      }
    }
  } catch {}

  return { failure: true, uid, shareId, statuses };
}

function send(res: any, status: number, payload: AnyRecord) {
  res.status(status)
    .setHeader('Content-Type', 'application/json; charset=utf-8')
    .setHeader('Cache-Control', 'no-store, max-age=0')
    .json(payload);
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
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const url = String(body.url || '');
    const source = String(body.assetUid || '');
    const token = String(body.apiToken || '');

    if (!safeKoboUrl(url)) {
      send(res, 400, { message: 'Use a valid KoboToolbox HTTPS form URL' });
      return;
    }

    const resolved = await inspect(url, source, token);
    if (!resolved || (resolved as any).failure) {
      const failure = resolved as any;
      const statuses = Array.isArray(failure?.statuses) ? failure.statuses : [];
      const authRequired = statuses.some((item: any) => item.status === 401 || item.status === 403);
      const notFound = statuses.some((item: any) => item.status === 404);

      if (!failure?.uid && failure?.shareId) {
        send(res, 422, {
          reachable: true,
          mapped: false,
          code: authRequired ? 'KOBO_AUTH_REQUIRED' : 'ASSET_UID_REQUIRED',
          questionCount: 0,
          fields: [],
          shareId: failure.shareId,
          needsAssetUid: true,
          message: authRequired
            ? 'Kobo requires authentication for the questionnaire definition. Enter your Kobo API key for this inspection.'
            : 'That /x/ link contains a web-form share ID, not the Kobo Asset UID. Open the Kobo project Summary page and paste the URL containing #/forms/<Asset UID>/summary, or paste the Asset UID itself.',
        });
        return;
      }

      send(res, 422, {
        reachable: true,
        mapped: false,
        code: authRequired ? 'KOBO_AUTH_REQUIRED' : notFound ? 'KOBO_ASSET_NOT_FOUND' : 'KOBO_XFORM_UNAVAILABLE',
        questionCount: 0,
        fields: [],
        assetUid: failure?.uid || '',
        needsAssetUid: !failure?.uid,
        message: authRequired
          ? 'Kobo requires an API key to read this questionnaire definition. Enter your Kobo API key in FieldMind; it is used only for this inspection.'
          : notFound && failure?.uid
            ? 'The supplied Asset UID was not found on the Kobo server. Check the Kobo project Summary URL and use the UID after #/forms/.'
            : 'Kobo is reachable, but its deployed XForm is not exposed through the supplied link. Use the Kobo project Summary URL or Asset UID. If the project is private, provide the Kobo API key.',
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
  } catch (error) {
    console.error('FieldMind Kobo inspect error', error);
    send(res, 500, { message: error instanceof Error ? error.message : 'Kobo inspection failed' });
  }
}
