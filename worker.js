/**
 * Your Soul Animal Personality — Cloudflare Worker backend
 * -------------------------------------------------------
 * Serves the quiz API for the GitHub Pages frontend.
 *
 * Sensitive configuration lives ONLY in environment variables:
 *   PAYPAL_CLIENT_ID     - PayPal REST App client id (Orders API)
 *   PAYPAL_CLIENT_SECRET - PayPal REST App secret  (Orders API)
 *   PAYPAL_WEBHOOK_ID    - PayPal webhook id (for webhook verification)
 *   ADMIN_SECRET         - your private key to manually verify PayPal.Me payments
 *   DEVELOPMENT_MODE     - "true" enables simulated payments (TEST ONLY)
 *
 * IMPORTANT PAYPAL REALITY CHECK
 * ------------------------------
 * PayPal.Me is ONLY a payment redirect page. It gives no order id, no
 * API token, and no webhook. There is NO safe way for this server to
 * automatically confirm a PayPal.Me payment from the browser.
 *
 * Automatic, safe payment verification requires the PayPal Orders API
 * (PayPal Checkout). When PAYPAL_CLIENT_ID + PAYPAL_CLIENT_SECRET are
 * set, this worker switches to "checkout" mode automatically and verifies
 * orders server-side via the PayPal REST API.
 *
 * Until then, PayPal.Me is used as the MVP payment entry point together
 * with a MANUAL admin unlock flow (see POST /api/admin/manual-unlock).
 * The server NEVER trusts a client-side "I've Paid" flag.
 *
 * Storage uses Cloudflare D1 by default, with an automatic Cloudflare KV
 * fallback when no D1 binding is present.
 */

const ANIMALS = ["fox", "owl", "dolphin", "lion", "sloth", "wolf"];
const QUESTION_COUNT = 16;
const DEFAULT_PRICE = "0.38";
const DEFAULT_CURRENCY = "USD";
const SESSION_TTL_MINUTES = 24 * 60;
const MAX_VERIFY_ATTEMPTS = 40;

