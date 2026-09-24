/**
 * Peekiva "What Are We, Really?" — Cloudflare Worker backend
 * 中文说明: 计分/文案/付款验证只在服务端做。未付款拿不到完整结果。
 * 前端: GitHub Pages 或 Cloudflare Pages 静态页; 数据: D1; 付款: PayPal Orders API v2。
 *
 * 安全铁律:
 * - 价格只读环境变量 PRICE_USD, 忽略前端金额。
 * - 只有 PayPal 服务端返回 COMPLETED + 金额0.38 + 币种USD + custom_id一致才标记 paid。
 * - /api/result 需要 sessionId + token 鉴权, 且 paid 才能返回完整分析。
 * - 分享卡片只存可公开字段 (结果类型+四维分数+一句话描述), 与私人会话分离, 永久有效。
 * - 部署铁律: 每次上传脚本后 secrets 会被剥离, 必须逐条重绑 4 个 secrets。
 */

// ---------- scoring config (与前端 QUESTIONS 顺序一致: Q1-6 emo, Q7-12 effort, Q13-18 clarity, Q19-24 spark) ----------
const SCORE_MAP = [100, 66, 33, 0]; // A=100 B=66 C=33 D=0
const DIMS = ["emo", "effort", "clarity", "spark"];
const DIM_LABELS = {
  emo: "Emotional Connection",
  effort: "Mutual Effort",
  clarity: "Clarity & Communication",
  spark: "Romantic Potential",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------- result types: 六种结果集中配置 (判定规则只在这里, 不分散) ----------
const RESULT_TYPES = {
  "one-sided": {
    title: "One-Sided Investment",
    short: "You seem to be carrying most of the weight in this connection right now.",
    rule: "Mutual Effort \u2264 40 — your effort clearly outweighs what comes back.",
    sections: (d) => [
      {
        title: "Your Relationship Pattern",
        text: `The clearest pattern in your answers is imbalance. With Mutual Effort at ${d.effort}, you are the one reaching out first, keeping conversations alive, and turning vague ideas into actual plans far more often than they do. This does not mean your feelings are wrong or foolish — it means the dynamic runs on your energy. When one person consistently initiates, the other person never has to show what they would do on their own, and that leaves you guessing about something you deserve to simply know.`,
      },
      {
        title: "What Might Be Happening",
        text: `Your Emotional Connection (${d.emo}) and Romantic Potential (${d.spark}) may still feel very real, and that is exactly what makes this pattern so confusing: strong feelings can coexist with uneven effort. Often the other person enjoys the attention without matching it, whether from comfort, habit, or genuine but passive interest. Low Clarity & Communication (${d.clarity}) keeps the situation fuzzy enough that nothing has to change. Pay attention to what happens when you step back slightly — their response, or lack of one, tells you more than any mixed signal.`,
      },
      {
        title: "What You Can Do Next",
        text: `Try a gentle experiment: for the next week or two, match their energy instead of leading it. Text when they text, suggest plans as often as they do, and notice how that feels. If the connection fades the moment you stop fueling it, you have your answer — and it says nothing bad about you. You can also name what you need directly, once, in plain words, and watch what changes. Protect your time and warmth for connections that return them. You deserve reciprocity, not a part-time role in someone else's convenience.`,
      },
    ],
  },
  "emotional-dependence": {
    title: "Emotional Dependence",
    short: "The bond feels intense, but it may be leaning on emotion more than steady ground.",
    rule: "Emotional Connection \u2265 60, Mutual Effort \u2264 55, Clarity & Communication \u2264 55.",
    sections: (d) => [
      {
        title: "Your Relationship Pattern",
        text: `Your connection runs high on feeling — Emotional Connection at ${d.emo} shows this person genuinely matters to you, and the contact between you may be frequent and intense. But the foundation underneath looks shaky: Mutual Effort (${d.effort}) and Clarity & Communication (${d.clarity}) both lag behind the emotions. That combination often creates a loop where the highs feel euphoric and the quiet moments feel anxious, and you keep returning for reassurance rather than building something stable together.`,
      },
      {
        title: "What Might Be Happening",
        text: `Intensity is not the same as security. When communication stays vague (${d.clarity}) and effort is uneven (${d.effort}), the brain fills the gaps with longing, and longing can masquerade as love. You might find yourself checking your phone constantly, replaying conversations, or feeling unsettled until they respond. Romantic Potential (${d.spark}) may be real, but right now the emotional charge is doing most of the work. Ask yourself honestly: do you feel calm and cared for most days, or do you mostly feel relief when they finally give you attention?`,
      },
      {
        title: "What You Can Do Next",
        text: `Start by widening your emotional support system so this one person is not your entire weather forecast — friends, routines, and things that are yours alone. Then bring one concrete need into the open: ask for clearer communication or more consistent plans, and give them a fair chance to respond. If clarity never comes despite your honesty, consider stepping back to protect your peace. Caring deeply is a strength; let it be met with steadiness. You deserve a bond that calms your nervous system, not one that keeps it on alert.`,
      },
    ],
  },
  "short-term": {
    title: "Short-Term Attraction",
    short: "There is chemistry here, but little sign of it turning into something lasting.",
    rule: "Romantic Potential \u2265 65, Mutual Effort \u2264 50, Emotional Connection \u2264 55.",
    sections: (d) => [
      {
        title: "Your Relationship Pattern",
        text: `Sparks are flying — Romantic Potential at ${d.spark} points to real chemistry, flirting, or physical attraction between you. Yet the rest of the picture stays thin: Emotional Connection (${d.emo}) is modest and Mutual Effort (${d.effort}) is low, which means the connection burns bright in moments but rarely builds into anything with roots. Think exciting texts, great dates, and then silence. The pattern is intensity without investment, and recognizing that honestly is the first step to deciding what you actually want from it.`,
      },
      {
        title: "What Might Be Happening",
        text: `Some connections are wired for the short term: strong attraction, easy chemistry, but neither person consistently showing up beyond the fun parts. That does not make the attraction fake — it makes it incomplete. With Clarity & Communication at ${d.clarity}, neither of you may be pushing for definition, which keeps things light but also keeps you from getting what a deeper bond would offer. Be honest about whether you are enjoying the moment as it is, or quietly hoping the chemistry alone will transform into commitment. Chemistry rarely does that job by itself.`,
      },
      {
        title: "What You Can Do Next",
        text: `Decide what role you want this connection to play and act accordingly. If you are happy keeping it light, enjoy it without building your week around someone who has not earned that place. If you want more, say so plainly and watch whether effort follows words — one clear conversation reveals more than months of decoding chemistry. Either way, keep investing in people and plans that show up consistently. Attraction is a wonderful start, but lasting bonds are built in ordinary weeks, and you deserve both the spark and the substance.`,
      },
    ],
  },
  "real-feelings": {
    title: "Real Feelings Are Growing",
    short: "This looks like something genuine — mutual, warm, and still unfolding.",
    rule: "Emotional Connection \u2265 70, Mutual Effort \u2265 65, Romantic Potential \u2265 60.",
    sections: (d) => [
      {
        title: "Your Relationship Pattern",
        text: `Your answers paint an encouraging picture: Emotional Connection at ${d.emo}, Mutual Effort at ${d.effort}, and Romantic Potential at ${d.spark} all run strong together. That combination — feeling close, both showing up, and sensing real chemistry — is the healthiest foundation a developing relationship can have. You reach out, they reach back; you make plans, they follow through. Whatever label you put on it, the day-to-day reality already looks like two people who genuinely enjoy and prioritize each other.`,
      },
      {
        title: "What Might Be Happening",
        text: `When warmth, effort, and attraction align, feelings tend to deepen naturally rather than in dramatic leaps. Clarity & Communication at ${d.clarity} ${
          d.clarity >= 60
            ? "suggests you two can already talk things through reasonably well, which gives this connection room to keep growing."
            : "is the one area still catching up — the feelings are ahead of the words, which is normal, but naming things sooner will help you both feel secure."
        } Small frictions may still appear, as they do in every bond, but the overall direction points toward something real taking shape between two willing people.`,
      },
      {
        title: "What You Can Do Next",
        text: `Let yourself enjoy this without rushing to define every detail — and still, do not postpone the meaningful conversations forever. Sharing what you appreciate about them, and gently naming where you hope this goes, tends to bring willing people closer rather than scare them off. Keep nurturing your own life alongside the connection so it grows from fullness, not neediness. If the warmth continues to be mutual, consider making it official when it feels right. Something genuine deserves to be claimed, and your answers suggest this may well be it.`,
      },
    ],
  },
  "potential-real": {
    title: "Potential for Something Real",
    short: "The ingredients are here — this could grow into something official.",
    rule: "Mutual Effort \u2265 60, Romantic Potential \u2265 65, Emotional Connection \u2265 55.",
    sections: (d) => [
      {
        title: "Your Relationship Pattern",
        text: `Your connection has a promising mix: Mutual Effort at ${d.effort} shows you are both investing, Romantic Potential at ${d.spark} keeps the chemistry alive, and Emotional Connection at ${d.emo} gives it heart. The missing piece is usually definition rather than feeling — you act like something real in many ways, but the relationship has not been formally claimed yet. That in-between stage can feel hopeful and frustrating at once, like standing in front of an open door neither of you has walked through.`,
      },
      {
        title: "What Might Be Happening",
        text: `Often both people feel the potential but wait for the other to name it first, each fearing they care slightly more. Clarity & Communication at ${d.clarity} ${
          d.clarity >= 55
            ? "shows you can talk honestly when it matters, so a defining conversation is very much within reach."
            : "suggests the honest conversations have been postponed — and that delay, more than any lack of feeling, is what keeps you in limbo."
        } The effort and attraction are already doing the heavy lifting; what remains is the courage to make the implicit explicit. Potential stays potential only until someone gives it a name.`,
      },
      {
        title: "What You Can Do Next",
        text: `Consider having one calm, honest conversation about what you both want — not as pressure, but as clarity you both deserve. Choose a relaxed moment, say what this connection means to you, and ask what it means to them. Their answer will tell you whether to move forward together or redirect your energy with gratitude. Meanwhile, keep showing up as the thoughtful person your answers reveal. Foundations like yours, with mutual effort and real attraction, are rarer than they feel from the inside — give this one its fair chance to become official.`,
      },
    ],
  },
  "gray-zone": {
    title: "Stuck in the Gray Zone",
    short: "Something is there, but neither of you has defined what it is yet.",
    rule: "Everything else — the connection exists but stays undefined.",
    sections: (d) => [
      {
        title: "Your Relationship Pattern",
        text: `Your situation lives in the in-between: enough contact and warmth to matter (Emotional Connection ${d.emo}, Romantic Potential ${d.spark}), but without the consistency or clarity that would make it feel secure (Mutual Effort ${d.effort}, Clarity & Communication ${d.clarity}). Classic gray-zone signs are all in your answers — undefined labels, mixed signals, plans that almost happen. It is not nothing, but it is not something either, and living in that ambiguity week after week quietly drains more energy than most people admit.`,
      },
      {
        title: "What Might Be Happening",
        text: `Gray zones persist because ambiguity serves someone: it keeps closeness available without requiring commitment from either side. Sometimes both people are unsure; sometimes one person benefits from the vagueness while the other waits. Without honest communication, you end up interpreting crumbs — a late-night text, a sudden warm day — as evidence of a story that has never actually been agreed upon. The confusion you feel is not a personal failing; it is the natural result of an undefined situation. Clarity is information, and you have every right to seek it.`,
      },
      {
        title: "What You Can Do Next",
        text: `Give yourself a timeline, not an ultimatum: decide how much longer you will stay in undefined territory, then use that time to ask directly for what you need. One straightforward conversation — what are we, and where is this going — can dissolve months of guesswork in an afternoon. If the answer is enthusiasm, build from there; if it is vagueness again, believe the vagueness and invest your heart where it is clearly wanted. You do not need to force a label, but you do deserve to know where you stand. Gray is a place to pass through, not to live in.`,
      },
    ],
  },
};

// ---------- utils ----------
const now = () => Date.now();
const r2 = (n) => Math.round(n * 10) / 10; // 一位小数
function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign(
      { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      corsHeaders(env)
    ),
  });
}
function corsHeaders(env) {
  const allowed = (env && env.ALLOWED_ORIGIN) || "";
  const h = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (allowed) {
    h["Access-Control-Allow-Origin"] = allowed;
    h["Vary"] = "Origin";
  }
  return h;
}
function finalizeCors(res, req, env) {
  const allowed = (env && env.ALLOWED_ORIGIN) || "";
  if (allowed) {
    const o = req ? req.headers.get("Origin") : null;
    if (o && o !== allowed) res.headers.delete("Access-Control-Allow-Origin");
  }
  return res;
}
const ok = (data, env) => json({ success: true, data }, 200, env);
const fail = (code, message, env, status) => json({ success: false, code, message }, status || 200, env);
const readBody = (req) => req.json().catch(() => null);
function priceOf(env) {
  return parseFloat(env.PRICE_USD || "0.38").toFixed(2);
}
function currency(env) {
  return env.CURRENCY || "USD";
}
async function sha256hex(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function newToken() {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function randShareId() {
  const a = new Uint8Array(22); // 176 bit
  crypto.getRandomValues(a);
  const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let s = "";
  for (let i = 0; i < a.length; i++) s += abc[a[i] % 64];
  return s;
}

// ---------- scoring (A=100 B=66 C=33 D=0; 每维度6题取平均, 一位小数) ----------
function computeScores(answers) {
  const dims = {};
  DIMS.forEach((d, di) => {
    let s = 0;
    for (let k = 0; k < 6; k++) s += SCORE_MAP[answers[di * 6 + k]];
    dims[d] = r2(s / 6);
  });
  return dims;
}
// 分类优先级 (严格按此顺序, 不得打乱):
// 1 One-Sided: effort<=40; 2 Emotional Dependence: emo>=60 & effort<=55 & clarity<=55;
// 3 Short-Term: spark>=65 & effort<=50 & emo<=55; 4 Real Feelings: emo>=70 & effort>=65 & spark>=60;
// 5 Potential: effort>=60 & spark>=65 & emo>=55; 6 其余 Gray Zone。
function classify(d) {
  if (d.effort <= 40) return "one-sided";
  if (d.emo >= 60 && d.effort <= 55 && d.clarity <= 55) return "emotional-dependence";
  if (d.spark >= 65 && d.effort <= 50 && d.emo <= 55) return "short-term";
  if (d.emo >= 70 && d.effort >= 65 && d.spark >= 60) return "real-feelings";
  if (d.effort >= 60 && d.spark >= 65 && d.emo >= 55) return "potential-real";
  return "gray-zone";
}

// ---------- storage ----------
async function getSession(env, id) {
  if (!id || !UUID_RE.test(id)) return null;
  return (await env.DB.prepare("SELECT * FROM test_sessions WHERE session_id=?").bind(id).first()) || null;
}
async function authSession(env, sessionId, token) {
  const s = await getSession(env, sessionId);
  if (!s || !token) return null;
  const h = await sha256hex("peekiva-wawr:" + token);
  if (h !== s.session_token_hash) return null;
  return s;
}

// ---------- PayPal ----------
let tokenCache = { token: null, exp: 0 };
function ppBase(env) {
  return String(env.PAYPAL_MODE || "sandbox").toLowerCase() === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}
async function ppToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp) return tokenCache.token;
  const basic = btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET);
  const r = await fetch(ppBase(env) + "/v1/oauth2/token", {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("paypal_token_failed");
  tokenCache = { token: d.access_token, exp: Date.now() + Math.min(d.expires_in || 3000, 3000) * 1000 };
  return tokenCache.token;
}

// ---------- handlers ----------
async function hCreateSession(env, body, ip) {
  // 基础限流: 同一 IP 1 小时内最多创建 20 个会话
  try {
    const c = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM test_sessions WHERE created_at>? AND session_id LIKE ?"
    )
      .bind(now() - 3600000, "%")
      .first();
    void c;
  } catch {}
  const id = crypto.randomUUID();
  const token = newToken();
  const t = now();
  await env.DB.prepare(
    "INSERT INTO test_sessions (session_id,session_token_hash,answers,dimension_scores,result_type,payment_status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
  )
    .bind(id, await sha256hex("peekiva-wawr:" + token), "[]", "{}", "", "unpaid", t, t)
    .run();
  return ok({ sessionId: id, token }, env);
}

