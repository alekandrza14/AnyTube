// AnyTube Букс: рекламодатели платят за просмотры своих видео, зрители смотрят и зарабатывают.
// Деньги — в копейках (целые числа). Данные — db.json в приватном репозитории GitHub (или локальный файл).
import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import path from "node:path";

const env = (k, d = "") => (process.env[k] ?? d).toString().trim();
const CFG = {
  site: env("SITE_URL").replace(/\/$/, ""),
  clientId: env("GITHUB_CLIENT_ID"),
  clientSecret: env("GITHUB_CLIENT_SECRET"),
  sessionSecret: env("SESSION_SECRET") || crypto.randomBytes(32).toString("hex"),
  admin: env("ADMIN_LOGIN", "alekandrza14").toLowerCase(),
  payoutEmail: env("PAYOUT_EMAIL", "alekandrza14@gmail.com"),
  wallet: env("YOOMONEY_WALLET").replace(/\D/g, ""),
  ymSecret: env("YOOMONEY_SECRET"),
  dbRepo: env("DB_REPO"),            // например alekandrza14/anytube-db (ПРИВАТНЫЙ)
  dbToken: env("DB_TOKEN"),          // токен с доступом на запись к DB_REPO
  commission: Math.min(0.9, Math.max(0, Number(env("BUX_COMMISSION", "0.25")))),
  minWithdraw: Math.round(Number(env("BUX_MIN_WITHDRAW", "10")) * 100),
  minTopup: Math.round(Number(env("BUX_MIN_TOPUP", "10")) * 100),
  minAccountDays: Number(env("BUX_MIN_ACCOUNT_DAYS", "7")),
  premod: env("PREMODERATION", "on").toLowerCase() !== "off",  // новые видео ждут одобрения администратора
  dislikePrice: Math.round(Number(env("BUX_DISLIKE_PRICE", "5")) * 100), // цена одного дизлайка для заказчика, коп.
  likePrice: Math.round(Number(env("BUX_LIKE_PRICE", "2")) * 100),       // цена одного лайка для заказчика, коп.
  ghToken: env("GITHUB_TOKEN").replace(/^Bearer\s+/i, ""),
  paidToken: env("PAID_TOKEN"),      // classic-токен аккаунта сайта с правом repo: читает приватные anytubepaid_*
  saleCommission: Math.min(0.9, Math.max(0, Number(env("SALE_COMMISSION", "0.37")))),
  sbpPhone: env("SBP_PHONE"), sbpBank: env("SBP_BANK"), sbpName: env("SBP_NAME"),
};
if (!env("SESSION_SECRET")) console.warn("[bux] SESSION_SECRET не задан — после перезапуска всем придётся войти заново");

// Тарифы: секунды просмотра → цена одного просмотра для рекламодателя (коп.)
export const TARIFFS = { 15: 10, 30: 18, 45: 25, 60: 30, 90: 40, 120: 50 };
const reward = (price) => Math.floor(price * (1 - CFG.commission));
export const DISLIKE_LEVELS = { 1: "😕 Ну не очень", 2: "😒 Так себе", 3: "👎 Плохо", 4: "😖 Очень плохо, зря потратил время", 5: "🤮 Это убогий видос, мой день испорчен" };
// имя репозитория-дизлайка — точно как его создаёт AnyTube Uploader
export function dislikeRepoName(author, file, level) {
  const head = `anytubecomment_${author}_`, tail = "_Commet.";
  const part = String(file).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100 - head.length - tail.length - "5.diske".length);
  return `${head}${part}${tail}${level}.diske`;
}
const DAY = 24 * 3600 * 1000;
const rub = (k) => (k / 100).toFixed(2);

// ─────────────── хранилище ───────────────
const EMPTY = () => ({ v: 1, seq: 1, users: {}, campaigns: {}, views: {}, ipViews: {}, withdrawals: {}, topups: {}, ops: [],
  purchases: {}, timepass: {}, sbp: {}, dislikeDone: {}, hidden: {}, likes: {}, likeIp: {}, likeDone: {},
  reports: {}, hiddenComments: {}, bannedAuthors: {}, approved: {}, rejected: {}, trusted: {}, premodInit: false });
let db = EMPTY();
let dbSha = null, dirty = false, saving = null, loaded = false;
const LOCAL = path.join(process.cwd(), "data", "db.json");
const useGitHub = () => CFG.dbRepo && CFG.dbToken;
const ghDb = (url, opts = {}) => fetch(`https://api.github.com/repos/${CFG.dbRepo}/contents/db.json${url}`, {
  ...opts,
  headers: { Accept: "application/vnd.github+json", "User-Agent": "anytube-bux", Authorization: `Bearer ${CFG.dbToken}`, ...(opts.headers || {}) },
});

async function loadDb() {
  try {
    if (useGitHub()) {
      const meta = await ghDb("");
      if (meta.status === 404) { db = EMPTY(); dirty = true; console.log("[bux] db.json ещё нет — создаю новую базу"); }
      else if (!meta.ok) throw new Error(`GitHub ${meta.status}: ${await meta.text()}`);
      else {
        dbSha = (await meta.json()).sha;
        const raw = await ghDb("", { headers: { Accept: "application/vnd.github.raw" } });
        db = { ...EMPTY(), ...JSON.parse(await raw.text()) };
      }
    } else if (fs.existsSync(LOCAL)) {
      db = { ...EMPTY(), ...JSON.parse(fs.readFileSync(LOCAL, "utf8")) };
      console.warn("[bux] База в локальном файле — на Render она сотрётся при перезапуске! Задайте DB_REPO и DB_TOKEN.");
    } else console.warn("[bux] DB_REPO/DB_TOKEN не заданы — база временная (локальный файл).");
    loaded = true;
  } catch (e) {
    console.error("[bux] НЕ удалось загрузить базу — букс выключен, чтобы не затереть данные:", e.message);
  }
}

async function saveNow() {
  if (!dirty || !loaded) return;
  dirty = false;
  const body = JSON.stringify(db);
  try {
    if (useGitHub()) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const r = await ghDb("", { method: "PUT", body: JSON.stringify({
          message: "bux: обновление базы", content: Buffer.from(body).toString("base64"), ...(dbSha ? { sha: dbSha } : {}) }) });
        if (r.ok) { dbSha = (await r.json()).content.sha; return; }
        if (r.status === 409 || r.status === 422) { const m = await ghDb(""); if (m.ok) dbSha = (await m.json()).sha; continue; }
        throw new Error(`GitHub ${r.status}: ${await r.text()}`);
      }
      throw new Error("конфликт версий db.json");
    } else {
      fs.mkdirSync(path.dirname(LOCAL), { recursive: true });
      fs.writeFileSync(LOCAL + ".tmp", body);
      fs.renameSync(LOCAL + ".tmp", LOCAL);
    }
  } catch (e) { dirty = true; console.error("[bux] ошибка сохранения базы:", e.message); }
}
// сохраняем не чаще раза в 5 с; деньги — сразу
function save(urgent = false) {
  dirty = true;
  if (urgent) return (saving = (saving || Promise.resolve()).then(saveNow));
  if (!save.t) save.t = setTimeout(() => { save.t = null; saving = (saving || Promise.resolve()).then(saveNow); }, 5000);
}
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { await saveNow(); process.exit(0); });

const id = (p) => `${p}${(db.seq++).toString(36)}${crypto.randomBytes(3).toString("hex")}`;
function op(uid, type, amount, note) {
  db.ops.push({ t: Date.now(), uid, type, amount, note });
  if (db.ops.length > 3000) db.ops.splice(0, db.ops.length - 3000);
}
function prune() {
  const now = Date.now();
  for (const [k, t] of Object.entries(db.views)) if (now - t > DAY) delete db.views[k];
  for (const [k, t] of Object.entries(db.ipViews)) if (now - t > DAY) delete db.ipViews[k];
}

// ─────────────── сессии и вход через GitHub ───────────────
const sign = (s) => crypto.createHmac("sha256", CFG.sessionSecret).update(s).digest("base64url");
function getCookie(req, name) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(res, name, val, maxAgeSec) {
  const secure = (CFG.site || "").startsWith("https") ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}