/* ------------------------------------------------------------------ */
/* Question bank. Scoring weights ONLY live here (never in index.html).*/
/* Each option gives +2 to its primary animal and +1 to a secondary.   */
/* ------------------------------------------------------------------ */
const QUESTIONS = [
  {
    id: "q1", topic: "social", text: "A party just got loud and everyone is dancing. You usually...",
    options: [
      { text: "Join right in the middle and grab your best friend to go with you.", scores: { dolphin: 2, lion: 1 } },
      { text: "Hang near the edge and study the room until something clicks.", scores: { owl: 2, fox: 1 } },
      { text: "Start a game, a playlist, or a group photo. Someone has to spark it.", scores: { lion: 2, dolphin: 1 } },
      { text: "Claim a cozy corner and people-watch until you feel like joining.", scores: { sloth: 2, wolf: 1 } }
    ]
  },
  {
    id: "q2", topic: "decision", text: "Two options look equally good. You go with...",
    options: [
      { text: "The one you've secretly been craving all day.", scores: { fox: 2, dolphin: 1 } },
      { text: "The one that's the smartest value for your time and money.", scores: { owl: 2, fox: 1 } },
      { text: "Let someone else pick. Less pressure, same payoff.", scores: { sloth: 2, dolphin: 1 } },
      { text: "The boldest one. Life is too short to play it safe.", scores: { wolf: 2, lion: 1 } }
    ]
  },
  {
    id: "q3", topic: "stress", text: "Your phone dies right before a big plan. You...",
    options: [
      { text: "Breathe, find a coffee shop, and wing it beautifully from there.", scores: { sloth: 2, fox: 1 } },
      { text: "Replay the whole plan in your head, then write a backup version.", scores: { owl: 2, wolf: 1 } },
      { text: "Text a friend to come find you. Everything is better in a pair.", scores: { dolphin: 2, lion: 1 } },
      { text: "Take charge: new route, new plan, new adventure. Let's go.", scores: { lion: 2, fox: 1 } }
    ]
  },
  {
    id: "q4", topic: "work", text: "A group project is due Friday. You're...",
    options: [
      { text: "The one quietly finishing your part by Tuesday, no drama.", scores: { owl: 2, wolf: 1 } },
      { text: "The one herding everyone into one group chat at 9pm.", scores: { dolphin: 2, lion: 1 } },
      { text: "The one sketching the entire game plan on a napkin.", scores: { fox: 2, lion: 1 } },
      { text: "The one doing it Sunday afternoon while the group panics.", scores: { sloth: 2, dolphin: 1 } }
    ]
  },
  {
    id: "q5", topic: "relationships", text: "You like someone. Your first move is...",
    options: [
      { text: "Drop a clever joke and watch to see if they laugh.", scores: { fox: 2, dolphin: 1 } },
      { text: "Send a chill text, then agonize for exactly one hour before replying.", scores: { owl: 2, sloth: 1 } },
      { text: "Be completely direct: 'Hey, I like you. Coffee?'", scores: { lion: 2, wolf: 1 } },
      { text: "Leave a tiny clue and see if they pick up on it.", scores: { wolf: 2, fox: 1 } }
    ]
  },
  {
    id: "q6", topic: "adventure", text: "\"Let's do something wild tonight!\" You think...",
    options: [
      { text: "Sure — once I've scoped it out and packed accordingly.", scores: { owl: 2, fox: 1 } },
      { text: "Done. Where and when?", scores: { lion: 2, wolf: 1 } },
      { text: "I'm in if my people are going.", scores: { dolphin: 2, sloth: 1 } },
      { text: "Depends how deep my couch-situation is tonight.", scores: { sloth: 2, lion: 1 } }
    ]
  },
  {
    id: "q7", topic: "alone", text: "A free Saturday afternoon. You...",
    options: [
      { text: "Recharge with a movie, snacks, and zero obligations.", scores: { sloth: 2, owl: 1 } },
      { text: "Make one small plan with one really close person.", scores: { wolf: 2, dolphin: 1 } },
      { text: "Learn a new trick, recipe, or skill just because.", scores: { fox: 2, owl: 1 } },
      { text: "Text three friends until someone's free. FOMO is real.", scores: { dolphin: 2, lion: 1 } }
    ]
  },
  {
    id: "q8", topic: "conflict", text: "A friend snaps at you out of nowhere. You...",
    options: [
      { text: "Go quiet and think it through before saying anything.", scores: { owl: 2, wolf: 1 } },
      { text: "Joke it off, then slyly steer the conversation somewhere sweet.", scores: { fox: 2, dolphin: 1 } },
      { text: "Say it calmly: 'That wasn't okay.'", scores: { wolf: 2, lion: 1 } },
      { text: "Give them space and go decompress with a pillow.", scores: { sloth: 2, dolphin: 1 } }
    ]
  },
  {
    id: "q9", topic: "plans", text: "You plan a trip. You...",
    options: [
      { text: "Book flights, map routes, and build a checklist. Naturally.", scores: { owl: 2, wolf: 1 } },
      { text: "Keep one loose idea and go with the vibe when you land.", scores: { dolphin: 2, sloth: 1 } },
      { text: "Have a Plan A, a Plan B, and an emergency Plan C ready.", scores: { fox: 2, lion: 1 } },
      { text: "Tell everyone where to be, then relax and enjoy the ride.", scores: { lion: 2, owl: 1 } }
    ]
  },
  {
    id: "q10", topic: "intuition", text: "You meet someone and instantly get a weird feeling. You...",
    options: [
      { text: "Trust the feeling and keep a little distance for now.", scores: { wolf: 2, owl: 1 } },
      { text: "Test it by asking clever questions and reading the tiny details.", scores: { fox: 2, owl: 1 } },
      { text: "Give them a chance. People are usually fine if you're warm.", scores: { dolphin: 2, sloth: 1 } },
      { text: "Ignore it and dive in headfirst. Regrets are for later.", scores: { lion: 2, dolphin: 1 } }
    ]
  },
  {
    id: "q11", topic: "leadership", text: "Your group can't agree on a movie. You...",
    options: [
      { text: "Announce a winner. Someone had to make the call.", scores: { lion: 2, fox: 1 } },
      { text: "Suggest three solid options and let the group choose.", scores: { owl: 2, fox: 1 } },
      { text: "Eh, I'm easy. Whatever keeps the group happy.", scores: { sloth: 2, dolphin: 1 } },
      { text: "Side with the person you trust most, quietly and firmly.", scores: { wolf: 2, lion: 1 } }
    ]
  },
  {
    id: "q12", topic: "trust", text: "A friend swears they'll keep your secret. You...",
    options: [
      { text: "Believe them fully and instantly feel lighter.", scores: { dolphin: 2, sloth: 1 } },
      { text: "Share just a small slice first and see how they handle it.", scores: { fox: 2, owl: 1 } },
      { text: "Keep most of it to yourself. That's just how it is.", scores: { wolf: 2, owl: 1 } },
      { text: "Lay it out plainly and make clear how much it matters.", scores: { wolf: 2, lion: 1 } }
    ]
  },
  {
    id: "q13", topic: "curiosity", text: "You spot a weird, unmarked door. You...",
    options: [
      { text: "Open it immediately. The mystery IS the point.", scores: { lion: 2, fox: 1 } },
      { text: "Peer through the crack first, then decide.", scores: { owl: 2, wolf: 1 } },
      { text: "Ask everyone what's behind it before peeking.", scores: { dolphin: 2, sloth: 1 } },
      { text: "Note it, maybe check it later, if the vibes are right.", scores: { sloth: 2, owl: 1 } }
    ]
  },
  {
    id: "q14", topic: "emotions", text: "A sad song hits you out of nowhere. You...",
    options: [
      { text: "Let the feeling pass through and keep your day moving.", scores: { sloth: 2, dolphin: 1 } },
      { text: "Immediately text someone to vent about it.", scores: { dolphin: 2, wolf: 1 } },
      { text: "Analyze why it hit so hard, at 2am, in great detail.", scores: { owl: 2, fox: 1 } },
      { text: "Keep it in, then go do something decisive to shake it off.", scores: { lion: 2, wolf: 1 } }
    ]
  },
  {
    id: "q15", topic: "friendships", text: "Your best friend describes you in one word. It's...",
    options: [
      { text: "Chaotic-good. My energy runs the whole room.", scores: { dolphin: 2, lion: 1 } },
      { text: "The brain. I always have the details.", scores: { owl: 2, fox: 1 } },
      { text: "The calm one. I never stress about anything.", scores: { sloth: 2, dolphin: 1 } },
      { text: "My person. Loyalty is my entire brand.", scores: { wolf: 2, lion: 1 } }
    ]
  },
  {
    id: "q16", topic: "habits", text: "Describe your morning routine. Honestly.",
    options: [
      { text: "Snooze. Snooze. Okay, three snoozes. Then coffee.", scores: { sloth: 2, dolphin: 1 } },
      { text: "Up before the alarm, coffee in hand, thinking already.", scores: { owl: 2, fox: 1 } },
      { text: "Workout, smoothie, then an hour of crushing goals.", scores: { lion: 2, wolf: 1 } },
      { text: "Roll out and make the whole day up as I go.", scores: { fox: 2, sloth: 1 } }
    ]
  }
];

