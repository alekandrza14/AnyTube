// AnyTube Букс: рекламодатели платят за просмотры своих видео, зрители смотрят и зарабатывают.
// Деньги — в копейках (целые числа). Данные — db.json в приватном репозитории GitHub (или локальный файл).
import crypto from "node:crypto";
import fs from "node:fs";
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
};
if (!env("SESSION_SECRET")) console.warn("[bux] SESSION_SECRET не задан — после перезапуска всем придётся войти заново");

// Тарифы: секунды просмотра → цена одного просмотра для рекламодателя (коп.)
export const TARIFFS = { 15: 10, 30: 18, 45: 25, 60: 30, 90: 40, 120: 50 };
const reward = (price) => Math.floor(price * (1 - CFG.commission));
const DAY = 24 * 3600 * 1000;
const rub = (k) => (k / 100).toFixed(2);

// ─────────────── хранилище ───────────────
const EMPTY = () => ({ v: 1, seq: 1, users: {}, campaigns: {}, views: {}, ipViews: {}, withdrawals: {}, topups: {}, ops: [] });
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
    const list = Object.values(db.campaigns)
      .filter((c) => c.status === "active" && c.left >= c.price && c.uid !== u.uid && byId.has(c.video)
        && !(now - (db.views[`${u.uid}:${c.id}`] || 0) < DAY))
      .sort((a, b) => b.price - a.price)
      .map((c) => { const v = byId.get(c.video); return { id: c.id, seconds: c.seconds, reward: c.reward, title: v.title, owner: v.owner, avatar: v.avatar }; });
    res.json({ tasks: list, canEarn: canEarn(u) });
  });

  app.post("/api/bux/start", async (req, res) => {
    const u = auth(req, res); if (!u) return;
    if (!canEarn(u)) return res.status(403).json({ error: `Зарабатывать можно с GitHub-аккаунта старше ${CFG.minAccountDays} дней` });
    const { cid } = await readBody(req);
    const c = db.campaigns[cid];
    if (!c || c.status !== "active" || c.left < c.price) return res.status(404).json({ error: "Эта реклама уже закончилась" });
    if (c.uid === u.uid) return res.status(400).json({ error: "Свою рекламу смотреть за деньги нельзя" });
    if (Date.now() - (db.views[`${u.uid}:${cid}`] || 0) < DAY) return res.status(429).json({ error: "Это видео вы уже смотрели сегодня" });
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
    op(u.uid, "view", r, `просмотр ${c.id}`);
    save();
    res.json({ ok: true, reward: r, earn: u.earn });
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
}