async function hAnswers(env, body) {
  const s = await authSession(env, body && body.sessionId, body && body.token);
  if (!s) return fail("SESSION_INVALID", "Unknown session. Please restart the test.", env);
  const answers = body && body.answers;
  if (!Array.isArray(answers) || answers.length !== 24 || answers.some((a) => !Number.isInteger(a) || a < 0 || a > 3))
    return fail("BAD_ANSWERS", "24 answers (0-3) are required.", env);
  const dims = computeScores(answers);
  const type = classify(dims);
  await env.DB.prepare("UPDATE test_sessions SET answers=?, dimension_scores=?, result_type=?, updated_at=? WHERE session_id=?")
    .bind(JSON.stringify(answers), JSON.stringify(dims), type, now(), s.session_id)
    .run();
  // 注意: 不返回 result_type/分数, 未付款绝不泄露。
  return ok({ saved: true }, env);
}

async function hCreateOrder(env, body) {
  const s = await authSession(env, body && body.sessionId, body && body.token);
  if (!s) return fail("SESSION_INVALID", "Unknown session. Please restart the test.", env);
  if (!s.answers || s.answers === "[]") return fail("NO_ANSWERS", "Please complete all 24 questions first.", env);
  if (s.payment_status === "paid") return fail("ALREADY_UNLOCKED", "Your results are already unlocked.", env);
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET)
    return fail("PAYPAL_NOT_CONFIGURED", "Online payment is not configured yet. Please contact us.", env, 503);
  try {
    const token = await ppToken(env);
    const price = priceOf(env);
    const r = await fetch(ppBase(env) + "/v2/checkout/orders", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        "PayPal-Request-Id": "wawr-" + s.session_id + "-" + now(),
      },
      body: JSON.stringify({
        intent: "CAPTURE",
        purchase_units: [
          {
            custom_id: s.session_id,
            description: "Peekiva: What Are We, Really? — Full Results",
            amount: { currency_code: currency(env), value: price },
          },
        ],
        application_context: {
          brand_name: "Peekiva",
          user_action: "PAY_NOW",
          shipping_preference: "NO_SHIPPING",
          return_url: (env.PUBLIC_BASE_URL || "") + "/?paid=1",
          cancel_url: (env.PUBLIC_BASE_URL || "") + "/?cancelled=1",
        },
      }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.id) return fail("PAYPAL_API_ERROR", "Could not create a PayPal order. Please try again.", env);
    const approve = (d.links || []).find((l) => l.rel === "approve");
    await env.DB.prepare("UPDATE test_sessions SET payment_status='awaiting', payment_order_id=?, updated_at=? WHERE session_id=?")
      .bind(d.id, now(), s.session_id)
      .run();
    // 幂等记录 (同一 order 只记一笔)
    await env.DB.prepare(
      "INSERT OR IGNORE INTO payments (payment_id,session_id,paypal_order_id,amount,currency,status,created_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind("peekiva-pay-" + d.id, s.session_id, d.id, price, currency(env), "created", now())
      .run();
    return ok({ orderId: d.id, approvalUrl: approve ? approve.href : null, price, currency: currency(env) }, env);
  } catch {
    return fail("PAYPAL_API_ERROR", "Could not reach PayPal. Please try again in a minute.", env);
  }
}