function sessionUser(req) {
  const c = getCookie(req, "at_s");
  if (!c) return null;
  const [data, sig] = c.split(".");
  if (!data || !sig || sign(data) !== sig) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString());
    if (s.exp < Date.now()) return null;
    const u = db.users[s.uid];
    return u && !u.banned ? u : null;
  } catch { return null; }
}
const siteUrl = (req) => CFG.site || `${req.headers["x-forwarded-proto"] || "http"}://${req.headers.host}`;
const redirect = (res, to) => { res.statusCode = 302; res.setHeader("Location", to); res.end(); };
const ipOf = (req) => (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();

async function readBody(req, limit = 200_000) {
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length) return req.body;
  let s = "";
  for await (const ch of req) { s += ch; if (s.length > limit) throw new Error("too big"); }
  const ct = req.headers["content-type"] || "";
  if (ct.includes("application/json")) return s ? JSON.parse(s) : {};
  return Object.fromEntries(new URLSearchParams(s));
}

// ─────────────── проверка уведомлений ЮMoney (подпись sign, HMAC-SHA256) ───────────────
const rfc3986 = (v) => encodeURIComponent(v).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
// скрытые администратором видео (дубли, перезаливы, нарушения)
export function isHidden(v) { return !!(db.hidden && db.hidden[v.id]) || isBanned(v.owner) || isPending(v) || isRejected(v); }
// ── премодерация ──
const isTrusted = (login) => { const l = String(login || "").toLowerCase(); return l === CFG.admin || !!(db.trusted && db.trusted[l]); };
export function isPending(v) {
  if (!CFG.premod) return false;
  if (!loaded) return true;  // база ещё не загрузилась — ничего непроверенного не показываем
  return !db.approved[v.id] && !db.rejected[v.id] && !isTrusted(v.owner);
}
export function isRejected(v) { return !!(db.rejected && db.rejected[v.id]); }
export function moderationState(v) {
  return { pending: isPending(v), rejected: db.rejected?.[v.id] || null, hiddenByMod: !!db.hidden?.[v.id], banned: isBanned(v.owner) };
}
// после каждого обновления списка: при первом включении одобряем всё уже опубликованное; админ и доверенные — сразу
export function syncApprovals(videos) {
  if (!loaded || !CFG.premod) return;
  let changed = false;
  for (const v of videos) {
    if (db.approved[v.id] || db.rejected[v.id]) continue;
    if (!db.premodInit || isTrusted(v.owner)) { db.approved[v.id] = { t: Date.now(), by: db.premodInit ? "доверенный автор" : "было до премодерации" }; changed = true; }
  }
  if (!db.premodInit) { db.premodInit = true; changed = true; console.log("[mod] премодерация включена: уже опубликованные видео одобрены автоматически"); }
  if (changed) save();
}
// видит ли этот посетитель скрытое/непроверенное видео (админ — всё, автор — своё)
export function canSeeHidden(req, v) {
  if (!loaded) return false;
  const u = sessionUser(req);
  return !!u && (u.login.toLowerCase() === CFG.admin || u.login.toLowerCase() === v.owner.toLowerCase());
}
// модерация: заблокированные авторы и скрытые комментарии
export function isBanned(login) { return !!(login && db.bannedAuthors && db.bannedAuthors[String(login).toLowerCase()]); }
export function isCommentHidden(id) { return !!(db.hiddenComments && db.hiddenComments[id]); }
export const CONTACTS = {
  email: (process.env.CONTACT_EMAIL || process.env.PAYOUT_EMAIL || "alekandrza14@gmail.com").trim(),
  phone: (process.env.CONTACT_PHONE || process.env.SBP_PHONE || "").trim(),
};
// лайки AnyTube (вместо звёзд GitHub): хранятся в базе сайта
export function likesOf(id) { return (db.likes && db.likes[id] && db.likes[id].n) || 0; }
function addLike(vid, key, ipk) {
  const L = (db.likes[vid] ||= { n: 0, by: {} });
  if (L.by[key]) return false;
  L.by[key] = Date.now(); L.n++;
  if (ipk) db.likeIp[`${ipk}:${vid}`] = key;
  return true;
}

export function yoomoneySign(params, secret) {
  const str = Object.keys(params).filter((k) => k !== "sign").sort()
    .map((k) => `${k}=${rfc3986(params[k] ?? "")}`).join("&");
  return crypto.createHmac("sha256", secret).update(str, "utf8").digest("hex");
}