/* ------------------------------------------------------------------ */
/* Full result content. Lives ONLY on the server.                      */
/* ------------------------------------------------------------------ */
const CONTENT = {
  fox: {
    name: "Fox", emoji: "🦊", title: "The Clever Strategist",
    intro: "You see the angles before anyone else even realizes there's a game. Quick, witty, and three moves ahead, you charm your way through problems that would wreck other people. Rules? You know them — you just also know exactly when it's fun to bend them. You're not reckless, though. Clever is your whole brand.",
    traits: ["Quick on your feet", "Great at reading people", "Playful but guarded", "Always has a Plan B", "Slightly chaotic energy"],
    strengths: ["Problem-solving", "Charisma", "Adaptability", "Reading the room"],
    funnyWeakness: "You've overthought a group-chat reply for three business days, then sent \"ha\" like nothing happened.",
    socialStyle: "You're the fun one who's also quietly surveying the room. You make people laugh, but you're tracking exits, tone, and who's talking to whom. Groups love you because you keep the vibe light and drop a perfectly timed joke the second things get awkward. You're social — but you choose your inner circle very carefully.",
    workStyle: "You're the strategist. Give you a messy problem and you'll find the shortcut, the angle, or the loophole before lunch. You thrive on autonomy and a little creative freedom. Boring, repetitive tasks? Delegate, automate, or cleverly avoid them within an inch of your life.",
    relationshipStyle: "You fall for people who keep you on your toes — playful banter, a little mystery, someone who can match your wit. Trust takes time with you; you let people earn it in small doses. Once you're in, you're surprisingly devoted. You just need someone interesting enough to hold your attention.",
    compatible: { animal: "dolphin", blurb: "Fox + Dolphin is the dream duo: quick wit meets warm heart. They keep things light and human while you keep things clever and sharp. Together? A pair with brains, banter, and genuinely great vibes." },
    challenging: { animal: "owl", blurb: "The Owl moves at their own careful pace, and you like to move fast. Their long silences can read as mysterious (they're actually just thinking). Patience is your challenge badge with this one." }
  },
  owl: {
    name: "Owl", emoji: "🦉", title: "The Late-Night Thinker",
    intro: "While the world sleeps, your best ideas meddle with the wifi. You're the thinker, the planner, the one who actually reads the instructions. You don't rush to answer — you wait until you're sure. People call you wise (and a little mysterious). You notice details everyone else walks right past, and your sudden 2am realizations hit different.",
    traits: ["Deep thinker", "Calm under pressure", "Notices everything", "Private at first", "Owns the night shift"],
    strengths: ["Research", "Focus", "Strategic patience", "Steady under chaos"],
    funnyWeakness: "You've Googled deeply embarrassing things at 3am, then cleared your history like a criminal.",
    socialStyle: "You're the calm presence in any group. You'd take three real friends over forty acquaintances. Big crowds drain you fast, but one-on-one? You're warm and unexpectedly funny once you're comfortable. People feel safe talking to you because you actually listen instead of waiting to talk.",
    workStyle: "You're the analysis machine. Slow is fast, and fast is sloppy — that's your motto. You plan, you research, you double-check, and your work rarely needs fixing. You shine on deep, focused tasks. Small talk in meetings? Painful. Solving the problem everyone gave up on? Pure joy.",
    relationshipStyle: "You're not an instant-connection person; you warm up slowly. But when you let someone in, you let them ALL the way in. You remember the small stuff — birthdays, that offhand thing they said weeks ago. Give you deep conversations at 1am and you'll never leave. Your heart is selective, and that's exactly what makes it special.",
    compatible: { animal: "fox", blurb: "Owl + Fox balance each other perfectly. You bring the depth; they bring the spark. Fox keeps things interesting when you overthink, and you keep them grounded when they spiral. A genuinely elite duo." },
    challenging: { animal: "dolphin", blurb: "The Dolphin wants to do everything with everyone right now, while you'd rather think first and commit later. Their high-speed energy is a lot — but honestly, a little of it is good for you." }
  },
  dolphin: {
    name: "Dolphin", emoji: "🐬", title: "The Social Spark",
    intro: "You're the human group chat. Wherever you go, the energy goes up. You genuinely love people — new friends are just friends you haven't met yet. You're quick to laugh, quick to help, and quicker to make a room feel alive. Life with you feels like a beach day with perfect music: nobody wants to leave.",
    traits: ["Warm and magnetic", "Emotionally smart", "Team player forever", "Lives for connection", "Fearless party planner"],
    strengths: ["Connection", "Empathy", "Teamwork", "Pure energy"],
    funnyWeakness: "You've typed \"omg\" so many times you have a dedicated keyboard shortcut for it.",
    socialStyle: "You're the glue of the group. You text first, you gather your people, you remember everyone's dog's name. Friends crash on your couch and raid your fridge, and you honestly love it. You vibe with almost anyone and you bring out the best in awkward moments. People leave your company lighter than they arrived.",
    workStyle: "You're a natural collaborator — you make group work actually fun. Teammates feel safe bouncing ideas off you, and you're a great communicator who learns fast when something excites you. Repetitive solo tasks bore you. Give you people, purpose, and coffee and you'll outwork everyone.",
    relationshipStyle: "You fall hard and you fall fast, and you love rom-com levels of romance: inside jokes, shared playlists, running to greet them at the door. You feel things deeply and you say so. Your only challenge? Slowing down long enough to hear your own heartbeat over the music of everyone else's.",
    compatible: { animal: "lion", blurb: "Dolphin + Lion is main-character meets party-planner. They bring direction and courage; you bring warmth and fun. Together you're the friendship group everyone wishes they were in." },
    challenging: { animal: "owl", blurb: "The Owl drains their social battery around the time you're just warming up. Their need for quiet reads as cold, but reach a midnight deep-talk and you'll realize they were worth the wait." }
  },
  lion: {
    name: "Lion", emoji: "🦁", title: "The Main Character",
    intro: "Let's be honest — you walk into a room like the opening scene of a movie. Confident, warm, and impossible to ignore, you're the person everyone looks to when things get messy. You don't chase attention; it kind of just follows. Underneath the main-character energy, you're fiercely protective of your people — you'd take the hit before letting a friend take it.",
    traits: ["Born leader", "Courageous", "Protective", "Makes things happen", "Impossible to ignore"],
    strengths: ["Leadership", "Courage", "Loyalty", "Decisiveness"],
    funnyWeakness: "You've taken charge of a table of strangers at a restaurant because the waiter was clearly lost. He was fine. You made him fine.",
    socialStyle: "You run the group chat and you're not sorry about it. You're the one who says \"okay, we're doing this\" and everyone secretly loves that you did. You're generous with your time and protective of your people. Friends describe you as big energy, bigger heart.",
    workStyle: "You're the driver. Projects move the second you're around because you're not afraid to make the call. You take ownership, you raise the bar, and you rally the team when deadlines loom. You hate being micro-managed — you'd rather lead than be led. Give you a goal and stand back.",
    relationshipStyle: "You're a ride-or-die romantic. You show up big: grand gestures, clear words, zero guessing games. You want someone who can match your energy and isn't scared of it. You're loyal to a fault, and if someone disrespects your person? They'll find out quickly.",
    compatible: { animal: "dolphin", blurb: "Lion + Dolphin is a power couple energy. They keep things joyful while you keep things moving. Their soft heart balances your big one, and together you can rally anyone." },
    challenging: { animal: "sloth", blurb: "The Sloth does everything at their own perfect pace, and you've built an empire from speed. Waiting on them is genuinely good practice — even if it costs you years of your life." }
  },
  sloth: {
    name: "Sloth", emoji: "🦥", title: "The Professional Relaxer",
    intro: "You move at your own pace, and honestly? It's kind of genius. You don't sweat the small stuff, you're impossible to rush, and your calm is so contagious that panicking people start breathing again around you. You're not lazy — you're efficient with your energy. You save your spoons for what actually matters, like snacks and peace.",
    traits: ["Unbothered", "Chill under pressure", "Loyal and warm", "Secretly wise", "Snack enthusiast"],
    strengths: ["Resilience", "Genuine calm", "Efficiency", "Warmth"],
    funnyWeakness: "You once spent 45 minutes choosing which takeout place to order from, then got the same thing you always order.",
    socialStyle: "You're the friend who says \"I'll be there in 10\" and means 25 — and everyone accepts it, because you're worth the wait. You're low-drama and high-humor. You don't chase the crowd, but the people closest to you get your full warm, weird, comforting presence.",
    workStyle: "You're a master of the sustainable pace. While everyone burns out by Tuesday, you're steady all week. You find the easiest smart way to do a thing, you never overbook yourself, and your calm genuinely makes teams better. You only need one thing: your own schedule.",
    relationshipStyle: "You take it slow, but when you commit, you're all in. You're warm, low-key, and you fall for people who make you feel safe. Cozy dates — takeout, a movie, a couch — are your love language. Chaos love? Hard pass. Your romance is \"comfortable enough to be weird together.\"",
    compatible: { animal: "wolf", blurb: "Sloth + Wolf is the chillest power pairing. They bring quiet intensity while you bring pure serenity. No drama, deep trust, and a shared need for personal space — surprisingly perfect." },
    challenging: { animal: "lion", blurb: "The Lion lives at 100mph and peaks at 9am. Your deal is absolutely not that. But their pushy energy is the gentle nudge your inner sloth sometimes needs." }
  },
  wolf: {
    name: "Wolf", emoji: "🐺", title: "The Ride-or-Die",
    intro: "You're fiercely loyal, deeply independent, and a little bit of a mystery. You're happy on your own — you don't need a crowd to feel full. But the people you let in? They get your whole pack energy. You protect, you show up, and you'd hike through a storm for your people. Trust is earned with you, slowly, and once given, it's basically unbreakable.",
    traits: ["Fiercely loyal", "Independent", "Intense", "Protective", "Thrives in the wild"],
    strengths: ["Loyalty", "Reliability", "Independence", "Sharp instinct"],
    funnyWeakness: "You've overthought a text reply for so long that the whole conversation ended. Honestly? You're relieved.",
    socialStyle: "You're a one-person-core-team person. Small groups, deep talks, real people — that's your zone. You'll disappear for a few days and emerge like it's nothing; your friends get it. The few true friends you have know they can call you at 3am and you'll pick up.",
    workStyle: "You're the dependable one who somehow delivers without anyone holding your hand. Give you a task and you own it end to end. You work best with autonomy and clear expectations. You hate flaky colleagues and pointless meetings. Stability, freedom, and trust — that's how you outwork everyone.",
    relationshipStyle: "You don't date casually; you date meaningfully. You're intense, honest, and deeply devoted. You need someone who respects your alone time and doesn't need constant reassurance. When you love, you love like a mission: steady, fierce, and built for the long haul.",
    compatible: { animal: "sloth", blurb: "Wolf + Sloth is quietly iconic. They give you space and calm, you give them protection and devotion. No games, deep trust, and mutual respect for the personal bubble — chef's kiss." },
    challenging: { animal: "dolphin", blurb: "The Dolphin wants to be everyone's best friend by lunch, and you're out here building one friendship a year. Their constant social battery drains yours — but their warmth is a lesson in letting people in faster." }
  }
};

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function corsHeaders(env) {
  const allowed = (env && env.ALLOWED_ORIGIN) || "*";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store"
  };
  if (allowed === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
    return headers;
  }
  headers["Access-Control-Allow-Origin"] = allowed;
  headers["Vary"] = "Origin";
  return headers;
}