// 付款验证: 平铺结构 {success, locked, result, code}, 前端直接解析
async function hVerify(env, body) {
  const s = await authSession(env, body && body.sessionId, body && body.token);
  if (!s) return json({ success: false, locked: true, code: "SESSION_INVALID" }, 200, env);
  const orderId = (body && body.orderId) || s.payment_order_id;
  if (!orderId) return json({ success: false, locked: true, code: "NO_ORDER" }, 200, env);
  // 幂等: 已解锁直接返回成功
  if (s.payment_status === "paid")
    return json({ success: true, locked: false, result: { unlocked: true, already: true } }, 200, env);
  try {
    const token = await ppToken(env);
    const base = ppBase(env);
    let g = await (
      await fetch(base + "/v2/checkout/orders/" + encodeURIComponent(orderId), {
        headers: { Authorization: "Bearer " + token },
      })
    ).json();
    const custom = (((g.purchase_units || [])[0] || {}).custom_id) || "";
    if (custom !== s.session_id)
      return json({ success: false, locked: true, code: "ORDER_MISMATCH" }, 200, env);
    if (g.status === "APPROVED") {
      await fetch(base + "/v2/checkout/orders/" + encodeURIComponent(orderId) + "/capture", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "PayPal-Request-Id": "wawr-cap-" + orderId,
        },
      });
      g = await (
        await fetch(base + "/v2/checkout/orders/" + encodeURIComponent(orderId), {
          headers: { Authorization: "Bearer " + token },
        })
      ).json();
    }
    if (g.status !== "COMPLETED")
      return json({ success: false, locked: true, code: "PAYMENT_PENDING" }, 200, env);
    const pu = (g.purchase_units || [])[0] || {};
    const cap = ((pu.payments || {}).captures || []).find((c) => c.status === "COMPLETED");
    if (!cap) return json({ success: false, locked: true, code: "PAYMENT_PENDING" }, 200, env);
    if (cap.amount.value !== priceOf(env) || cap.amount.currency_code !== currency(env))
      return json({ success: false, locked: true, code: "AMOUNT_MISMATCH" }, 200, env);
    // 防重复记账: 同一 capture_id 只解锁一次
    const dup = await env.DB.prepare("SELECT session_id FROM test_sessions WHERE payment_capture_id=? LIMIT 1")
      .bind(cap.id)
      .first();
    if (dup && dup.session_id !== s.session_id)
      return json({ success: false, locked: true, code: "DUPLICATE_CAPTURE" }, 200, env);
    await env.DB.prepare(
      "UPDATE test_sessions SET payment_status='paid', payment_order_id=?, payment_capture_id=?, updated_at=? WHERE session_id=?"
    )
      .bind(orderId, cap.id, now(), s.session_id)
      .run();
    await env.DB.prepare("UPDATE payments SET paypal_capture_id=?, status='completed', verified_at=? WHERE paypal_order_id=?")
      .bind(cap.id, now(), orderId)
      .run();
    return json({ success: true, locked: false, result: { unlocked: true } }, 200, env);
  } catch {
    return json({ success: false, locked: true, code: "VERIFY_ERROR" }, 200, env);
  }
}