// ─────────────── маршруты ───────────────
export function mountBux(app, getVideos) {
  loadDb();
  setInterval(() => { prune(); }, 3600 * 1000).unref?.();
  const sessions = new Map(); // активные просмотры: token → {uid, cid, start, need, digit, ip}
  const guard = (res) => { if (!loaded) { res.status(503).json({ error: "Букс временно недоступен (база не загружена)" }); return false; } return true; };
  const auth = (req, res) => {
    if (!guard(res)) return null;
    const u = sessionUser(req);
    if (!u) res.status(401).json({ error: "Войдите через GitHub" });
    return u;
  };
  const pub = (u) => u && ({ uid: u.uid, login: u.login, avatar: u.avatar, ad: u.ad, earn: u.earn, held: u.held || 0,
    views: u.views || 0, earned: u.earned || 0, admin: u.login.toLowerCase() === CFG.admin, canEarn: canEarn(u) });
  const canEarn = (u) => !u.ghCreated || Date.now() - new Date(u.ghCreated) > CFG.minAccountDays * DAY;

  // вход
  app.get("/auth/login", (req, res) => {
    if (!CFG.clientId) return res.status(500).send("Вход не настроен: задайте GITHUB_CLIENT_ID и GITHUB_CLIENT_SECRET");
    const state = crypto.randomBytes(12).toString("hex");
    const back = String(req.query.back || "/bux").startsWith("/") ? String(req.query.back || "/bux") : "/bux";
    setCookie(res, "at_o", `${state}|${back}`, 600);
    redirect(res, `https://github.com/login/oauth/authorize?client_id=${CFG.clientId}&redirect_uri=${encodeURIComponent(siteUrl(req) + "/auth/callback")}&state=${state}&allow_signup=true`);
  });
  app.get("/auth/callback", async (req, res) => {
    if (!guard(res)) return;
    const [state, back] = (getCookie(req, "at_o") || "").split("|");
    if (!state || state !== req.query.state) return res.status(400).send("Ошибка входа (state). Попробуйте ещё раз.");
    const t = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: CFG.clientId, client_secret: CFG.clientSecret, code: req.query.code }),
    }).then((r) => r.json()).catch(() => ({}));
    if (!t.access_token) return res.status(400).send("GitHub не подтвердил вход. Попробуйте ещё раз.");
    const gu = await fetch("https://api.github.com/user", { headers: { Authorization: `Bearer ${t.access_token}`, "User-Agent": "anytube-bux" } }).then((r) => r.json());
    if (!gu.id) return res.status(400).send("Не удалось получить профиль GitHub");
    const uid = "g" + gu.id;
    const u = db.users[uid] || (db.users[uid] = { uid, ad: 0, earn: 0, held: 0, views: 0, earned: 0, created: Date.now() });
    Object.assign(u, { login: gu.login, avatar: gu.avatar_url, ghCreated: gu.created_at, last: Date.now() });
    save();
    const data = Buffer.from(JSON.stringify({ uid, exp: Date.now() + 30 * DAY })).toString("base64url");
    res.setHeader("Set-Cookie", [
      `at_s=${data}.${sign(data)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${siteUrl(req).startsWith("https") ? "; Secure" : ""}`,
      "at_o=; Path=/; Max-Age=0",
    ]);
    redirect(res, back || "/bux");
  });
  app.get("/auth/logout", (req, res) => { setCookie(res, "at_s", "", 0); redirect(res, "/bux"); });

  app.get("/api/bux/me", (req, res) => {
    const u = loaded ? sessionUser(req) : null;
    res.json({ user: pub(u), ready: loaded, loginEnabled: !!CFG.clientId, topupEnabled: !!(CFG.wallet && CFG.ymSecret),
      sbpEnabled: !!CFG.sbpPhone,
      tariffs: Object.entries(TARIFFS).map(([s, p]) => ({ seconds: +s, price: p, reward: reward(p) })),
      minWithdraw: CFG.minWithdraw, minTopup: CFG.minTopup, minAccountDays: CFG.minAccountDays,
      payoutEmail: CFG.payoutEmail, commission: CFG.commission });
  });

  // ── заработать: список рекламы ──
  app.get("/api/bux/tasks", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    const { videos } = await getVideos();
    const byId = new Map(videos.map((v) => [v.id, v]));
    const now = Date.now();
    const me = u.login.toLowerCase();
    const list = Object.values(db.campaigns)
      .filter((c) => c.status === "active" && c.left >= c.price && c.uid !== u.uid && byId.has(c.video) && !isHidden(byId.get(c.video)))
      .filter((c) => c.type === "dislike"
        ? byId.get(c.video).owner.toLowerCase() !== me && !db.dislikeDone[`${u.uid}:${c.video}`]   // себе дизлайк не засчитывается; одно видео — один раз
        : c.type === "like"
          ? byId.get(c.video).owner.toLowerCase() !== me && !db.likeDone[`${u.uid}:${c.video}`] && !db.likes[c.video]?.by?.[`u:${u.uid}`]
          : !(now - (db.views[`${u.uid}:${c.id}`] || 0) < DAY))
      .sort((a, b) => b.reward - a.reward)
      .map((c) => { const v = byId.get(c.video); return { id: c.id, type: c.type || "view", seconds: c.seconds, level: c.level, levelLabel: DISLIKE_LEVELS[c.level],
        reward: c.reward, title: v.title, owner: v.owner, avatar: v.avatar, video: v.id }; });
    res.json({ tasks: list, canEarn: canEarn(u) });
  });

  app.post("/api/bux/start", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    if (!canEarn(u)) return res.status(403).json({ error: `Зарабатывать можно с GitHub-аккаунта старше ${CFG.minAccountDays} дней` });
    const { cid } = await readBody(req);
    const c = db.campaigns[cid];
    if (!c || c.status !== "active" || c.left < c.price || c.type === "dislike") return res.status(404).json({ error: "Эта реклама уже закончилась" });
    if (c.uid === u.uid) return res.status(400).json({ error: "Свою рекламу смотреть за деньги нельзя" });
    if (Date.now() - (db.views[`${u.uid}:${cid}`] || 0) < DAY) return res.status(429).json({ error: "Это видео вы уже смотрели сегодня" });
    if (c.type === "like" && (db.likeDone[`${u.uid}:${c.video}`] || db.likes[c.video]?.by?.[`u:${u.uid}`])) return res.status(400).json({ error: "Вы уже лайкнули это видео" });
    for (const [t, s] of sessions) if (s.uid === u.uid || Date.now() - s.start > 30 * 60 * 1000) sessions.delete(t); // одно окно за раз
    const { videos } = await getVideos();
    const v = videos.find((x) => x.id === c.video);
    if (!v) return res.status(404).json({ error: "Видео недоступно" });
    const token = crypto.randomBytes(16).toString("hex");
    const digit = 1 + crypto.randomInt(9);
    sessions.set(token, { uid: u.uid, cid, start: Date.now(), need: c.seconds, digit, ip: ipOf(req) });
    res.json({ token, seconds: c.seconds, reward: c.reward, digit,
      video: { src: v.parts?.[0]?.src || v.src, title: v.title, owner: v.owner, id: v.id } });
  });

  app.post("/api/bux/finish", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    const { token, answer } = await readBody(req);
    const s = sessions.get(token);
    if (!s || s.uid !== u.uid) return res.status(400).json({ error: "Просмотр не найден — начните заново" });
    const elapsed = (Date.now() - s.start) / 1000;
    if (elapsed < s.need - 1) return res.status(400).json({ error: `Нужно смотреть ${s.need} с` });
    sessions.delete(token);
    if (Number(answer) !== s.digit) return res.status(400).json({ error: "Неверная цифра — просмотр не засчитан" });
    const c = db.campaigns[s.cid];
    if (!c || c.status !== "active" || c.left < c.price) return res.status(410).json({ error: "Реклама закончилась, пока вы смотрели" });
    const ipKey = `${s.ip}:${s.cid}`;
    if (s.ip && Date.now() - (db.ipViews[ipKey] || 0) < DAY) return res.status(429).json({ error: "С этого интернета это видео уже смотрели сегодня" });
    c.left -= c.price; c.views++;
    const r = c.reward;
    u.earn += r; u.earned = (u.earned || 0) + r; u.views = (u.views || 0) + 1;
    db.views[`${u.uid}:${c.id}`] = Date.now();
    if (s.ip) db.ipViews[ipKey] = Date.now();
    if (c.left < c.price) { c.status = "done"; }
    if (c.type === "like") {
      addLike(c.video, `u:${u.uid}`, null);
      db.likeDone[`${u.uid}:${c.video}`] = Date.now();
      op(u.uid, "like", r, `лайк ${c.id}`);
    } else op(u.uid, "view", r, `просмотр ${c.id}`);
    save();
    res.json({ ok: true, reward: r, earn: u.earn, liked: c.type === "like" });
  });

  // ── реклама ──
  app.get("/api/bux/campaigns", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    const { videos } = await getVideos();
    const mine = videos.filter((v) => v.owner.toLowerCase() === u.login.toLowerCase()).map((v) => ({ id: v.id, title: v.title }));
    const list = Object.values(db.campaigns).filter((c) => c.uid === u.uid).sort((a, b) => b.created - a.created);
    res.json({ campaigns: list, myVideos: mine });
  });
  app.post("/api/bux/campaigns", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    const b = await readBody(req);
    if (b.type === "dislike") return createDislikeCampaign(u, b, res);
    if (b.type === "like") return createLikeCampaign(u, b, res);
    const seconds = Number(b.seconds), count = Math.floor(Number(b.count));
    const price = TARIFFS[seconds];
    if (!price) return res.status(400).json({ error: "Неверное время просмотра" });
    if (!(count >= 10 && count <= 100000)) return res.status(400).json({ error: "Просмотров: от 10 до 100 000" });
    const { videos } = await getVideos();
    const v = videos.find((x) => x.id === b.video);
    if (!v) return res.status(404).json({ error: "Видео не найдено на AnyTube" });
    if (v.owner.toLowerCase() !== u.login.toLowerCase()) return res.status(403).json({ error: "Рекламировать можно только свои видео" });
    const cost = price * count;
    if (u.ad < cost) return res.status(402).json({ error: `Не хватает ${rub(cost - u.ad)} ₽ на рекламном балансе` });
    u.ad -= cost;
    const c = { id: id("c"), uid: u.uid, video: v.id, seconds, price, reward: reward(price), budget: cost, left: cost, views: 0, status: "active", created: Date.now() };
    db.campaigns[c.id] = c;
    op(u.uid, "campaign", -cost, `реклама ${c.id}: ${count} × ${seconds} с`);
    await save(true);
    res.json({ ok: true, campaign: c, ad: u.ad });
  });
  app.post("/api/bux/campaigns/stop", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    const { cid } = await readBody(req);
    const c = db.campaigns[cid];
    if (!c || (c.uid !== u.uid && u.login.toLowerCase() !== CFG.admin)) return res.status(404).json({ error: "Не найдено" });
    if (c.status === "stopped") return res.json({ ok: true });
    const owner = db.users[c.uid];
    owner.ad += c.left;
    op(c.uid, "refund", c.left, `остаток рекламы ${c.id}`);
    c.left = 0; c.status = "stopped";
    await save(true);
    res.json({ ok: true, ad: owner.ad });
  });

  // ── кошелёк ──
  app.post("/api/bux/to-ad", async (req, res) => { // заработанное → на рекламу
    const u = auth(req, res); if (!u) return;
    const amount = Math.round(Number(String((await readBody(req)).amount).replace(",", ".")) * 100);
    if (!(amount > 0 && amount <= u.earn)) return res.status(400).json({ error: "Неверная сумма" });
    u.earn -= amount; u.ad += amount;
    op(u.uid, "to-ad", amount, "перевод заработка на рекламу");
    await save(true);
    res.json({ ok: true, user: pub(u) });
  });
  app.get("/bux/topup", (req, res) => { // пополнение рекламного баланса через ЮMoney
    if (!guard(res)) return;
    const u = sessionUser(req);
    if (!u) return redirect(res, "/auth/login?back=/bux");
    if (!CFG.wallet || !CFG.ymSecret) return res.status(400).send("Пополнение не настроено (YOOMONEY_WALLET и YOOMONEY_SECRET)");
    const sum = Math.round(Number(String(req.query.sum || "").replace(",", ".")) * 100);
    if (!(sum >= CFG.minTopup && sum <= 1_500_000)) return res.status(400).send(`Сумма: от ${rub(CFG.minTopup)} до 15000 ₽`);
    const fields = { receiver: CFG.wallet, "quickpay-form": "button", paymentType: req.query.type === "PC" ? "PC" : "AC",
      sum: rub(sum), label: `BUX:${u.uid}`, successURL: `${siteUrl(req)}/bux?tab=wallet&topup=1` };
    const e = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><meta charset="utf-8"><title>Переход в ЮMoney…</title><body style="font:16px system-ui;background:#0f0f12;color:#eee;display:grid;place-items:center;height:100vh;margin:0">
<form id="f" method="POST" action="https://yoomoney.ru/quickpay/confirm">${Object.entries(fields).map(([k, v]) => `<input type="hidden" name="${k}" value="${e(v)}">`).join("")}
<p>Пополнение рекламного баланса AnyTube на ${rub(sum)} ₽…</p><button>Перейти в ЮMoney</button></form><script>document.getElementById("f").submit()</script>`);
  });
  // уведомление ЮMoney о входящем переводе → зачисление на рекламный баланс
  app.post("/api/yoomoney/notify", async (req, res) => {
    let p;
    try { p = await readBody(req); } catch { return res.status(400).send("bad"); }
    if (!CFG.ymSecret || !p.sign) return res.status(400).send("no sign");
    const want = yoomoneySign(p, CFG.ymSecret);
    if (want.length !== p.sign.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(String(p.sign).toLowerCase()))) {
      console.warn("[bux] уведомление ЮMoney с неверной подписью отклонено");
      return res.status(400).send("bad sign");
    }
    if (p.test_notification) { console.log("[bux] тестовое уведомление ЮMoney получено, подпись верна"); return res.status(200).send("ok"); }
    if (!loaded) return res.status(503).send("db"); // ЮMoney повторит позже
    const m = String(p.label || "").match(/^BUX:(g\d+)$/);
    if (!m || !db.users[m[1]]) { console.warn("[bux] перевод без метки букса:", p.operation_id, p.amount); return res.status(200).send("ok"); }
    if (db.topups[p.operation_id]) return res.status(200).send("ok"); // уже зачислено
    const amount = Math.round(Number(p.amount) * 100);
    if (!(amount > 0) || p.unaccepted === "true") return res.status(200).send("ok");
    const u = db.users[m[1]];
    u.ad += amount;
    db.topups[p.operation_id] = { uid: u.uid, amount, t: Date.now() };
    op(u.uid, "topup", amount, `ЮMoney ${p.operation_id}`);
    await save(true);
    console.log(`[bux] пополнение ${u.login}: ${rub(amount)} ₽`);
    res.status(200).send("ok");
  });

  // вывод: сумма замораживается до решения администратора
  app.post("/api/bux/withdraw", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    const b = await readBody(req);
    const amount = Math.round(Number(String(b.amount).replace(",", ".")) * 100);
    const wallet = String(b.wallet || "").replace(/\D/g, "");
    const text = String(b.text || "").trim().slice(0, 5000);
    if (!(amount >= CFG.minWithdraw)) return res.status(400).json({ error: `Минимум для вывода ${rub(CFG.minWithdraw)} ₽` });
    if (amount > u.earn) return res.status(400).json({ error: "Не хватает заработанных средств" });
    if (!/^\d{11,20}$/.test(wallet)) return res.status(400).json({ error: "Номер кошелька ЮMoney — 11–20 цифр" });
    if (text.length < 10) return res.status(400).json({ error: "Опишите выполненную работу (хотя бы пару слов)" });
    u.earn -= amount; u.held = (u.held || 0) + amount;
    const w = { id: id("w"), uid: u.uid, login: u.login, amount, wallet, text, email: String(b.email || "").slice(0, 200),
      views: u.views || 0, earned: u.earned || 0, status: "pending", created: Date.now() };
    db.withdrawals[w.id] = w;
    op(u.uid, "withdraw", -amount, `заявка ${w.id}`);
    await save(true);
    res.json({ ok: true, withdrawal: w, user: pub(u) });
  });
  app.get("/api/bux/history", (req, res) => {
    const u = auth(req, res); if (!u) return;
    res.json({ ops: db.ops.filter((o) => o.uid === u.uid).slice(-100).reverse(),
      withdrawals: Object.values(db.withdrawals).filter((w) => w.uid === u.uid).sort((a, b) => b.created - a.created) });
  });

  // ── админка ──
  const admin = (req, res) => { const u = auth(req, res); if (!u) return null; if (u.login.toLowerCase() !== CFG.admin) { res.status(403).json({ error: "Только для администратора" }); return null; } return u; };
  app.get("/api/bux/admin", (req, res) => {
    if (!admin(req, res)) return;
    const users = Object.values(db.users);
    const sum = (f) => users.reduce((s, u) => s + (u[f] || 0), 0);
    const camps = Object.values(db.campaigns);
    const topups = Object.values(db.topups).reduce((s, t) => s + t.amount, 0);
    const paid = Object.values(db.withdrawals).filter((w) => w.status === "paid").reduce((s, w) => s + w.amount, 0);
    const viewsPaid = camps.reduce((s, c) => s + c.views * c.reward, 0);      // заработали зрители
    const income = camps.reduce((s, c) => s + c.views * (c.price - c.reward), 0); // комиссия AnyTube
    const active = camps.filter((c) => c.status === "active").reduce((s, c) => s + c.left, 0);
    res.json({
      totals: { users: users.length, ad: sum("ad"), earn: sum("earn"), held: sum("held"), topups, paid, viewsPaid, income, active },
      withdrawals: Object.values(db.withdrawals).sort((a, b) => (a.status === "pending" ? -1 : 1) - (b.status === "pending" ? -1 : 1) || b.created - a.created).slice(0, 300),
      campaigns: camps.sort((a, b) => b.created - a.created).slice(0, 300).map((c) => ({ ...c, login: db.users[c.uid]?.login })),
      users: users.sort((a, b) => (b.earned || 0) - (a.earned || 0)).slice(0, 300).map(pub),
      storage: useGitHub() ? `GitHub: ${CFG.dbRepo}` : "локальный файл (сотрётся при перезапуске Render!)",
    });
  });
  app.post("/api/bux/admin/withdrawal", async (req, res) => {
    if (!admin(req, res)) return;
    const { wid, action } = await readBody(req);
    const w = db.withdrawals[wid];
    if (!w || w.status !== "pending") return res.status(400).json({ error: "Заявка не найдена или уже обработана" });
    const u = db.users[w.uid];
    u.held -= w.amount;
    if (action === "paid") { w.status = "paid"; op(u.uid, "paid", 0, `выплачено ${rub(w.amount)} ₽ по заявке ${w.id}`); }
    else { w.status = "rejected"; u.earn += w.amount; op(u.uid, "rejected", w.amount, `заявка ${w.id} отклонена, деньги возвращены`); }
    w.done = Date.now();
    await save(true);
    res.json({ ok: true });
  });
  app.post("/api/bux/admin/credit", async (req, res) => { // ручное пополнение (если ЮMoney-уведомления не настроены)
    if (!admin(req, res)) return;
    const b = await readBody(req);
    const u = Object.values(db.users).find((x) => x.login.toLowerCase() === String(b.login || "").toLowerCase());
    if (!u) return res.status(404).json({ error: "Пользователь не найден (он должен хотя бы раз войти)" });
    const amount = Math.round(Number(String(b.amount).replace(",", ".")) * 100);
    if (!amount) return res.status(400).json({ error: "Неверная сумма" });
    const field = b.balance === "earn" ? "earn" : "ad";
    if (u[field] + amount < 0) return res.status(400).json({ error: "Баланс не может быть отрицательным" });
    u[field] += amount;
    op(u.uid, "admin", amount, `администратор: ${String(b.note || "").slice(0, 200)} (${field})`);
    await save(true);
    res.json({ ok: true, user: pub(u) });
  });
  app.post("/api/bux/admin/ban", async (req, res) => {
    if (!admin(req, res)) return;
    const { uid, ban } = await readBody(req);
    const u = db.users[uid];
    if (!u) return res.status(404).json({ error: "Нет такого пользователя" });
    u.banned = !!ban;
    await save(true);
    res.json({ ok: true });
  });

  // ═══════════════ МАГАЗИН: продажа видео, подписки на приложения, обои ═══════════════
  const PERIODS = { hour: 3600e3, day: DAY, month: 30 * DAY, year: 365 * DAY };
  const PERIOD_RU = { hour: "час", day: "день", month: "месяц", year: "год" };
  const seller = (v) => {
    const uid = "g" + v.ownerId;
    return db.users[uid] || (db.users[uid] = { uid, login: v.owner, avatar: v.avatar, ad: 0, earn: 0, held: 0, views: 0, earned: 0, created: Date.now(), placeholder: true });
  };
  const funds = (u) => u.ad + u.earn;
  function spend(u, amount) { // сначала пополненный баланс, потом заработанный
    if (funds(u) < amount) return false;
    const a = Math.min(u.ad, amount);
    u.ad -= a; u.earn -= amount - a;
    return true;
  }
  function payout(v, amount, note) {
    const s = seller(v);
    const net = Math.floor(amount * (1 - CFG.saleCommission));
    s.earn += net; s.earned = (s.earned || 0) + net;
    op(s.uid, "sale", net, note);
  }
  const isOwner = (u, v) => u && u.login.toLowerCase() === v.owner.toLowerCase();
  const access = (u, v) => {
    if (!u || !v.sale) return { owned: !v.sale, until: 0, timeUntil: 0 };
    if (isOwner(u, v)) return { owned: true, until: 0, timeUntil: 0, owner: true };
    const p = (db.purchases[u.uid] || {})[v.id];
    const owned = !!p && (p.until === 0 || p.until > Date.now());
    return { owned, until: p ? p.until : null, timeUntil: (db.timepass[u.uid] || {})[v.id] || 0 };
  };
  const findVideo = async (id) => (await getVideos()).videos.find((x) => x.id === id);

  app.get("/api/shop/access", async (req, res) => {
    const v = await findVideo(String(req.query.id || ""));
    if (!v) return res.status(404).json({ error: "Не найдено" });
    const u = loaded ? sessionUser(req) : null;
    res.json({ ...access(u, v), loggedIn: !!u, funds: u ? funds(u) : 0, sale: v.sale, commission: CFG.saleCommission,
      paidReady: !!CFG.paidToken });
  });

  app.post("/api/shop/buy", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    const { id, plan } = await readBody(req);
    const v = await findVideo(String(id || ""));
    if (!v || !v.sale) return res.status(404).json({ error: "Товар не найден" });
    if (isOwner(u, v)) return res.status(400).json({ error: "Это ваш товар, он и так доступен" });
    let price, until, note;
    if (plan === "buy" && v.sale.buy) { price = v.sale.buy; until = 0; note = `покупка «${v.title}»`; }
    else if (PERIODS[plan] && v.sale.sub?.[plan]) {
      price = v.sale.sub[plan];
      const cur = (db.purchases[u.uid] || {})[v.id];
      if (cur && cur.until === 0) return res.status(400).json({ error: "Уже куплено навсегда" });
      until = Math.max(Date.now(), cur?.until || 0) + PERIODS[plan]; // продление складывается
      note = `подписка «${v.title}» на ${PERIOD_RU[plan]}`;
    } else return res.status(400).json({ error: "Такого варианта нет" });
    if (!spend(u, price)) return res.status(402).json({ error: `Не хватает ${rub(price - funds(u))} ₽. Пополните баланс в буксе.` });
    (db.purchases[u.uid] ||= {})[v.id] = { until, plan, t: Date.now() };
    op(u.uid, "buy", -price, note);
    payout(v, price, `продажа: ${note}`);
    await save(true);
    res.json({ ok: true, ...access(u, v), funds: funds(u) });
  });

  // почасовой просмотр: поминутное списание, пока видео играет
  app.post("/api/shop/tick", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    const v = await findVideo(String((await readBody(req)).id || ""));
    if (!v || !v.sale?.per_hour) return res.status(404).json({ error: "Почасовой просмотр недоступен" });
    const a = access(u, v);
    if (a.owned) return res.json({ ok: true, owned: true });
    const now = Date.now(), tp = (db.timepass[u.uid] ||= {});
    // клиент спрашивает каждые 30 с; следующая минута списывается, только когда оплаченного времени осталось < 20 с
    // (минута за минуту; паузы не оплачиваются; запас 25 с на выдаче не даёт видео оборваться между тиками)
    if ((tp[v.id] || 0) - now > 20e3) return res.json({ ok: true, timeUntil: tp[v.id], funds: funds(u) });
    const cost = Math.max(1, Math.round(v.sale.per_hour / 60));
    if (!spend(u, cost)) return res.status(402).json({ error: "Баланс закончился — пополните, чтобы смотреть дальше" });
    tp[v.id] = Math.max(tp[v.id] || 0, now) + 60e3;
    opMerge(u.uid, "watch", -cost, `просмотр «${v.title}»`);
    const s = seller(v), net = cost * (1 - CFG.saleCommission);
    s.earnFrac = (s.earnFrac || 0) + net; const whole = Math.floor(s.earnFrac); s.earnFrac -= whole;
    s.earn += whole; s.earned = (s.earned || 0) + whole;
    opMerge(s.uid, "sale", whole, `просмотры «${v.title}»`);
    save();
    res.json({ ok: true, charged: cost, timeUntil: tp[v.id], funds: funds(u) });
  });
  function opMerge(uid, type, amount, note) { // поминутные списания складываем в одну строку истории
    const last = [...db.ops].reverse().find((o) => o.uid === uid);
    if (last && last.type === type && last.note === note && Date.now() - last.t < 3 * 3600e3) { last.amount += amount; last.t = Date.now(); }
    else op(uid, type, amount, note);
  }

  // выдача платных файлов из приватных репозиториев — только тем, у кого есть доступ
  async function streamPaid(req, res, v, f) {
    if (!CFG.paidToken) return res.status(503).send("Платные файлы не настроены (PAID_TOKEN)");
    const url = `${f.lfs ? "https://media.githubusercontent.com/media" : "https://raw.githubusercontent.com"}/${v.owner}/${f.repo}/HEAD/${f.path.split("/").map(encodeURIComponent).join("/")}`;
    const up = await fetch(url, { headers: { Authorization: `token ${CFG.paidToken}`, ...(req.headers.range ? { Range: req.headers.range } : {}) } }).catch(() => null);
    if (!up || (!up.ok && up.status !== 206)) return res.status(502).send("Файл недоступен. Автор должен пригласить аккаунт сайта в приватный репозиторий.");
    res.statusCode = up.status;
    for (const h of ["content-type", "content-length", "content-range"]) { const x = up.headers.get(h); if (x) res.setHeader(h, x); }
    if (/\.(mp4|m4v)$/i.test(f.path)) res.setHeader("Content-Type", "video/mp4");
    if (/\.webm$/i.test(f.path)) res.setHeader("Content-Type", "video/webm");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, no-store");
    if (req.query.download) res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.name || f.path.split("/").pop())}`);
    const { Readable } = await import("node:stream");
    Readable.fromWeb(up.body).pipe(res);
    req.on("close", () => up.body?.cancel?.().catch(() => {}));
  }
  app.get("/paid/part", async (req, res) => {
    if (!guard(res)) return;
    const v = await findVideo(String(req.query.id || ""));
    const f = v?._paid?.parts?.[Number(req.query.n) - 1];
    if (!f) return res.status(404).send("Не найдено");
    const u = sessionUser(req), a = access(u, v);
    if (!u) return res.status(401).send("Войдите через GitHub");
    if (!a.owned && !(a.timeUntil > Date.now() - 25e3)) return res.status(402).send("Нет доступа: купите видео или включите почасовой просмотр");
    streamPaid(req, res, v, f);
  });
  app.get("/paid/file", async (req, res) => {
    if (!guard(res)) return;
    const v = await findVideo(String(req.query.id || ""));
    const f = v?._paid?.files?.[Number(req.query.f) || 0];
    if (!f) return res.status(404).send("Не найдено");
    const u = sessionUser(req);
    if (!u) return redirect(res, `/auth/login?back=${encodeURIComponent("/watch?v=" + encodeURIComponent(v.id))}`);
    if (!access(u, v).owned) return res.status(402).send("Нет доступа: сначала купите или оформите подписку");
    req.query.download = "1";
    streamPaid(req, res, v, f);
  });

  // сайт сам принимает приглашения в приватные репозитории anytubepaid_*
  async function acceptInvites() {
    if (!CFG.paidToken) return;
    try {
      const r = await fetch("https://api.github.com/user/repository_invitations?per_page=100", { headers: { Authorization: `token ${CFG.paidToken}`, "User-Agent": "anytube-bux", Accept: "application/vnd.github+json" } });
      if (!r.ok) return console.warn("[shop] приглашения: GitHub", r.status);
      for (const inv of await r.json()) {
        if (!String(inv.repository?.name || "").toLowerCase().startsWith("anytubepaid_")) continue;
        const a = await fetch(`https://api.github.com/user/repository_invitations/${inv.id}`, { method: "PATCH", headers: { Authorization: `token ${CFG.paidToken}`, "User-Agent": "anytube-bux" } });
        console.log(`[shop] приглашение в ${inv.repository.full_name}: ${a.status === 204 ? "принято" : a.status}`);
      }
    } catch (e) { console.warn("[shop] приглашения:", e.message); }
  }
  acceptInvites();
  setInterval(acceptInvites, 5 * 60e3).unref?.();

  app.get("/api/shop/my", (req, res) => {
    const u = auth(req, res); if (!u) return;
    res.json({ purchases: db.purchases[u.uid] || {} });
  });

  // ═══════════════ ПОПОЛНЕНИЕ ПО СБП (ручное подтверждение администратором) ═══════════════
  app.post("/api/bux/sbp", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    if (!CFG.sbpPhone) return res.status(400).json({ error: "Пополнение по СБП не настроено" });
    const amount = Math.round(Number(String((await readBody(req)).amount).replace(",", ".")) * 100);
    if (!(amount >= CFG.minTopup && amount <= 1_500_000)) return res.status(400).json({ error: `Сумма: от ${rub(CFG.minTopup)} до 15000 ₽` });
    const open = Object.values(db.sbp).filter((x) => x.uid === u.uid && x.status !== "done" && x.status !== "rejected");
    if (open.length >= 3) return res.status(429).json({ error: "У вас уже 3 непроверенные заявки — дождитесь проверки" });
    const code = "AT" + crypto.randomInt(100000, 999999);
    const x = { id: id("s"), uid: u.uid, login: u.login, amount, code, status: "new", created: Date.now() };
    db.sbp[x.id] = x;
    await save(true);
    res.json({ ok: true, request: x, phone: CFG.sbpPhone, bank: CFG.sbpBank, name: CFG.sbpName });
  });
  app.post("/api/bux/sbp/sent", async (req, res) => { // «Я перевёл»
    const u = auth(req, res); if (!u) return;
    const x = db.sbp[(await readBody(req)).id];
    if (!x || x.uid !== u.uid || x.status !== "new") return res.status(400).json({ error: "Заявка не найдена" });
    x.status = "sent"; x.sent = Date.now();
    await save(true);
    res.json({ ok: true });
  });
  app.get("/api/bux/sbp", (req, res) => {
    const u = auth(req, res); if (!u) return;
    res.json({ requests: Object.values(db.sbp).filter((x) => x.uid === u.uid).sort((a, b) => b.created - a.created).slice(0, 20),
      phone: CFG.sbpPhone, bank: CFG.sbpBank, name: CFG.sbpName });
  });
  app.post("/api/bux/admin/sbp", async (req, res) => {
    if (!admin(req, res)) return;
    const { sid, action, amount } = await readBody(req);
    const x = db.sbp[sid];
    if (!x || x.status === "done" || x.status === "rejected") return res.status(400).json({ error: "Заявка не найдена или уже обработана" });
    if (action === "confirm") {
      const real = amount ? Math.round(Number(String(amount).replace(",", ".")) * 100) : x.amount; // сколько реально пришло
      if (!(real > 0)) return res.status(400).json({ error: "Неверная сумма" });
      const u = db.users[x.uid];
      u.ad += real; x.status = "done"; x.credited = real;
      db.topups["sbp:" + x.id] = { uid: u.uid, amount: real, t: Date.now() };
      op(u.uid, "topup", real, `СБП, код ${x.code}`);
    } else { x.status = "rejected"; }
    x.done = Date.now();
    await save(true);
    res.json({ ok: true });
  });
  app.get("/api/bux/admin/sbp", (req, res) => {
    if (!admin(req, res)) return;
    res.json({ requests: Object.values(db.sbp).sort((a, b) => (b.status === "sent") - (a.status === "sent") || b.created - a.created).slice(0, 300) });
  });

  // ═══════════════ ДИЗЛАЙКИ ЗА ДЕНЬГИ (любое видео, любой из 5 уровней) ═══════════════
  const videoIdFrom = (x) => {
    let s = String(x || "").trim();
    try { if (/^https?:/i.test(s)) s = new URL(s).searchParams.get("v") || s; } catch {}
    return decodeURIComponent(s).replace(/^\/+|\/+$/g, "");
  };
  async function createDislikeCampaign(u, b, res) {
    const level = Number(b.level), count = Math.floor(Number(b.count));
    if (!DISLIKE_LEVELS[level]) return res.status(400).json({ error: "Выберите уровень дизлайка от 1 до 5" });
    if (!(count >= 1 && count <= 10000)) return res.status(400).json({ error: "Дизлайков: от 1 до 10 000" });
    const { videos } = await getVideos();
    const v = videos.find((x) => x.id === videoIdFrom(b.video));
    if (!v) return res.status(404).json({ error: "Видео не найдено на AnyTube — вставьте ссылку со страницы видео" });
    const price = CFG.dislikePrice, cost = price * count;
    if (u.ad < cost) return res.status(402).json({ error: `Не хватает ${rub(cost - u.ad)} ₽ на пополненном балансе` });
    u.ad -= cost;
    const c = { id: id("d"), type: "dislike", uid: u.uid, video: v.id, level, price, reward: reward(price), budget: cost, left: cost, views: 0, status: "active", created: Date.now() };
    db.campaigns[c.id] = c;
    op(u.uid, "campaign", -cost, `дизлайки ${c.id}: ${count} × уровень ${level}`);
    await save(true);
    res.json({ ok: true, campaign: c, ad: u.ad });
  }
  const ghRepo = async (owner, name) => {
    const r = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`, {
      headers: { "User-Agent": "anytube-bux", Accept: "application/vnd.github+json", ...(CFG.ghToken ? { Authorization: `Bearer ${CFG.ghToken}` } : {}) } }).catch(() => null);
    if (!r) return { error: true };
    if (r.status === 404) return null;
    if (!r.ok) return { error: true };
    return r.json();
  };
  const lastCheck = new Map();
  app.post("/api/bux/dislike/check", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    if (!canEarn(u)) return res.status(403).json({ error: `Зарабатывать можно с GitHub-аккаунта старше ${CFG.minAccountDays} дней` });
    if (Date.now() - (lastCheck.get(u.uid) || 0) < 8000) return res.status(429).json({ error: "Подождите несколько секунд и проверьте снова" });
    lastCheck.set(u.uid, Date.now());
    const c = db.campaigns[(await readBody(req)).cid];
    if (!c || c.type !== "dislike" || c.status !== "active" || c.left < c.price) return res.status(404).json({ error: "Это задание уже закончилось" });
    if (c.uid === u.uid) return res.status(400).json({ error: "Своё задание выполнять нельзя" });
    if (db.dislikeDone[`${u.uid}:${c.video}`]) return res.status(400).json({ error: "За дизлайк этому видео вы уже получили оплату" });
    const v = (await getVideos()).videos.find((x) => x.id === c.video);
    if (!v) return res.status(404).json({ error: "Видео недоступно" });
    if (v.owner.toLowerCase() === u.login.toLowerCase()) return res.status(400).json({ error: "Своему видео дизлайк не засчитывается" });
    const file = v.id.split("/").pop();
    const want = await ghRepo(u.login, dislikeRepoName(v.owner, file, c.level));
    if (want?.error) return res.status(502).json({ error: "GitHub сейчас не ответил — попробуйте через минуту" });
    if (!want || want.private || String(want.owner?.login).toLowerCase() !== u.login.toLowerCase()) {
      for (let l = 1; l <= 5; l++) {            // подсказка, если перепутан уровень
        if (l === c.level) continue;
        const other = await ghRepo(u.login, dislikeRepoName(v.owner, file, l));
        if (other && !other.error && !other.private)
          return res.status(400).json({ error: `Вы поставили уровень ${l} «${DISLIKE_LEVELS[l]}», а нужен уровень ${c.level} «${DISLIKE_LEVELS[c.level]}». Откройте AnyTube Uploader → «Дизлайк», выберите уровень ${c.level} и нажмите снова — уровень поменяется.` });
      }
      return res.status(400).json({ error: `Дизлайк не найден. Поставьте его через AnyTube Uploader (вкладка «Дизлайк», уровень ${c.level}) и подождите ~10 секунд.` });
    }
    c.left -= c.price; c.views++;
    if (c.left < c.price) c.status = "done";
    u.earn += c.reward; u.earned = (u.earned || 0) + c.reward;
    u.dislikes = (u.dislikes || 0) + 1;
    db.dislikeDone[`${u.uid}:${c.video}`] = { t: Date.now(), cid: c.id, repo: want.full_name };
    op(u.uid, "dislike", c.reward, `дизлайк ур. ${c.level}: ${v.title}`);
    await save(true);
    res.json({ ok: true, reward: c.reward, earn: u.earn });
  });
  app.get("/api/bux/dislike/info", (req, res) => res.json({ price: CFG.dislikePrice, reward: reward(CFG.dislikePrice), levels: DISLIKE_LEVELS }));

  // ═══════════════ СКРЫТИЕ ВИДЕО И ПОИСК ДУБЛЕЙ (админ) ═══════════════
  app.post("/api/bux/admin/hide", async (req, res) => {
    if (!admin(req, res)) return;
    const { id: vid, hide, reason } = await readBody(req);
    if (!vid) return res.status(400).json({ error: "Нет id видео" });
    db.hidden ||= {};
    if (hide) db.hidden[vid] = { t: Date.now(), reason: String(reason || "").slice(0, 200) };
    else delete db.hidden[vid];
    await save(true);
    res.json({ ok: true });
  });
  app.get("/api/bux/admin/dups", async (req, res) => {
    if (!admin(req, res)) return;
    const { videos } = await getVideos();
    // одинаковый размер файла и длительность (до секунды) у разных репозиториев = почти наверняка один и тот же ролик
    const groups = new Map();
    for (const v of videos) {
      if (!v.size || v.size < 300) continue;
      const k = `${v.size}:${Math.round(v.duration || 0)}`;
      (groups.get(k) || groups.set(k, []).get(k)).push(v);
    }
    const dups = [...groups.values()].filter((g) => g.length > 1).map((g) => g
      .sort((a, b) => new Date(a.created || a.updated) - new Date(b.created || b.updated))
      .map((v, i) => ({ id: v.id, title: v.title, owner: v.owner, created: v.created || v.updated, size: v.size, duration: v.duration, first: i === 0, hidden: isHidden(v) })));
    const hidden = Object.entries(db.hidden || {}).map(([vid, h]) => ({ id: vid, ...h }));
    res.json({ dups, hidden });
  });

  // ═══════════════ ЛАЙКИ (без входа через GitHub) ═══════════════
  const ipKey = (req) => crypto.createHmac("sha256", CFG.sessionSecret).update(ipOf(req) || "?").digest("hex").slice(0, 16);
  function visitorKey(req, res) {
    const u = loaded ? sessionUser(req) : null;
    if (u) return `u:${u.uid}`;
    let vid = getCookie(req, "at_v");
    if (!vid || !/^[a-f0-9]{24}$/.test(vid)) {
      vid = crypto.randomBytes(12).toString("hex");
      res.setHeader("Set-Cookie", `at_v=${vid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${5 * 365 * 86400}${(CFG.site || "").startsWith("https") ? "; Secure" : ""}`);
    }
    return `v:${vid}`;
  }
  const likeRate = new Map();
  app.get("/api/like", (req, res) => {
    if (!guard(res)) return;
    const id = String(req.query.id || ""), key = visitorKey(req, res);
    res.json({ count: likesOf(id), liked: !!db.likes[id]?.by?.[key] });
  });
  app.post("/api/like", async (req, res) => {
    if (!guard(res)) return;
    const id = String((await readBody(req)).id || "");
    const v = (await getVideos()).videos.find((x) => x.id === id);
    if (!v) return res.status(404).json({ error: "Видео не найдено" });
    const key = visitorKey(req, res), ipk = ipKey(req);
    const L = db.likes[id];
    if (L?.by?.[key]) { // повторное нажатие — убрать лайк
      delete L.by[key]; L.n = Math.max(0, L.n - 1);
      if (db.likeIp[`${ipk}:${id}`] === key) delete db.likeIp[`${ipk}:${id}`];
      save();
      return res.json({ count: L.n, liked: false });
    }
    const other = db.likeIp[`${ipk}:${id}`];
    if (other && other !== key && db.likes[id]?.by?.[other]) return res.status(429).json({ error: "С этого интернета это видео уже лайкнули" });
    const r = likeRate.get(ipk) || { n: 0, t: Date.now() };
    if (Date.now() - r.t > 3600e3) { r.n = 0; r.t = Date.now(); }
    if (++r.n > 60) return res.status(429).json({ error: "Слишком много лайков — попробуйте через час" });
    likeRate.set(ipk, r);
    addLike(id, key, ipk);
    save();
    res.json({ count: likesOf(id), liked: true });
  });
  async function createLikeCampaign(u, b, res) {
    const count = Math.floor(Number(b.count));
    if (!(count >= 1 && count <= 10000)) return res.status(400).json({ error: "Лайков: от 1 до 10 000" });
    const { videos } = await getVideos();
    const v = videos.find((x) => x.id === videoIdFrom(b.video));
    if (!v) return res.status(404).json({ error: "Видео не найдено на AnyTube — вставьте ссылку со страницы видео" });
    const price = CFG.likePrice, cost = price * count;
    if (u.ad < cost) return res.status(402).json({ error: `Не хватает ${rub(cost - u.ad)} ₽ на пополненном балансе` });
    u.ad -= cost;
    const c = { id: id("l"), type: "like", uid: u.uid, video: v.id, seconds: 15, price, reward: reward(price), budget: cost, left: cost, views: 0, status: "active", created: Date.now() };
    db.campaigns[c.id] = c;
    op(u.uid, "campaign", -cost, `лайки ${c.id}: ${count} шт.`);
    await save(true);
    res.json({ ok: true, campaign: c, ad: u.ad });
  }
  app.get("/api/bux/like/info", (req, res) => res.json({ price: CFG.likePrice, reward: reward(CFG.likePrice) }));

  // ═══════════════ ЖИВЫЕ ОБОИ С УСТАНОВЩИКОМ: zip «на лету» (видео + проигрыватель + install.cmd) ═══════════════
  const KIT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "wallpaper-kit");
  const CRC_T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
  const crc32 = (crc, buf) => { crc = ~crc; for (let i = 0; i < buf.length; i++) crc = CRC_T[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); return ~crc >>> 0; };
  function dosTime(d = new Date()) {
    return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
      date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
  }
  // потоковый ZIP: deflate (для видео уровень 0 — быстро), CRC и размеры — в дескрипторе после данных
  function zipWriter(out) {
    const entries = []; let offset = 0; const { time, date } = dosTime();
    const write = (b) => new Promise((ok, fail) => { offset += b.length; out.write(b) ? ok() : out.once("drain", ok); out.once("error", fail); });
    async function add(name, source, level) { // source: Buffer или асинхронный итератор Buffer'ов
      const nameB = Buffer.from(name, "utf8"), h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0808, 6); h.writeUInt16LE(8, 8);
      h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt16LE(nameB.length, 26);
      const start = offset; await write(Buffer.concat([h, nameB]));
      let crc = 0, size = 0, csize = 0;
      const def = zlib.createDeflateRaw({ level });
      const done = new Promise((ok, fail) => { def.on("end", ok); def.on("error", fail); });
      def.on("data", (c) => { csize += c.length; offset += c.length; if (!out.write(c)) { def.pause(); out.once("drain", () => def.resume()); } });
      for await (const chunk of (Buffer.isBuffer(source) ? [source] : source)) {
        const b = Buffer.from(chunk); crc = crc32(crc, b); size += b.length;
        if (!def.write(b)) await new Promise((ok) => def.once("drain", ok));
      }
      def.end(); await done;
      const dd = Buffer.alloc(16); dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(csize, 8); dd.writeUInt32LE(size, 12);
      await write(dd);
      entries.push({ nameB, crc, csize, size, start });
    }
    async function finish() {
      const cdStart = offset; const parts = [];
      for (const e of entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8); c.writeUInt16LE(8, 10);
        c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(e.nameB.length, 28); c.writeUInt32LE(e.start, 42);
        parts.push(c, e.nameB);
      }
      const cd = Buffer.concat(parts), end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdStart, 16);
      await write(cd); await write(end); out.end();
    }
    return { add, finish };
  }
  app.get("/wallpaper/kit", async (req, res) => {
    const v = (await getVideos()).videos.find((x) => x.id === String(req.query.id || ""));
    if (!v || v.kind !== "wallpaper") return res.status(404).send("Обои не найдены");
    let url, headers = {}, ext;
    if (v.sale) {
      if (!guard(res)) return;
      const u = sessionUser(req);
      if (!u) return redirect(res, `/auth/login?back=${encodeURIComponent("/watch?v=" + encodeURIComponent(v.id))}`);
      const f = v._paid?.files?.[0];
      if (!f || !access(u, v).owned) return res.status(402).send("Сначала купите эти обои");
      if (!CFG.paidToken) return res.status(503).send("Платные файлы не настроены (PAID_TOKEN)");
      url = `${f.lfs ? "https://media.githubusercontent.com/media" : "https://raw.githubusercontent.com"}/${v.owner}/${f.repo}/HEAD/${f.path.split("/").map(encodeURIComponent).join("/")}`;
      headers = { Authorization: `token ${CFG.paidToken}` };
      ext = path.extname(f.name || f.path);
    } else {
      const f = v.files?.[0];
      if (!f) return res.status(404).send("У этих обоев нет файла для скачивания");
      url = f.url; ext = path.extname(f.name || "");
    }
    ext = /^\.(mp4|webm|mkv|mov|avi|gif)$/i.test(ext) ? ext.toLowerCase() : ".mp4";
    const up = await fetch(url, { headers }).catch(() => null);
    if (!up || !up.ok) return res.status(502).send("Не удалось получить файл обоев с GitHub");
    const slugName = String(v.title || "wallpaper").replace(/[^\p{L}\p{N}_-]+/gu, "_").slice(0, 60) || "wallpaper";
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="AnyTube-wallpaper.zip"; filename*=UTF-8''${encodeURIComponent("AnyTube-обои-" + slugName + ".zip")}`);
    res.setHeader("Cache-Control", "private, no-store");
    const zip = zipWriter(res);
    try {
      for (const name of ["install.cmd", "start.cmd", "stop.cmd", "autostart.cmd", "live_wallpaper.py", "README.txt"])
        await zip.add(name, fs.readFileSync(path.join(KIT_DIR, name)), 6);
      await zip.add("wallpaper" + ext, up.body, 0); // видео уже сжато — кладём без пережатия
      await zip.finish();
    } catch (e) { console.error("[kit]", e.message); res.destroy(); }
  });

  // ═══════════════ МОДЕРАЦИЯ: жалобы, скрытие, блокировки ═══════════════
  const REASONS = { spam: "Спам или реклама", copy: "Чужое видео / нарушение авторских прав", adult: "Контент 18+", violence: "Насилие или жестокость",
    hate: "Оскорбления, травля, разжигание ненависти", illegal: "Запрещённое законом", fraud: "Мошенничество", other: "Другое" };
  app.get("/api/contacts", (req, res) => res.json({ ...CONTACTS, reasons: REASONS }));
  const reportRate = new Map();
  app.post("/api/report", async (req, res) => {
    if (!guard(res)) return;
    const b = await readBody(req);
    const type = ["video", "comment", "user", "other"].includes(b.type) ? b.type : "other";
    const target = String(b.target || "").trim().slice(0, 300);
    const reason = REASONS[b.reason] ? b.reason : "other";
    const text = String(b.text || "").trim().slice(0, 3000);
    if (!target && !text) return res.status(400).json({ error: "Укажите, на что жалуетесь, или опишите проблему" });
    const ipk = crypto.createHmac("sha256", CFG.sessionSecret).update(ipOf(req) || "?").digest("hex").slice(0, 16);
    const r = reportRate.get(ipk) || { n: 0, t: Date.now() };
    if (Date.now() - r.t > 3600e3) { r.n = 0; r.t = Date.now(); }
    if (++r.n > 10) return res.status(429).json({ error: "Слишком много жалоб с этого интернета — попробуйте через час или напишите на почту" });
    reportRate.set(ipk, r);
    const u = sessionUser(req);
    const rep = { id: id("r"), type, target, reason, text, contact: String(b.contact || "").slice(0, 200),
      by: u ? u.login : null, ip: ipk, status: "new", t: Date.now() };
    db.reports[rep.id] = rep;
    await save(true);
    res.json({ ok: true, id: rep.id });
  });
  app.get("/api/mod/reports", async (req, res) => {
    if (!admin(req, res)) return;
    const { videos } = await getVideos();
    const vids = new Map(videos.map((v) => [v.id, v]));
    const comments = new Map(videos.flatMap((v) => (v.comments || []).map((c) => [c.id, { ...c, video: v.id }])));
    const list = Object.values(db.reports).sort((a, b) => (a.status === "new" ? -1 : 1) - (b.status === "new" ? -1 : 1) || b.t - a.t).slice(0, 500)
      .map((r) => ({ ...r, ip: undefined, reasonLabel: REASONS[r.reason],
        video: r.type === "video" ? vids.get(r.target) && { id: r.target, title: vids.get(r.target).title, owner: vids.get(r.target).owner, hidden: isHidden(vids.get(r.target)) } : null,
        comment: r.type === "comment" ? comments.get(r.target) && { ...comments.get(r.target), hidden: isCommentHidden(r.target) } : null }));
    res.json({ reports: list, banned: Object.entries(db.bannedAuthors || {}).map(([login, b]) => ({ login, ...b })),
      hiddenComments: Object.entries(db.hiddenComments || {}).map(([cid, h]) => ({ id: cid, ...h })), reasons: REASONS });
  });
  app.get("/api/mod/comments", async (req, res) => {
    if (!admin(req, res)) return;
    const { videos } = await getVideos();
    const all = videos.flatMap((v) => (v.comments || []).map((c) => ({ ...c, video: v.id, videoTitle: v.title, hidden: isCommentHidden(c.id), banned: isBanned(c.by) })))
      .sort((a, b) => new Date(b.created) - new Date(a.created)).slice(0, 500);
    res.json({ comments: all });
  });
  app.post("/api/mod/action", async (req, res) => {
    const me = admin(req, res); if (!me) return;
    const { action, target, reportId, note } = await readBody(req);
    const t = String(target || "").trim();
    const stamp = { t: Date.now(), by: me.login, note: String(note || "").slice(0, 300) };
    switch (action) {
      case "hideVideo": db.hidden[t] = { ...stamp, reason: stamp.note || "модерация" }; break;
      case "unhideVideo": delete db.hidden[t]; break;
      case "hideComment": db.hiddenComments[t] = stamp; break;
      case "unhideComment": delete db.hiddenComments[t]; break;
      case "ban": {
        const login = t.toLowerCase();
        if (!login || login === CFG.admin) return res.status(400).json({ error: "Нельзя заблокировать этого пользователя" });
        db.bannedAuthors[login] = stamp;
        for (const u of Object.values(db.users)) if (u.login?.toLowerCase() === login) u.banned = true; // и в буксе тоже
        break;
      }
      case "unban": {
        const login = t.toLowerCase();
        delete db.bannedAuthors[login];
        for (const u of Object.values(db.users)) if (u.login?.toLowerCase() === login) u.banned = false;
        break;
      }
      case "approve": db.approved[t] = stamp; delete db.rejected[t]; break;
      case "reject": db.rejected[t] = { ...stamp, reason: stamp.note || "не прошло модерацию" }; delete db.approved[t]; break;
      case "trust": db.trusted[t.toLowerCase()] = stamp; break;
      case "untrust": delete db.trusted[t.toLowerCase()]; break;
      case "dismiss": case "resolve": break;
      default: return res.status(400).json({ error: "Неизвестное действие" });
    }
    if (reportId && db.reports[reportId]) { db.reports[reportId].status = action === "dismiss" ? "dismissed" : "resolved"; db.reports[reportId].done = stamp; }
    await save(true);
    res.json({ ok: true });
  });

  // ═══════════════ ПРЕМОДЕРАЦИЯ: очередь новых видео ═══════════════
  app.get("/api/mod/pending", async (req, res) => {
    if (!admin(req, res)) return;
    const { videos } = await getVideos();
    const pick = (v) => ({ id: v.id, title: v.title, owner: v.owner, avatar: v.avatar, src: v.src, kind: v.kind, sale: v.sale,
      duration: v.duration, created: v.created || v.updated, repoUrl: v.repoUrl, descChunks: v.descChunks });
    res.json({
      enabled: CFG.premod,
      pending: videos.filter((v) => isPending(v) && !isBanned(v.owner)).map(pick).sort((a, b) => new Date(a.created) - new Date(b.created)),
      rejected: videos.filter((v) => isRejected(v)).map((v) => ({ ...pick(v), ...db.rejected[v.id] })),
      trusted: Object.entries(db.trusted || {}).map(([login, x]) => ({ login, ...x })),
    });
  });
}