function finalizeCors(response, request, env) {
  const allowed = (env && env.ALLOWED_ORIGIN) || "*";
  if (allowed === "*") { return response; }
  const origin = request ? request.headers.get("Origin") : null;
  if (origin && origin !== allowed) {
    response.headers.delete("Access-Control-Allow-Origin");
  }
  return response;
}

function corsPreflightAllowed(request, env) {
  const allowed = (env && env.ALLOWED_ORIGIN) || "*";
  if (allowed === "*") { return true; }
  const origin = request ? request.headers.get("Origin") : null;
  return !!origin && origin === allowed;
}

function json(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, corsHeaders(env))
  });
}

function ok(data, env) { return json({ success: true, data: data }, 200, env); }
function fail(code, message, status, env) { return json({ success: false, code: code, message: message }, status || 200, env); }

function now() { return Date.now(); }
function hashCode(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffle(arr, seed) {
  const a = arr.slice();
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function readBody(request) {
  return request.json().catch(() => null);
}

/* ------------------------------------------------------------------ */
/* Storage (D1 primary, KV fallback)                                   */
/* ------------------------------------------------------------------ */
function unpackSession(row) {
  const s = Object.assign({}, row);
  try { s.answers = JSON.parse(s.answers || "[]"); } catch (e) { s.answers = []; }
  try { s.scores = JSON.parse(s.scores || "{}"); } catch (e) { s.scores = null; }
  try { s.big_pts = JSON.parse(s.big_pts || "{}"); } catch (e) { s.big_pts = null; }
  try { s.question_order = JSON.parse(s.question_order || "[]"); } catch (e) { s.question_order = []; }
  s.verify_count = typeof s.verify_count === "number" ? s.verify_count : parseInt(s.verify_count || "0", 10);
  return s;
}

async function getSession(env, id) {
  if (!id || !UUID_RE.test(id)) { return null; }
  if (env.DB) {
    const row = await env.DB.prepare("SELECT * FROM sessions WHERE id = ?").bind(id).first();
    return row ? unpackSession(row) : null;
  }
  if (env.SESSIONS) {
    const v = await env.SESSIONS.get("s:" + id, "json");
    return v || null;
  }
  throw new Error("No storage binding configured.");
}

async function saveSession(env, s) {
  const answers = JSON.stringify(s.answers || []);
  const scores = JSON.stringify(s.scores || {});
  const order = JSON.stringify(s.question_order || []);
  const bigPts = JSON.stringify(s.big_pts || {});
  if (env.DB) {
    await env.DB.prepare(
      `INSERT INTO sessions
        (id, created_at, expires_at, answers, scores, big_pts, result_type, payment_status,
         payment_id, payment_method, order_id, unlocked_at, verify_count, last_verify_at, question_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         answers = excluded.answers, scores = excluded.scores, big_pts = excluded.big_pts,
         result_type = excluded.result_type,
         payment_status = excluded.payment_status, payment_id = excluded.payment_id,
         payment_method = excluded.payment_method, order_id = excluded.order_id,
         unlocked_at = excluded.unlocked_at, verify_count = excluded.verify_count,
         last_verify_at = excluded.last_verify_at, question_order = excluded.question_order, expires_at = excluded.expires_at`
    ).bind(
      s.id, s.created_at, s.expires_at, answers, scores, bigPts, s.result_type || null,
      s.payment_status || "none", s.payment_id || null, s.payment_method || null,
      s.order_id || null, s.unlocked_at || null, s.verify_count || 0,
      s.last_verify_at || null, order
    ).run();
    return;
  }
  if (env.SESSIONS) {
    const ttlSecs = Math.max(60, Math.ceil((s.expires_at - now()) / 1000));
    await env.SESSIONS.put("s:" + s.id, JSON.stringify(s), { expirationTtl: ttlSecs });
    return;
  }
  throw new Error("No storage binding configured.");
}

async function atomicUnlock(env, id, fields) {
  if (env.DB) {
    const patch = Object.assign({}, fields);
    const res = await env.DB.prepare(
      "UPDATE sessions SET payment_status = 'paid', payment_id = ?, payment_method = ?, order_id = ?, unlocked_at = ? WHERE id = ? AND payment_status <> 'paid'"
    ).bind(patch.payment_id || null, patch.payment_method || null, patch.order_id || null, patch.unlocked_at || now(), id).run();
    const changed = res.success && (res.meta && res.meta.changes !== undefined)
      ? res.meta.changes > 0
      : res.success;
    return changed;
  }
  const s = await getSession(env, id);
  if (!s || s.payment_status === "paid") { return false; }
  s.payment_status = "paid";
  s.payment_id = fields.payment_id || s.payment_id || null;
  s.payment_method = fields.payment_method || s.payment_method || null;
  s.order_id = fields.order_id || s.order_id || null;
  s.unlocked_at = fields.unlocked_at || now();
  await saveSession(env, s);
  return true;
}

/* ------------------------------------------------------------------ */
/* Scoring                                                             */
/* ------------------------------------------------------------------ */
function computeMaxPossible() {
  const max = {};
  ANIMALS.forEach((a) => (max[a] = 0));
  QUESTIONS.forEach((q) => {
    ANIMALS.forEach((a) => {
      let best = 0;
      q.options.forEach((o) => { if (o.scores[a]) { best = Math.max(best, o.scores[a]); } });
      max[a] += best;
    });
  });
  return max;
}
const MAX_POSSIBLE = computeMaxPossible();

function validateAnswers(answers) {
  if (!Array.isArray(answers)) { return null; }
  if (answers.length !== QUESTION_COUNT) { return null; }
  for (let i = 0; i < answers.length; i++) {
    const v = answers[i];
    if (!Number.isInteger(v) || v < 0 || v > 3) { return null; }
  }
  return answers;
}

function computeScores(answers, order) {
  const scores = {};
  const bigPts = {};
  ANIMALS.forEach((a) => { scores[a] = 0; bigPts[a] = 0; });
  answers.forEach((optIdx, qi) => {
    const q = QUESTIONS[order[qi]];
    if (!q) { return; }
    const opt = q.options[optIdx];
    if (!opt) { return; }
    Object.keys(opt.scores).forEach((a) => {
      const pts = opt.scores[a];
      scores[a] += pts;
      if (pts >= 2) { bigPts[a] += 1; }
    });
  });
  return { scores, bigPts };
}

function pickResult(scores, bigPts) {
  const orderRaw = ["fox", "owl", "dolphin", "lion", "sloth", "wolf"].slice();
  return ANIMALS.slice()
    .sort((a, b) => (scores[b] - scores[a]) || (bigPts[b] - bigPts[a]) || (orderRaw.indexOf(a) - orderRaw.indexOf(b)))[0];
}

function buildAffinity(scores) {
  return ANIMALS.map((a) => {
    const max = MAX_POSSIBLE[a] || 1;
    const percent = Math.max(0, Math.min(100, Math.round((scores[a] / max) * 100)));
    const meta = CONTENT[a];
    return { animal: a, name: meta.name, emoji: meta.emoji, percent: percent, score: scores[a] };
  }).sort((x, y) => (y.score - x.score) || (y.percent - x.percent) || (x.animal.localeCompare(y.animal)));
}

function buildResultPayload(session, scores) {
  const animal = session.result_type || pickResult(scores, session.big_pts || {});
  const c = CONTENT[animal];
  if (!c) { throw new Error("unknown animal"); }
  const affinity = buildAffinity(scores || session.scores);
  const comp = c.compatible;
  const chall = c.challenging;
  return {
    animal: animal,
    name: c.name,
    emoji: c.emoji,
    title: c.title,
    intro: c.intro,
    traits: c.traits,
    strengths: c.strengths,
    funnyWeakness: c.funnyWeakness,
    socialStyle: c.socialStyle,
    workStyle: c.workStyle,
    relationshipStyle: c.relationshipStyle,
    affinity: affinity,
    match: {
      compatible: { animal: comp.animal, name: CONTENT[comp.animal].name, emoji: CONTENT[comp.animal].emoji, title: CONTENT[comp.animal].title, blurb: comp.blurb },
      challenging: { animal: chall.animal, name: CONTENT[chall.animal].name, emoji: CONTENT[chall.animal].emoji, title: CONTENT[chall.animal].title, blurb: chall.blurb }
    },
    shareText: "I just found out I'm a " + c.name + " personality! " + c.emoji + " What's yours?",
    shareLine: "Try the quiz and find your soul animal."
  };
}

/* ------------------------------------------------------------------ */
/* PayPal (Orders API / webhook)                                       */
/* ------------------------------------------------------------------ */
function paypalBase(env) {
  const mode = (env.PAYPAL_MODE || "live").toLowerCase() === "sandbox" ? "sandbox" : "live";
  return mode === "sandbox" ? "https://api-m.sandbox.paypal.com" : "https://api-m.paypal.com";
}
function paypalAreConfigured(env) {
  return !!(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET);
}
function resolveMode(env) {
  if (String(env.DEVELOPMENT_MODE || "").toLowerCase() === "true") { return "dev"; }
  if (paypalAreConfigured(env)) { return "checkout"; }
  return "paypalme";
}

async function paypalToken(env) {
  const url = paypalBase(env) + "/v1/oauth2/token";
  const basic = btoa(env.PAYPAL_CLIENT_ID + ":" + env.PAYPAL_CLIENT_SECRET);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials"
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error("paypal_token_failed:" + (data.error_description || data.error || res.status));
  }
  return data.access_token;
}

async function paypalCreateOrder(env, sessionId) {
  const token = await paypalToken(env);
  const price = priceValue(env);
  const res = await fetch(paypalBase(env) + "/v2/checkout/orders", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      "PayPal-Request-Id": "sap-" + sessionId + "-" + now()
    },
    body: JSON.stringify({
      intent: "CAPTURE",
      purchase_units: [{
        reference_id: "sap_session_" + sessionId,
        description: "Your Soul Animal Personality — full report",
        custom_id: sessionId,
        amount: { currency_code: DEFAULT_CURRENCY, value: price }
      }],
      application_context: {
        brand_name: "Your Soul Animal Personality",
        user_action: "PAY_NOW",
        shipping_preference: "NO_SHIPPING"
      }
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.id) {
    throw new Error("paypal_create_order_failed:" + (data.message || data.name || res.status));
  }
  const approve = (data.links || []).find((l) => l.rel === "approve");
  return { orderId: data.id, approvalUrl: approve ? approve.href : null, status: data.status };
}

async function paypalGetOrder(env, orderId) {
  const token = await paypalToken(env);
  const res = await fetch(paypalBase(env) + "/v2/checkout/orders/" + encodeURIComponent(orderId), {
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

function orderPaidAndMatching(order, sessionId, price) {
  if (!order || order.status !== "COMPLETED") { return { paid: false }; }
  const pu = (order.purchase_units || [])[0];
  if (!pu) { return { paid: false }; }
  if (pu.custom_id && pu.custom_id !== sessionId) { return { paid: false, mismatch: "custom_id" }; }
  const amount = pu.amount || {};
  if (amount.value !== price || amount.currency_code !== DEFAULT_CURRENCY) {
    return { paid: false, mismatch: "amount" };
  }
  const caps = (pu.payments && pu.payments.captures) || [];
  const completedCapture = caps.find((cap) => cap.status === "COMPLETED" && cap.amount && cap.amount.value === price);
  return { paid: !!completedCapture, captureId: completedCapture ? completedCapture.id : null, capture: completedCapture || null };
}

async function paypalVerifyWebhook(env, rawBody, transmissionId, transmissionTime, certUrl, transmissionSig, authAlgo) {
  const token = await paypalToken(env);
  const res = await fetch(paypalBase(env) + "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: env.PAYPAL_WEBHOOK_ID,
      webhook_event: rawBody
    })
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}

/* ------------------------------------------------------------------ */
/* Config helpers                                                      */
/* ------------------------------------------------------------------ */
function priceValue(env) {
  const p = env.PAYMENT_PRICE_USD || DEFAULT_PRICE;
  const n = parseFloat(p);
  return (isNaN(n) || n <= 0) ? DEFAULT_PRICE : n.toFixed(2);
}
function sessionTtl(env) {
  const t = parseInt(env.SESSION_TTL_MINUTES || SESSION_TTL_MINUTES, 10);
  return (isNaN(t) || t <= 0) ? SESSION_TTL_MINUTES : t;
}
function paypalMeUser(env) {
  return env.PAYPAL_ME_USER || "Katerina2099";
}
function adminUnlockEnabled(env) {
  return !!(env.ADMIN_SECRET && env.ADMIN_SECRET.length >= 16);
}
function devModeOn(env) {
  return String(env.DEVELOPMENT_MODE || "").toLowerCase() === "true";
}

/* ------------------------------------------------------------------ */
/* Rate limiting (basic, KV only when available)                       */
/* ------------------------------------------------------------------ */
async function rateLimit(env, key, max, windowSec) {
  if (!env.SESSIONS) { return false; }
  const nowSec = Math.floor(now() / 1000);
  const entry = await env.SESSIONS.get(key).catch(() => null);
  let count = 1;
  if (entry) {
    const parsed = JSON.parse(entry);
    if (parsed.window === nowSec) { count = parsed.count + 1; }
    else { count = 1; }
  }
  await env.SESSIONS.put(key, JSON.stringify({ count: count, window: nowSec }), { expirationTtl: windowSec + 30 });
  return count > max;
}

/* ------------------------------------------------------------------ */
/* Session / answer / payment handlers                                 */
/* ------------------------------------------------------------------ */
async function handleCreateSession(env) {
  const id = crypto.randomUUID();
  const ttlMin = sessionTtl(env);
  const created = now();
  const expires = created + ttlMin * 60 * 1000;
  const order = seededShuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15], hashCode(id));
  const session = {
    id: id, created_at: created, expires_at: expires,
    answers: [], scores: null, result_type: null,
    payment_status: "none", payment_id: null, payment_method: null,
    order_id: null, unlocked_at: null, verify_count: 0, last_verify_at: null,
    question_order: order
  };
  await saveSession(env, session);
  return ok({ sessionId: id, expiresAt: expires, ttlMinutes: ttlMin }, env);
}

async function handleGetQuestions(env, url) {
  const sessionId = url.searchParams.get("sessionId") || "";
  const session = await getSession(env, sessionId);
  if (!session) { return fail("SESSION_INVALID", "Unknown session.", 200, env); }
  if (now() > session.expires_at) { return fail("SESSION_EXPIRED", "Session expired.", 200, env); }
  const safe = QUESTIONS.map((q) => ({
    id: q.id,
    text: q.text,
    options: q.options.map((o) => o.text)
  }));
  // Return in the same shuffled order as this session will be scored.
  const ordered = session.question_order && session.question_order.length === 16
    ? session.question_order.map((qi) => safe[qi])
    : safe;
  return ok({ questions: ordered }, env);
}

async function handleSubmitAnswers(env, body) {
  const sessionId = body.sessionId || "";
  const answers = validateAnswers(body.answers);
  if (!answers) { return fail("BAD_ANSWERS", "16 answers between 0 and 3 are required.", 200, env); }
  const session = await getSession(env, sessionId);
  if (!session) { return fail("SESSION_INVALID", "Unknown session.", 200, env); }
  if (now() > session.expires_at) { return fail("SESSION_EXPIRED", "Session expired.", 200, env); }
  const order = session.question_order && session.question_order.length === 16 ? session.question_order : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const { scores, bigPts } = computeScores(answers, order);
  const result_type = pickResult(scores, bigPts);
  session.answers = answers;
  session.scores = scores;
  session.big_pts = bigPts;
  session.result_type = result_type;
  await saveSession(env, session);
  // No animal name is leaked here. Only "ready + locked".
  return ok({ completed: true, locked: true }, env);
}

async function handlePaymentCreate(env, body) {
  const sessionId = body.sessionId || "";
  const session = await getSession(env, sessionId);
  if (!session) { return fail("SESSION_INVALID", "Unknown session.", 200, env); }
  if (now() > session.expires_at) { return fail("SESSION_EXPIRED", "Session expired.", 200, env); }
  if (!session.scores || !session.result_type || !Array.isArray(session.answers) || session.answers.length !== 16) {
    return fail("NOT_COMPUTED", "Finish the quiz before paying.", 200, env);
  }
  if (session.payment_status === "paid") {
    return fail("ALREADY_UNLOCKED", "This session is already unlocked.", 200, env);
  }

  const price = priceValue(env);
  const mode = resolveMode(env);

  if (mode === "dev") {
    session.payment_status = "dev_pending";
    session.payment_method = "dev_sim";
    session.order_id = null;
    await saveSession(env, session);
    return ok({ mode: "dev", price: price, currency: DEFAULT_CURRENCY }, env);
  }

  if (mode === "checkout") {
    try {
      const order = await paypalCreateOrder(env, sessionId);
      session.payment_status = "awaiting_payment";
      session.payment_method = "paypal_orders_api";
      session.order_id = order.orderId;
      await saveSession(env, session);
      return ok({
        mode: "checkout", orderId: order.orderId,
        approvalUrl: order.approvalUrl, price: price, currency: DEFAULT_CURRENCY
      }, env);
    } catch (e) {
      return fail("PAYPAL_API_ERROR", "Could not create a PayPal order. Check PAYPAL_CLIENT_ID/SECRET and try again.", 200, env);
    }
  }

  // mode === 'paypalme'
  session.payment_status = "awaiting_manual_verification";
  session.payment_method = "paypalme";
  await saveSession(env, session);
  return ok({
    mode: "paypalme",
    payUrl: "https://www.paypal.com/paypalme/" + encodeURIComponent(paypalMeUser(env)) + "/" + price,
    price: price,
    currency: DEFAULT_CURRENCY,
    note: "PayPal.Me does not expose verifiable order data. Payment is confirmed manually on the server after funds arrive."
  }, env);
}

async function handlePaymentVerify(env, body) {
  const sessionId = body.sessionId || "";
  const mode = resolveMode(env);
  const session = await getSession(env, sessionId);
  if (!session) { return fail("SESSION_INVALID", "Unknown session.", 200, env); }
  if (now() > session.expires_at) { return fail("SESSION_EXPIRED", "Session expired.", 200, env); }

  if (session.payment_status === "paid") {
    const result = buildResultPayload(session, session.scores || {});
    return ok({ locked: false, result: result, code: "ALREADY_UNLOCKED" }, env);
  }

  // Enforce a cap on verification attempts per session (duplicate/abuse guard).
  const vcount = (session.verify_count || 0) + 1;
  if (vcount > MAX_VERIFY_ATTEMPTS) {
    session.verify_count = vcount; session.last_verify_at = now();
    await saveSession(env, session);
    return fail("RATE_LIMITED", "Too many verification attempts.", 200, env);
  }
  session.verify_count = vcount; session.last_verify_at = now();
  await saveSession(env, session);

  /* ---- DEVELOPMENT_MODE simulations (TEST ONLY) ---- */
  if (mode === "dev") {
    const dev = String(body.devStatus || "").toLowerCase();
    if (dev === "success") {
      const didUnlock = await atomicUnlock(env, sessionId, { payment_method: "dev_sim", payment_id: "dev-sim-" + now() });
      const fresh = didUnlock ? await getSession(env, sessionId) : session;
      const result = buildResultPayload(fresh, fresh.scores || {});
      return ok({ locked: false, result: result, code: "PAYMENT_SUCCESS" }, env);
    }
    if (dev === "cancelled") { return fail("PAYMENT_CANCELLED", "Payment was cancelled.", 200, env); }
    if (dev === "pending") { return fail("PAYMENT_PENDING", "Payment is still processing.", 200, env); }
    if (dev === "failed") { return fail("PAYMENT_FAILED", "Payment failed.", 200, env); }
    return fail("BAD_PARAMS", "devStatus must be success, cancelled, pending, or failed.", 200, env);
  }

  /* ---- PayPal Orders API verification ---- */
  if (mode === "checkout") {
    const orderId = body.orderId || session.order_id;
    if (!orderId) { return fail("NO_ORDER", "No PayPal order id.", 200, env); }
    const price = priceValue(env);
    try {
      const orderRes = await paypalGetOrder(env, orderId);
      if (!orderRes.ok) { return fail("PAYMENT_PENDING", "Order not found yet.", 200, env); }
      const check = orderPaidAndMatching(orderRes.data, sessionId, price);
      if (!check.paid) { return fail("PAYMENT_PENDING", "Order has not been completed yet.", 200, env); }
      const didUnlock = await atomicUnlock(env, sessionId, {
        payment_id: check.captureId, payment_method: "paypal_orders_api", order_id: orderId
      });
      const fresh = await getSession(env, sessionId);
      const result = buildResultPayload(fresh, fresh.scores || {});
      return ok({ locked: false, result: result, code: didUnlock ? "PAYMENT_SUCCESS" : "ALREADY_UNLOCKED" }, env);
    } catch (e) {
      return fail("PAYMENT_VERIFY_ERROR", "Verification failed. Please try again in a minute.", 200, env);
    }
  }

  /* ---- PayPal.Me: manual verification only ---- */
  if (session.payment_status === "paid") {
    const fresh = await getSession(env, sessionId);
    const result = buildResultPayload(fresh, fresh.scores || {});
    return ok({ locked: false, result: result, code: "ALREADY_UNLOCKED" }, env);
  }
  return fail("MANUAL_VERIFICATION_REQUIRED", "PayPal.Me payments are confirmed manually on the server after funds arrive.", 200, env);
}

async function handleGetResult(env, url) {
  const sessionId = url.searchParams.get("sessionId") || "";
  const session = await getSession(env, sessionId);
  if (!session) { return json({ success: false, locked: true, code: "SESSION_INVALID" }, 200, env); }
  if (now() > session.expires_at) { return json({ success: false, locked: true, code: "SESSION_EXPIRED" }, 200, env); }
  if (session.payment_status !== "paid") {
    return json({ success: false, locked: true, code: "LOCKED" }, 200, env);
  }
  const result = buildResultPayload(session, session.scores || {});
  return json({ success: true, locked: false, result: result }, 200, env);
}

/* ------------------------------------------------------------------ */
/* PayPal webhook handler                                              */
/* ------------------------------------------------------------------ */
async function handleWebhook(env, request) {
  if (!paypalAreConfigured(env) || !env.PAYPAL_WEBHOOK_ID) { return new Response("webhook not configured", { status: 200 }); }
  const rawText = await request.text();
  const parse = () => { try { return JSON.parse(rawText); } catch (e) { return null; } };
  const event = parse();
  if (!event) { return new Response("bad payload", { status: 200 }); }

  const transmissionId = request.headers.get("paypal-transmission-id");
  const transmissionTime = request.headers.get("paypal-transmission-time");
  const transmissionSig = request.headers.get("paypal-transmission-sig");
  const certUrl = request.headers.get("paypal-cert-url");
  const authAlgo = request.headers.get("paypal-auth-algo");
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    return new Response("missing headers", { status: 200 });
  }

  let verified = false;
  try {
    const vr = await paypalVerifyWebhook(env, rawText, transmissionId, transmissionTime, certUrl, transmissionSig, authAlgo);
    verified = vr.ok && vr.data && vr.data.verification_status === "SUCCESS";
  } catch (e) {
    return new Response("verification error", { status: 200 });
  }
  if (!verified) { return new Response("verification failed", { status: 200 }); }

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const related = (event.resource && event.resource.supplementary_data && event.resource.supplementary_data.related_ids) || {};
    const orderId = related.order_id;
    const captureId = event.resource.id;
    const amount = (event.resource.amount || {}).value;
    if (amount !== priceValue(env)) { return new Response("amount mismatch", { status: 200 }); }

    if (orderId && env.DB) {
      const row = await env.DB.prepare("SELECT id FROM sessions WHERE order_id = ? AND payment_status <> 'paid' LIMIT 1").bind(orderId).first();
      if (row) {
        await atomicUnlock(env, row.id, { payment_id: captureId, payment_method: "paypal_orders_api", order_id: orderId });
      }
    } else if (orderId && env.SESSIONS) {
      const list = await env.SESSIONS.list({ prefix: "s:" });
      for (const key of list.keys) {
        const s = await env.SESSIONS.get(key.name, "json");
        if (s && s.order_id === orderId && s.payment_status !== "paid") {
          await atomicUnlock(env, s.id, { payment_id: captureId, payment_method: "paypal_orders_api", order_id: orderId });
          break;
        }
      }
    }
  }

  return new Response("ok", { status: 200 });
}

