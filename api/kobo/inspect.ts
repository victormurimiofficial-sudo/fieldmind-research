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
      calculation: attr(raw, 'calculate') || attr(raw, 'jr:calculate'),\n      readonly: attr(raw, 'readonly'),
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

  // KPI v2 requires an API token for authenticated asset/XForm access.
  // Fail explicitly instead of allowing an unauthenticated request to surface
  // as a misleading 404 "Asset UID not found" message.
  if (uid && !auth) {
    return {
      failure: true,
      uid,
      shareId,
      statuses: [{ endpoint: 'authentication', status: 401 }],
    };
  }
  // ee.kobotoolbox.org is Enketo's web-form host, not the KPI v2 API host.
  // For a generic ee /x/ link, try both supported KPI servers instead of
  // incorrectly forcing the form to the EU server.
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
  const statuses: Array<{ endpoint: string; status: number; contentType?: string }> = [];
  let assetStatus: number | undefined;

  // Validate the supplied token against Kobo itself before interpreting any
  // asset 404. This prevents an invalid/expired key from being misreported as
  // an Asset UID problem.
  const authenticatedBases: string[] = [];
  if (auth) {
    for (const base of bases) {
      try {
        const me = await fetchText(base + '/me/', headers);
        statuses.push({
          endpoint: ('me:' + base).replace(/^https?:\/\//, ''),
          status: me.response.status,
          contentType: me.response.headers.get('content-type') || undefined,
        });
        if (me.response.ok) authenticatedBases.push(base);
      } catch {}
    }
    if (!authenticatedBases.length) {
      return {
        failure: true,
        uid,
        shareId,
        statuses,
      };
    }
  }

  const apiBases = authenticatedBases.length ? authenticatedBases : bases;

  if (uid) {
    for (const base of apiBases) {
      // The deployed XForm endpoint is the authoritative questionnaire
      // definition. Try it first instead of depending on asset metadata shape.
      const directCandidates = [
        base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform/',
        base + '/api/v2/assets/' + encodeURIComponent(uid) + '.xml',
        base + '/api/v2/assets/' + encodeURIComponent(uid) + '/xform.xml',
      ];

      for (const endpoint of directCandidates) {
        try {
          const result = await fetchText(endpoint, headers);
          statuses.push({
            endpoint: endpoint.replace(/https?:\/\//, ''),
            status: result.response.status,
            contentType: result.response.headers.get('content-type') || undefined,
          });
          if (!result.response.ok) continue;

          const parsed = parseXForm(result.text);
          if (parsed.fields.length) {
            return { ...parsed, source: 'Kobo API XForm', resolvedUrl: result.response.url || endpoint };
          }
        } catch {}
      }

      // Secondary route: asset metadata exposes the canonical xform_link.
      try {
        const metadataResult = await fetchText(
          base + '/api/v2/assets/' + encodeURIComponent(uid) + '/',
          headers
        );
        assetStatus = metadataResult.response.status;
        statuses.push({
          endpoint: ('asset:' + base).replace(/https?:\/\//, ''),
          status: metadataResult.response.status,
          contentType: metadataResult.response.headers.get('content-type') || undefined,
        });

        if (metadataResult.response.ok) {
          try {
            const metadata = JSON.parse(metadataResult.text) as AnyRecord;
            const candidates = [
              typeof metadata.xform_link === 'string' ? metadata.xform_link : '',
              typeof metadata.downloads?.find === 'function'
                ? metadata.downloads.find((item: AnyRecord) =>
                    /xform/i.test(String(item?.format || item?.type || ''))
                  )?.url || ''
                : '',
            ].filter(Boolean);

            for (const endpoint of Array.from(new Set(candidates))) {
              try {
                const result = await fetchText(endpoint, headers);
                statuses.push({
                  endpoint: endpoint.replace(/https?:\/\//, ''),
                  status: result.response.status,
                  contentType: result.response.headers.get('content-type') || undefined,
                });
                if (!result.response.ok) continue;

                const parsed = parseXForm(result.text);
                if (parsed.fields.length) {
                  return { ...parsed, source: 'Kobo API XForm', resolvedUrl: result.response.url || endpoint };
                }
              } catch {}
            }
          } catch {}
        }
      } catch {}
    }
  }

  // Some Kobo deployments return 404 for a direct XForm download even though
  // the authenticated asset is accessible. Verify the UID through the official
  // survey list and use the XForm link exposed by the asset serializer as a
  // second, authoritative resolution path.
  if (uid && auth) {
    for (const base of apiBases) {
      try {
        let next = base + '/api/v2/assets/?asset_type=survey&limit=100';
        const seenPages = new Set<string>();
        let matchedAsset: AnyRecord | null = null;

        while (next && !seenPages.has(next) && seenPages.size < 10) {
          seenPages.add(next);
          const result = await fetchText(next, headers);
          statuses.push({
            endpoint: ('assets-list-for-uid:' + next).replace(/^https?:\/\//, ''),
            status: result.response.status,
            contentType: result.response.headers.get('content-type') || undefined,
          });
          if (!result.response.ok) break;

          const data = JSON.parse(result.text) as AnyRecord;
          const results = Array.isArray(data?.results) ? data.results : [];
          matchedAsset = results.find(item => String(item?.uid || '') === uid) || null;
          if (matchedAsset) break;

          const nextUrl = typeof data?.next === 'string' ? data.next : '';
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
            statuses.push({
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
              };
            }
          } catch {}
        }
      } catch {}
    }
  }

  // A /x/<id> share link does not expose the v2 Asset UID in the URL.
  // When the user supplies their Kobo API key, give them a safe project picker
  // from the surveys they are actually allowed to access instead of making
  // them understand Kobo's internal identifiers.
  if (!uid && shareId && auth) {
    // Kobo's v2 asset response exposes the deployed web-form link under
    // deployment__links. That link contains the same /x/<shareId> value the
    // user pasted. Use it to resolve the Asset UID automatically instead of
    // making the user understand Kobo's internal IDs.
    for (const base of apiBases) {
      try {
        let next = base + '/api/v2/assets/?asset_type=survey&limit=100';
        const candidates: AnyRecord[] = [];
        const seenPages = new Set<string>();

        while (next && !seenPages.has(next) && seenPages.size < 10) {
          seenPages.add(next);
          const result = await fetchText(next, headers);
          statuses.push({
            endpoint: ('assets-list:' + next).replace(/^https?:\\/\\//, ''),
            status: result.response.status,
            contentType: result.response.headers.get('content-type') || undefined,
          });
          if (!result.response.ok) break;

          const data = JSON.parse(result.text) as AnyRecord;
          const results = Array.isArray(data?.results) ? data.results : [];

          for (const item of results) {
            const uidValue = String(item?.uid || '');
            const nameValue = String(item?.name || item?.settings?.name || item?.title || '').trim();
            if (!uidValue || !nameValue) continue;

            const deployedLinks = item?.deployment__links && typeof item.deployment__links === 'object'
              ? Object.values(item.deployment__links).filter((value): value is string => typeof value === 'string')
              : [];
            const searchableUrls = [
              String(item?.url || ''),
              String(item?.xform_link || ''),
              ...deployedLinks,
            ].filter(Boolean);

            if (searchableUrls.some(value => value.toLowerCase().includes('/x/' + shareId.toLowerCase()))) {
              return await inspect(url, uidValue, token);
            }

            candidates.push({ uid: uidValue, name: nameValue, url: String(item?.url || '').trim() });
          }

          const nextUrl = typeof data?.next === 'string' ? data.next : '';
          next = nextUrl && nextUrl.startsWith(base) ? nextUrl : '';
        }

        // If the account has exactly one accessible survey and Kobo did not
        // expose the share link in the list response, resolve it directly.
        // This keeps the common single-project case one-click.
        if (candidates.length === 1) {
          return await inspect(url, candidates[0].uid, token);
        }

        if (candidates.length) {
          return {
            needsSelection: true,
            candidates,
            shareId,
            source: 'Kobo API project list',
            statuses,
          };
        }
      } catch {}
    }
  }

  // A /x/<id> value is a web-form share identifier, not the v2 Asset UID.
  // It is still a valid one-link input: try the public web form itself.
  try {
    const result = await fetchText(url);
    statuses.push({
      endpoint: 'web-form:' + url.replace(/^https?:\/\//, ''),
      status: result.response.status,
      contentType: result.response.headers.get('content-type') || undefined,
    });

    if (result.response.ok) {
      const parsed = parseXForm(result.text);
      if (parsed.fields.length) {
        return { ...parsed, source: 'Kobo web form XForm', resolvedUrl: result.response.url || url };
      }

      const extracted = await extractFromPage(result.text);
      if (extracted?.fields?.length) {
        return {
          title: extracted.title || 'KoboToolbox form',
          fields: extracted.fields as FormField[],
          source: 'Kobo web form structured extraction',
          resolvedUrl: result.response.url || url,
        };
      }
    }
  } catch {}

  return { failure: true, uid, shareId, statuses, assetStatus };
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

    let resolved = await inspect(url, source, token);
    if ((resolved as any)?.needsSelection) {
      send(res, 200, {
        reachable: true,
        mapped: false,
        needsSelection: true,
        shareId: (resolved as any).shareId || '',
        candidates: (resolved as any).candidates || [],
        questionCount: 0,
        fields: [],
        message: 'This /x/ link is valid, but Kobo identifies the project separately from the share link. Select the matching project below; FieldMind will then retrieve its XForm automatically.',
      });
      return;
    }
    if (!resolved || (resolved as any).failure) {
      const failure = resolved as any;
      const statuses = Array.isArray(failure?.statuses) ? failure.statuses : [];
      const authRequired = statuses.some((item: any) => item.status === 401 || item.status === 403);
      const notFound = Number(failure?.assetStatus) === 404;

      if (!failure?.uid && failure?.shareId) {
        send(res, 422, {
          reachable: true,
          mapped: false,
          code: authRequired ? 'KOBO_AUTH_REQUIRED' : 'ASSET_UID_REQUIRED',
          questionCount: 0,
          fields: [],
          shareId: failure.shareId,
          needsAssetUid: true,
          diagnostics: statuses,
          message: authRequired
            ? 'Kobo requires authentication for the questionnaire definition. Enter your Kobo API key in Advanced options.'
            : 'The /x/ link is a web-form share link. FieldMind could not resolve its questionnaire definition automatically. You can instead paste the Kobo Summary URL containing #/forms/<Asset UID>/summary.',
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
        diagnostics: statuses,
        message: authRequired
          ? 'Kobo requires an API key to read this questionnaire definition. Enter the Kobo API key in Advanced options.'
          : notFound && failure?.uid
            ? 'Kobo could not find that Asset UID on the selected server. Check that the Summary URL belongs to the same Kobo server.'
            : failure?.uid
              ? 'Kobo exposed the project but FieldMind could not retrieve a usable XForm. The endpoint diagnostics are included so the integration can be fixed without guessing.'
              : 'FieldMind could not resolve the questionnaire definition from this web-form link. Paste the Kobo Summary URL if the form is private or its public web page does not expose the definition.',
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