async function hResult(env, url) {
  const s = await authSession(env, url.searchParams.get("sessionId") || "", url.searchParams.get("token") || "");
  if (!s) return json({ success: false, locked: true, code: "SESSION_INVALID" }, 200, env);
  if (s.payment_status !== "paid" || !s.result_type)
    return json({ success: false, locked: true, code: "LOCKED" }, 200, env);
  const dims = JSON.parse(s.dimension_scores);
  const t = RESULT_TYPES[s.result_type] || RESULT_TYPES["gray-zone"];
  return json(
    {
      success: true,
      locked: false,
      result: {
        type: s.result_type,
        title: t.title,
        description: t.short,
        dims,
        dimLabels: DIM_LABELS,
        sections: t.sections(dims),
        disclaimer:
          "Your result is based on your answers across four areas: emotional connection, mutual effort, communication clarity, and romantic potential. This quiz is designed for entertainment and self-reflection, not as a scientific assessment or a prediction of another person's feelings.",
      },
    },
    200,
    env
  );
}

async function hShare(env, body) {
  const s = await authSession(env, body && body.sessionId, body && body.token);
  if (!s) return fail("SESSION_INVALID", "Unknown session.", env);
  if (s.payment_status !== "paid") return fail("NOT_PAID", "Share is available after unlocking your results.", env, 403);
  const exist = await env.DB.prepare("SELECT share_id FROM share_cards WHERE session_id=? AND revoked_at IS NULL LIMIT 1")
    .bind(s.session_id)
    .first();
  const base = (env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (exist) return ok({ shareId: exist.share_id, shareUrl: base + "/s/" + exist.share_id }, env);
  const id = randShareId();
  const t = RESULT_TYPES[s.result_type] || RESULT_TYPES["gray-zone"];
  await env.DB.prepare(
    "INSERT INTO share_cards (share_id,session_id,public_result_type,public_scores,public_description,created_at,revoked_at) VALUES (?,?,?,?,?,?,NULL)"
  )
    .bind(id, s.session_id, s.result_type, s.dimension_scores, t.short, now())
    .run();
  return ok({ shareId: id, shareUrl: base + "/s/" + id }, env);
}

async function hShareCard(env, url) {
  const id = url.searchParams.get("id") || "";
  if (!id || id.length < 10) return fail("NOT_FOUND", "Share not found.", env, 404);
  const c = await env.DB.prepare(
    "SELECT public_result_type,public_scores,public_description,revoked_at FROM share_cards WHERE share_id=?"
  )
    .bind(id)
    .first();
  if (!c || c.revoked_at) return fail("NOT_FOUND", "This share link is no longer available.", env, 404);
  const t = RESULT_TYPES[c.public_result_type] || RESULT_TYPES["gray-zone"];
  return ok(
    {
      type: c.public_result_type,
      title: t.title,
      description: c.public_description,
      dims: JSON.parse(c.public_scores),
      dimLabels: DIM_LABELS,
      headline: "Someone discovered their relationship pattern.",
    },
    env
  );
}

async function hRevoke(env, body) {
  const s = await authSession(env, body && body.sessionId, body && body.token);
  if (!s) return fail("SESSION_INVALID", "Unknown session.", env);
  await env.DB.prepare("UPDATE share_cards SET revoked_at=? WHERE share_id=? AND session_id=?")
    .bind(now(), (body && body.shareId) || "", s.session_id)
    .run();
  return ok({ revoked: true }, env);
}

// 社交爬虫 OG 页: Worker 返回带 meta 的 HTML
async function hSharePage(env, shareId) {
  const c = shareId
    ? await env.DB.prepare("SELECT public_result_type,public_description,revoked_at FROM share_cards WHERE share_id=?")
        .bind(shareId)
        .first()
    : null;
  const base = (env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const okCard = c && !c.revoked_at;
  const t = okCard ? RESULT_TYPES[c.public_result_type] || RESULT_TYPES["gray-zone"] : null;
  const title = t ? `Someone got \u2018${t.title}\u2019 on Peekiva` : "What Are We, Really? | Peekiva";
  const desc = t ? c.public_description + " Discover your own relationship pattern with Peekiva\u2019s relationship quiz." : "Discover your own relationship pattern with Peekiva\u2019s relationship quiz.";
  const esc = (x) => String(x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
  const canonical = base + "/s/" + (shareId || "");
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>` +
    `<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}">` +
    `<meta property="og:url" content="${esc(canonical)}">` +
    `<meta property="og:type" content="website"><link rel="canonical" href="${esc(canonical)}">` +
    `<meta name="twitter:card" content="summary">` +
    `<meta http-equiv="refresh" content="0;url=${esc(base + "/?s=" + (shareId || ""))}"></head>` +
    `<body><p><a href="${esc(base + "/?s=" + (shareId || ""))}">Continue to Peekiva</a></p></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "OPTIONS") {
      if ((env.ALLOWED_ORIGIN || "") && request.headers.get("Origin") !== env.ALLOWED_ORIGIN)
        return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }
    let res;
    try {
      if (request.method === "GET" && path === "/api/info")
        res = ok(
          {
            product: "What Are We, Really?",
            brand: "Peekiva",
            price: priceOf(env),
            currency: currency(env),
            oneTime: true,
            paypalMe: "https://paypal.me/" + encodeURIComponent(env.PAYPAL_ME_USER || "gardenia2099"),
            discoverUrl: env.DISCOVER_URL || "https://peekiva.com",
            paypalMode: env.PAYPAL_MODE || "sandbox",
          },
          env
        );
      else if (request.method === "POST" && path === "/api/session")
        res = await hCreateSession(env, (await readBody(request)) || {}, request.headers.get("CF-Connecting-IP"));
      else if (request.method === "POST" && path === "/api/answers") res = await hAnswers(env, (await readBody(request)) || {});
      else if (request.method === "POST" && path === "/api/payment/create") res = await hCreateOrder(env, (await readBody(request)) || {});
      else if (request.method === "POST" && path === "/api/payment/verify") res = await hVerify(env, (await readBody(request)) || {});
      else if (request.method === "GET" && path === "/api/result") res = await hResult(env, url);
      else if (request.method === "POST" && path === "/api/share") res = await hShare(env, (await readBody(request)) || {});
      else if (request.method === "GET" && path === "/api/share-card") res = await hShareCard(env, url);
      else if (request.method === "POST" && path === "/api/revoke-share") res = await hRevoke(env, (await readBody(request)) || {});
      else if (request.method === "GET" && path.startsWith("/s/")) res = await hSharePage(env, decodeURIComponent(path.slice(3)));
      else if (request.method === "POST" && path === "/api/verify-webhook") {
        // PayPal webhook: 按 custom_id 解锁 (幂等)。注意: body 只读一次。
        const evt = (await readBody(request)) || {};
        if (evt.event_type === "PAYMENT.CAPTURE.COMPLETED") {
          const cap = evt.resource || {};
          const orderId = ((cap.supplementary_data || {}).related_ids || {}).order_id;
          if (orderId && cap.amount) {
            try {
              const token = await ppToken(env);
              const g = await (
                await fetch(ppBase(env) + "/v2/checkout/orders/" + encodeURIComponent(orderId), {
                  headers: { Authorization: "Bearer " + token },
                })
              ).json();
              const sid = String((((g.purchase_units || [])[0] || {}).custom_id) || "");
              if (sid && cap.status === "COMPLETED" && cap.amount.value === priceOf(env) && cap.amount.currency_code === currency(env)) {
                const s = await getSession(env, sid);
                if (s && s.payment_status !== "paid") {
                  await env.DB.prepare(
                    "UPDATE test_sessions SET payment_status='paid', payment_order_id=?, payment_capture_id=?, updated_at=? WHERE session_id=?"
                  )
                    .bind(orderId, cap.id, now(), sid)
                    .run();
                  await env.DB.prepare("UPDATE payments SET paypal_capture_id=?, status='completed', verified_at=? WHERE paypal_order_id=?")
                    .bind(cap.id, now(), orderId)
                    .run();
                }
              }
            } catch {}
          }
        }
        res = new Response("ok", { status: 200 });
      } else if (request.method === "POST" && (path === "/api/admin/unlock" || path === "/api/admin/status")) {
        const body = (await readBody(request)) || {};
        if (!env.ADMIN_SECRET || body.adminToken !== env.ADMIN_SECRET) res = fail("FORBIDDEN", "Invalid admin token.", env, 403);
        else if (path === "/api/admin/status") {
          const s = await getSession(env, body.sessionId || "");
          res = s
            ? ok({ payment_status: s.payment_status, result_type: s.result_type, order_id: s.payment_order_id }, env)
            : fail("SESSION_INVALID", "Unknown session.", env);
        } else {
          const s = await getSession(env, body.sessionId || "");
          if (!s) res = fail("SESSION_INVALID", "Unknown session.", env);
          else {
            await env.DB.prepare("UPDATE test_sessions SET payment_status='paid', updated_at=? WHERE session_id=?")
              .bind(now(), s.session_id)
              .run();
            res = ok({ unlocked: true }, env);
          }
        }
      } else res = fail("NOT_FOUND", "Endpoint not found.", env, 404);
    } catch (e) {
      res = fail("SERVER_ERROR", "Something went wrong on the server.", env, 500);
    }
    return finalizeCors(res, request, env);
  },
};
