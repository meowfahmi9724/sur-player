// sur-ai Worker — Gemini (স্ট্রিমিং, দ্রুত) + Llama fallback
// Variable/Secret: GEMINI_KEY   |   Binding: AI (Workers AI)   |   ঐচ্ছিক Variable: GEMINI_MODELS
//
// স্ট্রিমিং ফরম্যাট (অ্যাপের সাথে মেলানো): উত্তরের লেখা আসতে থাকে, শেষে \u0001 + JSON {"q","via","err"}

const GEMINI_MODELS = ['gemini-3.1-flash-lite', 'gemini-flash-latest', 'gemini-3.5-flash'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

const SYSTEM = `তুমি "সুরানি", সুর প্লেয়ার অ্যাপের বাংলা এআই সহকারী ও ইউজারের বন্ধু। যেকোনো বিষয়ে (গান, সাধারণ জ্ঞান, পড়াশোনা, প্রযুক্তি, জীবনযাপন, গল্প) সাহায্য করো। ইউজার যে ভাষায় লিখবে সেই ভাষায় উত্তর দেবে, ডিফল্ট বাংলা।
সম্ভাষণ: ইউজার হাই/হ্যালো/সালাম বললে বা কথা শুরু করলে "আসসালামু আলাইকুম" বলে সম্ভাষণ করবে (সালামের জবাবে "ওয়ালাইকুম আসসালাম")। কখনো "নমস্কার" বা "নমস্তে" বলবে না।
অ্যাপ-নিয়ন্ত্রণ: টিভি চ্যানেল চালানো, রেডিও/সিনেমা/সেটিং খোলা, থিম-মোড বদলানো, পরের/আগের গান, ভলিউম, স্লিপ টাইমার — এসব কমান্ড অ্যাপ নিজেই চালায়। ইউজার এমন কিছু চাইলে "পারব না" বলবে না; বলবে একটু সহজ করে বলতে, যেমন "মাইটিভি চালু করো" বা "ডার্ক মোড দাও"।
স্টাইল: মানুষের মতো স্বাভাবিকভাবে কথা বলো। সাধারণ কথায় ১–২ ছোট বাক্য; জটিল প্রশ্নে প্রয়োজনমতো একটু বিস্তারিত। প্রতিবার নতুন করে, নিজের ভাষায় বলো — আগের উত্তরের শুরু বা বাঁধা বাক্য ("অবশ্যই!", "ঠিক আছে" ইত্যাদি) বারবার ব্যবহার করবে না। মার্কডাউন, তারকা চিহ্ন বা JSON ব্যবহার করবে না, সাধারণ লেখা দেবে।
গান: শুধু যখন ইউজার গান বাজাতে/শুনতে/খুঁজতে চায়, তখন উত্তরে খুব ছোট এক বাক্য লিখবে (যেমন কোন গান বাজাচ্ছ), তারপর একদম শেষে নতুন লাইনে লিখবে [[PLAY: গানের নাম শিল্পী]] ("প্লে করো", "ইউটিউব", "ফ্রি" শব্দ বাদ দিয়ে)। সোর্স (ইউটিউব/ফ্রি) কখনো জিজ্ঞেস করবে না, অ্যাপ নিজেই ঠিক করবে এবং নিজেই জানাবে। গান না চাইলে [[PLAY:]] লিখবে না।`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

// লেখা থেকে [[PLAY: ...]] আলাদা করা
function splitOut(text) {
  const t = String(text || '');
  const m = t.match(/\[\[PLAY:\s*([^\]]*)\]\]/);
  const i = t.indexOf('[[');
  return { reply: (i >= 0 ? t.slice(0, i) : t).trim(), q: m ? m[1].trim() : '' };
}

class GeminiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

function toContents(messages) {
  return messages
    .filter((m) => m && m.content && String(m.content).trim())
    .slice(-8)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content) }],
    }));
}

