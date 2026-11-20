// sur-ai Worker — Gemini (AQ. auth key) + Llama fallback
// Variable/Secret: GEMINI_KEY   |   Binding: AI (Workers AI)   |   ঐচ্ছিক Variable: GEMINI_MODELS

// Gemini মডেল তালিকা: আগেরটা না চললে পরেরটা নিজে থেকে চেষ্টা হবে।
// চাইলে Cloudflare Variable GEMINI_MODELS (কমা দিয়ে) দিয়ে বদলানো যায়।
const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
};

const SYSTEM = `তুমি "সুরানি", সুর প্লেয়ার অ্যাপের বাংলা এআই সহকারী। তুমি গান নিয়ে যেমন সাহায্য করো, তেমনি যেকোনো বিষয়ের প্রশ্নের (সাধারণ জ্ঞান, পড়াশোনা, প্রযুক্তি, জীবনযাপন, গল্প, আলোচনা) পুরো উত্তর দাও। ইউজার যে ভাষায় লিখবে সেই ভাষায় উত্তর দেবে, ডিফল্ট বাংলা। উত্তর স্পষ্ট ও বন্ধুসুলভ হবে; সাধারণ প্রশ্নে সংক্ষিপ্ত, জটিল প্রশ্নে প্রয়োজনমতো বিস্তারিত।
শুধু যখন ইউজার কোনো গান বাজাতে/শুনতে/খুঁজতে চায়, তখন "q"-তে গানের নাম ও শিল্পী লিখবে ("প্লে করো", "ইউটিউব", "ফ্রি" ইত্যাদি শব্দ বাদ দিয়ে) এবং reply-তে এক বাক্যে বলবে যে বাজাচ্ছ। গান বাজানোর সোর্স (ইউটিউব/ফ্রি) কখনো জিজ্ঞেস করবে না, অ্যাপ নিজেই বাজাবে। গান না চাইলে "q" খালি রাখবে।
শুধু এই JSON ফরম্যাটে উত্তর দাও: {"reply":"...","q":"..."}`;

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
  });

function unesc(s) {
  return s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\t/g, ' ').replace(/\\\\/g, '\\');
}

function parseOut(text) {
  const t = String(text || '').replace(/```json|```/g, '').trim();
  const pick = (j) => ({ reply: String(j.reply || ''), q: String(j.q || '') });
  try {
    return pick(JSON.parse(t));
  } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      return pick(JSON.parse(m[0]));
    } catch {}
  }
  // কেটে যাওয়া/ভাঙা JSON হলেও reply অংশটুকু বের করে আনো
  const r = t.match(/"reply"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (r) {
    const q = t.match(/"q"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return { reply: unesc(r[1]), q: q ? unesc(q[1]) : '' };
  }
  return { reply: t, q: '' };
}

class GeminiError extends Error {
  constructor(msg, status) {
    super(msg);
    this.status = status;
  }
}

async function callGemini(env, messages, now) {
  if (!env.GEMINI_KEY) throw new Error('GEMINI_KEY সেট নেই');
  const models = (env.GEMINI_MODELS ? String(env.GEMINI_MODELS).split(',') : GEMINI_MODELS).map((x) => x.trim()).filter(Boolean);
  const errs = [];
  for (const model of models) {
    try {
      return await callGeminiModel(env, model, messages, now);
    } catch (e) {
      const m = e && e.name === 'AbortError' ? 'টাইমআউট' : String((e && e.message) || e);
      errs.push(`${model}: ${m}`);
      // কী ভুল/নিষিদ্ধ হলে অন্য মডেলেও একই ফল, তাই থামো
      if (e && (e.status === 401 || e.status === 403)) break;
    }
  }
  throw new Error(errs.join(' | '));
}

async function callGeminiModel(env, model, messages, now) {

  const contents = messages
    .filter((m) => m && m.content && String(m.content).trim())
    .slice(-12)
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content) }],
    }));
  if (!contents.length) throw new Error('খালি মেসেজ');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': env.GEMINI_KEY, // AQ. key এভাবেই পাঠাতে হয় (Bearer নয়)
        },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: SYSTEM + (now ? `\nএখন বাজছে: ${now}` : '') }],
          },
          contents,
          generationConfig: {
            temperature: 0.8,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
          },
        }),
      }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (d.error && (d.error.message || d.error.status)) || '';
      throw new GeminiError(`HTTP ${r.status} ${String(msg).slice(0, 80)}`, r.status);
    }
    const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error('খালি উত্তর');
    return parseOut(text);
  } finally {
    clearTimeout(timer);
  }
}

async function callLlama(env, messages, now) {
  const msgs = [
    { role: 'system', content: SYSTEM + (now ? `\nএখন বাজছে: ${now}` : '') },
    ...messages
      .filter((m) => m && m.content)
      .slice(-8)
      .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) })),
  ];
  const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages: msgs, max_tokens: 600 });
  return parseOut(out.response);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ ok: true, hint: 'POST {messages, now}' });

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
      const r = await callGemini(env, messages, now);
      return json({ ...r, via: 'gemini' });
    } catch (e) {
      err = String((e && e.message) || e);
    }

    try {
      const r = await callLlama(env, messages, now);
      return json({ ...r, via: 'llama', err });
    } catch (e) {
      return json({ reply: 'এখন উত্তর দিতে পারছি না, একটু পরে চেষ্টা করো।\n\n(কারণ: ' + (err + ' | llama: ' + String((e && e.message) || e)).slice(0, 300) + ')', q: '', via: 'none', err: err + ' | llama: ' + String((e && e.message) || e) });
    }
  },
};