/* ------------------------------------------------------------------ */
/* Admin endpoints (manual PayPal.Me verification)                     */
/* ------------------------------------------------------------------ */
async function handleAdminManualUnlock(env, body) {
  if (!adminUnlockEnabled(env)) { return fail("ADMIN_DISABLED", "ADMIN_SECRET is not configured.", 403, env); }
  if (String(body.adminToken || "") !== env.ADMIN_SECRET) { return fail("FORBIDDEN", "Invalid admin token.", 403, env); }
  const sessionId = body.sessionId || "";
  const session = await getSession(env, sessionId);
  if (!session) { return fail("SESSION_INVALID", "Unknown session.", 200, env); }
  if (!session.scores || !session.result_type) { return fail("NOT_COMPUTED", "Quiz not completed.", 200, env); }
  if (session.payment_status === "paid") { return ok({ alreadyUnlocked: true, sessionId: sessionId }, env); }
  const didUnlock = await atomicUnlock(env, sessionId, {
    payment_id: body.paypalTxnId || ("manual-" + now()), payment_method: "paypalme_manual", order_id: null
  });
  return ok({ unlocked: didUnlock, sessionId: sessionId }, env);
}

async function handleAdminStatus(env, body) {
  if (!adminUnlockEnabled(env)) { return fail("ADMIN_DISABLED", "ADMIN_SECRET is not configured.", 403, env); }
  if (String(body.adminToken || "") !== env.ADMIN_SECRET) { return fail("FORBIDDEN", "Invalid admin token.", 403, env); }
  const session = await getSession(env, body.sessionId || "");
  if (!session) { return fail("SESSION_INVALID", "Unknown session.", 200, env); }
  return ok({
    id: session.id,
    created_at: session.created_at,
    expires_at: session.expires_at,
    expires_in_minutes: Math.max(0, Math.round((session.expires_at - now()) / 60000)),
    payment_status: session.payment_status,
    payment_method: session.payment_method,
    has_answers: Array.isArray(session.answers) && session.answers.length === 16,
    has_result: !!session.result_type,
    unlock_state: session.payment_status === "paid" ? "unlocked" : "locked",
    verify_count: session.verify_count || 0,
    last_verify_at: session.last_verify_at || null
  }, env);
}

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (request.method === "OPTIONS") {
      if (!corsPreflightAllowed(request, env)) { return new Response(null, { status: 403 }); }
      return new Response(null, { status: 204, headers: corsHeaders(env) });
    }

    let response;
    try {
      // Public info endpoint (no session required)
      if (request.method === "GET" && path === "/api/info") {
        response = json({
          success: true,
          product: "Your Soul Animal Personality",
          price: priceValue(env),
          currency: DEFAULT_CURRENCY,
          mode: resolveMode(env),
          devMode: devModeOn(env),
          questionCount: QUESTION_COUNT,
          paypalMe: resolveMode(env) === "paypalme" ? ("https://www.paypal.com/paypalme/" + encodeURIComponent(paypalMeUser(env)) + "/" + priceValue(env)) : null,
          autoVerify: paypalAreConfigured(env)
        }, 200, env);
      } else if (request.method === "GET" && path === "/api/questions") {
        response = await handleGetQuestions(env, url);
      } else if (request.method === "GET" && path === "/api/result") {
        response = await handleGetResult(env, url);
      } else if (request.method === "POST") {
        const body = (await readBody(request)) || {};

        if (path === "/api/session") {
          if (env.SESSIONS && request.headers.get("CF-Connecting-IP")) {
            const limited = await rateLimit(env, "rate:session:" + request.headers.get("CF-Connecting-IP"), 20, 600);
            if (limited) { response = fail("RATE_LIMITED", "Too many sessions. Try again later.", 429, env); }
            else { response = await handleCreateSession(env); }
          } else {
            response = await handleCreateSession(env);
          }
        } else if (path === "/api/answers") {
          response = await handleSubmitAnswers(env, body);
        } else if (path === "/api/payment/create") {
          response = await handlePaymentCreate(env, body);
        } else if (path === "/api/payment/verify") {
          response = await handlePaymentVerify(env, body);
        } else if (path === "/api/verify-webhook") {
          response = await handleWebhook(env, request);
        } else if (path === "/api/admin/manual-unlock") {
          response = await handleAdminManualUnlock(env, body);
        } else if (path === "/api/admin/status") {
          response = await handleAdminStatus(env, body);
        } else {
          response = fail("NOT_FOUND", "Endpoint not found.", 404, env);
        }
      } else {
        response = fail("NOT_FOUND", "Endpoint not found.", 404, env);
      }
    } catch (e) {
      console.error("worker error", e && e.message);
      response = fail("SERVER_ERROR", "Something went wrong on the server.", 500, env);
    }

    return finalizeCors(response, request, env);
  }
};