// একটি মডেলে স্ট্রিম খোলা (৭ সেকেন্ডে সাড়া না এলে বাদ)
async function openModel(env, model, contents, now) {
  for (const think of [true, false]) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const gc = { temperature: 0.9, maxOutputTokens: 500 };
      if (think) gc.thinkingConfig = { thinkingBudget: 0 }; // ভাবার সময় বাঁচাতে; না চললে নিচে ছাড়া চেষ্টা হবে
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_KEY },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: SYSTEM + (now ? `\nএখন বাজছে: ${now}` : '') }] },
            contents,
            generationConfig: gc,
          }),
        }
      );
      if (r.ok) return r;
      if (r.status === 400 && think) continue;
      const d = await r.json().catch(() => ({}));
      const msg = (d.error && (d.error.message || d.error.status)) || '';
      throw new GeminiError(`HTTP ${r.status} ${String(msg).slice(0, 80)}`, r.status);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('খোলা গেল না');
}

async function openGemini(env, messages, now) {
  if (!env.GEMINI_KEY) throw new Error('GEMINI_KEY সেট নেই');
  const contents = toContents(messages);
  if (!contents.length) throw new Error('খালি মেসেজ');
  const models = (env.GEMINI_MODELS ? String(env.GEMINI_MODELS).split(',') : GEMINI_MODELS).map((x) => x.trim()).filter(Boolean);
  const errs = [];
  for (const model of models) {
    try {
      return await openModel(env, model, contents, now);
    } catch (e) {
      errs.push(`${model}: ${e && e.name === 'AbortError' ? 'টাইমআউট' : String((e && e.message) || e)}`);
      if (e && (e.status === 401 || e.status === 403)) break;
    }
  }
  throw new Error(errs.join(' | '));
}

async function callLlama(env, messages, now) {
  const msgs = [
    { role: 'system', content: SYSTEM + (now ? `\nএখন বাজছে: ${now}` : '') },
    ...messages
      .filter((m) => m && m.content)
      .slice(-6)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
  ];
  const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages: msgs, max_tokens: 400 });
  return splitOut(out.response);
}

// Gemini-র SSE থেকে লেখা বের করে সঙ্গে সঙ্গে অ্যাপে পাঠানো
function streamResponse(gr) {
  const { readable, writable } = new TransformStream();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const run = (async () => {
    let full = '', em = 0, err = '';
    const flush = (final) => {
      const i = full.indexOf('[[');
      let end = i >= 0 ? i : final ? full.length : full.endsWith('[') ? full.length - 1 : full.length;
      if (end > em) {
        w.write(enc.encode(full.slice(em, end)));
        em = end;
      }
    };
    try {
      const rd = gr.body.getReader(), dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let k;
        while ((k = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, k).trim();
          buf = buf.slice(k + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const d = JSON.parse(line.slice(5));
            full += (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
            flush(false);
          } catch {}
        }
      }
    } catch (e) {
      err = String((e && e.message) || e);
    }
    flush(true);
    const { q } = splitOut(full);
    await w.write(enc.encode('\u0001' + JSON.stringify({ q, via: 'gemini', err })));
    await w.close();
  })();
  return { readable, run };
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ ok: true, hint: 'POST {messages, now, stream}' });

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ reply: '', err: 'JSON ভুল' }, 400);
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const now = body.now || '';

    let err = '';
    try {
      const gr = await openGemini(env, messages, now);
      if (body.stream) {
        const { readable, run } = streamResponse(gr);
        ctx.waitUntil(run);
        return new Response(readable, {
          headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...CORS },
        });
      }
      // স্ট্রিম ছাড়া অনুরোধ: পুরোটা জমিয়ে JSON দেওয়া
      const txt = await gr.text();
      let full = '';
      for (const l of txt.split('\n')) {
        if (!l.startsWith('data:')) continue;
        try {
          full += (JSON.parse(l.slice(5)).candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
        } catch {}
      }
      return json({ ...splitOut(full), via: 'gemini' });
    } catch (e) {
      err = String((e && e.message) || e);
    }

    try {
      const r = await callLlama(env, messages, now);
      return json({ ...r, via: 'llama', err });
    } catch (e) {
      const all = err + ' | llama: ' + String((e && e.message) || e);
      return json({ reply: 'এখন উত্তর দিতে পারছি না, একটু পরে চেষ্টা করো।\n\n(কারণ: ' + all.slice(0, 300) + ')', q: '', via: 'none', err: all });
    }
  },
};
