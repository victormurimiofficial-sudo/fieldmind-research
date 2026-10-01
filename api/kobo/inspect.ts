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
  const match = source.match(new RegExp("\\b" + key + "=[\\\"']([^\\\"']*)[\\\"']", "i"));
  return match?.[1] || '';
}

function uidFrom(value: string) {
  const match = value.match(/(?:\/x\/|\/forms\/|\/assets\/)([A-Za-z0-9_-]+)/);
  if (match?.[1]) return match[1];
  return /^[A-Za-z0-9_-]+$/.test(value.trim()) ? value.trim() : '';
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
      'User-Agent': 'FieldMind-Research/7.0',
      Accept: 'application/xml,text/xml,text/html,application/json',
      ...headers,
    },
  });
  return { response, text: await response.text() };
}

async function inspect(url: string, source: string, token: string) {
  const uid = uidFrom(source) || uidFrom(url);
  const auth = token || process.env.KOBO_API_TOKEN || '';
  const headers = auth ? { Authorization: 'Token ' + auth } : {};
  const inputHost = (() => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } })();
  const preferred = inputHost === 'ee.kobotoolbox.org' ? 'https://eu.kobotoolbox.org'
    : inputHost === 'eu.kobotoolbox.org' ? 'https://eu.kobotoolbox.org'
    : inputHost === 'kf.kobotoolbox.org' ? 'https://kf.kobotoolbox.org'
    : '';
  const bases = Array.from(new Set([
    preferred,
    'https://eu.kobotoolbox.org',
    'https://kf.kobotoolbox.org',
  ].filter(Boolean)));

  if (uid) {
    for (const base of bases) {
      try {
        const metadataResult = await fetchText(base + '/api/v2/assets/' + encodeURIComponent(uid) + '/', headers);
        if (!metadataResult.response.ok) continue;
        const metadata = JSON.parse(metadataResult.text) as AnyRecord;
        const candidates = [
          typeof metadata.xform_link === 'string' ? metadata.xform_link : '',
          typeof metadata.deployment?.xform_link === 'string' ? metadata.deployment.xform_link : '',
          typeof metadata.downloads?.find === 'function'
            ? metadata.downloads.find((item: AnyRecord) => item?.format === 'xform')?.url || ''
            : '',
          base + '/api/v2/assets/' + encodeURIComponent(uid) + '.xml',
          base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform/',
          base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform.xml',
          base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform/?format=xml',
        ].filter(Boolean);

        for (const endpoint of Array.from(new Set(candidates))) {
          try {
            const result = await fetchText(endpoint, headers);
            if (!result.response.ok) continue;
            const parsed = parseXForm(result.text);
            if (parsed.fields.length) return { ...parsed, source: 'Kobo API XForm', resolvedUrl: result.response.url };
          } catch {}
        }
      } catch {}
    }
  }

  // The /x/{id} share URL is an Enketo web-form shell. If the API is unavailable,
  // also try the server's XML form endpoints using the UID extracted above.
  if (uid) {
    for (const base of bases) {
      for (const endpoint of [
        base + '/api/v2/assets/' + encodeURIComponent(uid) + '.xml',
        base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform/',
        base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform.xml',
      ]) {
        try {
          const result = await fetchText(endpoint, headers);
          if (!result.response.ok) continue;
          const parsed = parseXForm(result.text);
          if (parsed.fields.length) return { ...parsed, source: 'Kobo XML form endpoint', resolvedUrl: result.response.url };
        } catch {}
      }
    }
  }

  try {
    const result = await fetchText(url);
    if (!result.response.ok) return null;
    const parsed = parseXForm(result.text);
    if (parsed.fields.length) return { ...parsed, source: 'Kobo web form XForm', resolvedUrl: result.response.url };
  } catch {}

  return null;
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
    if (!safeKoboUrl(url)) {
      send(res, 400, { message: 'Use a valid KoboToolbox HTTPS form URL' });
      return;
    }

    const resolved = await inspect(url, String(body.assetUid || ''), String(body.apiToken || ''));
    if (!resolved) {
      send(res, 422, {
        reachable: true,
        mapped: false,
        questionCount: 0,
        fields: [],
        needsAssetUid: !body.assetUid,
        message: 'Kobo was reached, but its questionnaire definition could not be resolved. Paste the Kobo project URL or Asset UID for exact mapping.',
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
