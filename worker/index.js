// sur-ai Worker — Gemini (AQ. auth key) + Llama fallback
// Variable/Secret: GEMINI_KEY   |   Binding: AI (Workers AI)

const GEMINI_MODEL = 'gemini-flash-latest'; // পুরনো নাম বন্ধ হলেও এটা সবসময় চলে
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

async function callGemini(env, messages, now) {
  if (!env.GEMINI_KEY) throw new Error('GEMINI_KEY সেট নেই');

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
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
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
            maxOutputTokens: 2048,
            responseMimeType: 'application/json',
          },
        }),
      }
    );
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = (d.error && (d.error.message || d.error.status)) || '';
      throw new Error(`Gemini ${r.status} ${String(msg).slice(0, 80)}`);
    }
    const text = (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) throw new Error('Gemini খালি উত্তর দিল');
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
      err = e && e.name === 'AbortError' ? 'Gemini টাইমআউট' : String((e && e.message) || e);
    }

    try {
      const r = await callLlama(env, messages, now);
      return json({ ...r, via: 'llama', err });
    } catch (e) {
      return json({ reply: 'এখন উত্তর দিতে পারছি না, একটু পরে চেষ্টা করো।', q: '', via: 'none', err: err + ' | ' + String((e && e.message) || e) });
    }
  },
};

