import express from "express";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 3000;
// очень желателен: без него лимит 60 запросов/час. Лишние пробелы и "Bearer " срезаются.
const TOKEN = (process.env.GITHUB_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
const PREFIX = "anytubevideo_";                     // префикс имени репозитория
const TOPIC = "anytubevideo";                       // альтернативный способ: topic репозитория
const CACHE_MS = Number(process.env.CACHE_MINUTES || 10) * 60 * 1000;
const MAX_PAGES = Number(process.env.MAX_SEARCH_PAGES || 10); // 10 страниц × 100 = до 1000 репо (максимум поиска GitHub)
const YEAR_SECONDS = 365 * 24 * 3600;              // видео длиннее 1 года не показываем
const DESC_LIMIT = 1_000_000_000;                   // описание — до 1 000 000 000 символов
const DESC_SLICE = 256 * 1024;                      // описание отдаётся порциями по 256 КБ
const RAW = "https://raw.githubusercontent.com";
const LFS_RAW = "https://media.githubusercontent.com/media";
const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v)$/i;
const MIME = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogg: "video/ogg", ogv: "video/ogg" };

let tokenBad = false;
const gh = async (url) => {
  const headers = { Accept: "application/vnd.github+json", "User-Agent": "anytube" };
  if (TOKEN && !tokenBad) {
    const r = await fetch(url, { headers: { ...headers, Authorization: `Bearer ${TOKEN}` } });
    if (r.status !== 401) return r;
    tokenBad = true; // токен отклонён — дальше работаем без него, чтобы сайт не падал
    console.error("[anytube] GITHUB_TOKEN отклонён GitHub (401). Работаю без токена — пересоздайте токен.");
  }
  return fetch(url, { headers });
};

// Топ: больше звёзд — выше; при равенстве звёзд — свежее выше
const byStars = (a, b) => b.stars - a.stars || new Date(b.updated) - new Date(a.updated);
const byNew = (a, b) => new Date(b.updated) - new Date(a.updated);

let cache = { at: 0, videos: [], files: new Map(), error: null };
let refreshing = null;
const fileKey = (owner, repo, p) => `${owner}/${repo}/${p}`.toLowerCase();
const videoSrc = (owner, repo, p) => `/video/${owner}/${repo}/${p.split("/").map(encodeURIComponent).join("/")}`;

async function searchRepos(q) {
  const repos = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await gh(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=updated&per_page=100&page=${page}`);
    if (!r.ok) throw new Error(`GitHub search ${r.status}: ${await r.text()}`);
    const data = await r.json();
    repos.push(...data.items);
    if (data.items.length < 100) break;
  }
  return repos;
}

// Видео из anytube.json: пронумерованные части (в одном или нескольких репозиториях-томах) + описание кусками
async function manifestVideo(repo, branch, files) {
  // null — манифест не прочитался (покажем файлы как обычно); [] — манифест нарушает правила (не показываем)
  const r = await fetch(`${RAW}/${repo.full_name}/${encodeURIComponent(branch)}/anytube.json`).catch(() => null);
  if (!r || !r.ok) return null;
  const m = await r.json().catch(() => null);
  if (!m || typeof m !== "object") return null;
  const owner = repo.owner.login;
  const okRepo = (name) => typeof name === "string" && name.toLowerCase().startsWith(PREFIX) && /^[A-Za-z0-9._-]+$/.test(name);
  const okPath = (p) => typeof p === "string" && p && !p.includes("..") && !p.startsWith("/");
  const parts = (m.parts || []).filter((p) => okRepo(p.repo) && okPath(p.path) && VIDEO_EXT.test(p.path));
  if (!parts.length) return [];
  const duration = Number(m.duration) || parts.reduce((s, p) => s + (Number(p.duration) || 0), 0);
  if (duration > YEAR_SECONDS) return []; // правило AnyTube: не длиннее 1 года
  const chunks = ((m.description || {}).chunks || []).filter((c) => okRepo(c.repo) && okPath(c.path));
  const descChars = Math.min(Number((m.description || {}).chars) || 0, DESC_LIMIT);
  for (const p of parts) files.set(fileKey(owner, p.repo, p.path), { branch: "main", lfs: !!p.lfs });
  for (const c of chunks) files.set(fileKey(owner, c.repo, c.path), { branch: "main", lfs: false });
  files.set(fileKey(owner, repo.name, parts[0].path), { branch, lfs: !!parts[0].lfs }); // первый том — ветка по умолчанию
  const virtual = okPath(m.file) ? m.file : parts[0].path.replace(/\.part\d+(\.\w+)$/i, "$1");
  return [{
    id: `${repo.full_name}/${virtual}`,
    owner, avatar: repo.owner.avatar_url, repo: repo.name, branch, path: virtual,
    size: parts.reduce((s, p) => s + (Number(p.size) || 0), 0),
    duration,
    title: String(m.title || repo.description || virtual).slice(0, 300),
    repoTitle: repo.name.slice(PREFIX.length).replace(/[_-]+/g, " ") || repo.name,
    stars: repo.stargazers_count, updated: repo.pushed_at, repoUrl: repo.html_url,
    src: videoSrc(owner, parts[0].repo === repo.name ? repo.name : parts[0].repo, parts[0].path),
    parts: parts.map((p, i) => ({ n: i + 1, duration: Number(p.duration) || 0, size: Number(p.size) || 0,
      src: videoSrc(owner, p.repo, p.path), file: p.path })),
    descChars, descChunks: chunks.length,
    _desc: chunks.map((c) => ({ repo: c.repo, path: c.path, size: Number(c.size) || 0 })),
  }];
}

async function repoVideos(repo, files) {
  const branch = repo.default_branch;
  const r = await gh(`https://api.github.com/repos/${repo.full_name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!r.ok) return [];
  const tree = await r.json();
  const names = new Set((tree.tree || []).map((f) => f.path));
  if (names.has("anytube-volume.json")) return [];          // том большого видео — показывается через главный репо
  if (names.has("anytube.json")) {
    const v = await manifestVideo(repo, branch, files).catch(() => null);
    if (v) return v; // в т.ч. [] — видео длиннее 1 года и т.п. не показываем вовсе
  }
  // Описание обычного репозитория: description.txt / description.part0001.txt… (или README.md, если их нет)
  const blobs = (tree.tree || []).filter((f) => f.type === "blob");
  const num = (p) => Number((p.match(/part(\d+)/i) || [0, 0])[1]);
  let descFiles = blobs.filter((f) => /^description(\.part\d+)?\.(txt|md)$/i.test(f.path)).sort((a, b) => num(a.path) - num(b.path));
  if (!descFiles.length) descFiles = blobs.filter((f) => /^readme\.(md|txt)$/i.test(f.path)).slice(0, 1);
  const desc = descFiles.map((f) => ({ repo: repo.name, branch, path: f.path, size: f.size }));
  const descBytes = desc.reduce((s, d) => s + d.size, 0);
  return blobs
    .filter((f) => VIDEO_EXT.test(f.path))
    .map((f) => ({
      descChunks: desc.length, descChars: 0, descBytes, _desc: desc,
      id: `${repo.full_name}/${f.path}`,
      owner: repo.owner.login,
      avatar: repo.owner.avatar_url,
      repo: repo.name,
      branch,
      path: f.path,
      // маленький blob = указатель Git LFS, само видео лежит в LFS
      lfs: f.size < 300,
      size: f.size,
      title: (repo.description && repo.description.trim()) ||
        path.basename(f.path).replace(VIDEO_EXT, "").replace(/[_-]+/g, " "),
      repoTitle: repo.name.slice(PREFIX.length).replace(/[_-]+/g, " ") || repo.name,
      stars: repo.stargazers_count,
      updated: repo.pushed_at,
      repoUrl: repo.html_url,
      src: videoSrc(repo.owner.login, repo.name, f.path),
    }))
    .map((v) => (files.set(fileKey(v.owner, v.repo, v.path), { branch, lfs: v.lfs }), v));
}

// Комментарий = репозиторий комментатора: anytubecomment_<автор видео>_<файл видео>_Comment.<N>
// (ник GitHub не содержит "_", поэтому первый "_" отделяет автора)
const CPREFIX = "anytubecomment_";
const safePart = (s) => s.replace(/[^A-Za-z0-9._-]/g, "-").toLowerCase();
function parseComment(repo) {
  if (!repo.name.toLowerCase().startsWith(CPREFIX) || repo.private) return null;
  const m = repo.name.slice(CPREFIX.length).match(/^([A-Za-z0-9-]+)_(.+)_(?:Comment|Commet|Coment)\.(\d+)$/i);
  if (!m) return null;
  return {
    id: repo.full_name, author: m[1].toLowerCase(), file: m[2].toLowerCase(), num: Number(m[3]),
    by: repo.owner.login, avatar: repo.owner.avatar_url, text: (repo.description || "").trim(),
    url: repo.html_url, created: repo.created_at,
  };
}
// Дизлайк = anytubecomment_<автор>_<файл>_Commet.<уровень 1–5>.diske (одному видео — один голос от человека)
const DISLIKE_LABELS = ["Ну не очень", "Так себе", "Плохо", "Очень плохо, зря потратил время", "Это убогий видос, мой день испорчен"];
function parseDislike(repo) {
  if (!repo.name.toLowerCase().startsWith(CPREFIX) || repo.private) return null;
  const m = repo.name.slice(CPREFIX.length).match(/^([A-Za-z0-9-]+)_(.+)_(?:Comment|Commet|Coment)\.([1-5])\.(?:diske|dislike|dizlike)$/i);
  if (!m) return null;
  return { author: m[1].toLowerCase(), file: m[2].toLowerCase(), level: Number(m[3]),
    by: repo.owner.login.toLowerCase(), created: repo.created_at };
}
function dislikesFor(v, dislikes) {
  const base = safePart(path.basename(v.path));
  const perUser = new Map();
  for (const d of dislikes) {
    if (d.author !== v.owner.toLowerCase() || d.by === d.author) continue; // себе дизлайк не считается
    if (!(d.file === base || (d.file.length >= 20 && base.startsWith(d.file)))) continue;
    const prev = perUser.get(d.by);
    if (!prev || new Date(d.created) > new Date(prev.created)) perUser.set(d.by, d); // один голос на человека
  }
  const levels = [0, 0, 0, 0, 0];
  for (const d of perUser.values()) levels[d.level - 1]++;
  const total = levels.reduce((a, b) => a + b, 0);
  const avg = total ? levels.reduce((s, n, i) => s + n * (i + 1), 0) / total : 0;
  return { total, levels, avg: Math.round(avg * 10) / 10 };
}
function commentsFor(v, comments) {
  const base = safePart(path.basename(v.path));
  return comments
    .filter((c) => c.author === v.owner.toLowerCase() &&
      (c.file === base || (c.file.length >= 20 && base.startsWith(c.file)))) // длинные имена обрезаются
    .sort((a, b) => new Date(a.created) - new Date(b.created));
}

async function refresh() {
  const [byName, byTopic, commentRepos] = await Promise.all([
    searchRepos(`${PREFIX} in:name fork:false`),
    searchRepos(`topic:${TOPIC} fork:false`).catch(() => []),
    searchRepos(`${CPREFIX} in:name fork:false`).catch(() => []),
  ]);
  const comments = commentRepos.map(parseComment).filter(Boolean);
  const dislikes = commentRepos.map(parseDislike).filter(Boolean);
  const map = new Map();
  for (const repo of [...byName, ...byTopic]) {
    const okName = repo.name.toLowerCase().startsWith(PREFIX);
    const okTopic = (repo.topics || []).includes(TOPIC);
    if ((okName || okTopic) && !repo.private) map.set(repo.full_name, repo);
  }
  const lists = [];
  const files = new Map();
  const repos = [...map.values()];
  // по 8 репозиториев параллельно, чтобы не упираться в лимиты
  for (let i = 0; i < repos.length; i += 8) {
    lists.push(...(await Promise.all(repos.slice(i, i + 8).map((r) => repoVideos(r, files).catch(() => [])))));
  }
  const videos = lists.flat().sort(byStars);
  for (const v of videos) { v.comments = commentsFor(v, comments); v.dislikes = dislikesFor(v, dislikes); }
  cache = { at: Date.now(), videos, files, error: null };
  console.log(`[anytube] обновлено: ${repos.length} репо, ${videos.length} видео, ${comments.length} комментариев`);
}

async function getVideos() {
  if (Date.now() - cache.at > CACHE_MS && !refreshing) {
    refreshing = refresh()
      .catch((e) => { cache.error = e.message; cache.at = Date.now() - CACHE_MS + 60_000; console.error(e); })
      .finally(() => (refreshing = null));
  }
  if (!cache.videos.length && refreshing) await refreshing;
  return cache;
}

app.get("/api/videos", async (req, res) => {
  const { videos, error, at } = await getVideos();
  const q = (req.query.q || "").toString().toLowerCase().trim();
  const author = (req.query.author || "").toString().toLowerCase();
  const sort = req.query.sort === "new" ? "new" : "top";
  let list = videos;
  if (author) list = list.filter((v) => v.owner.toLowerCase() === author);
  if (q) list = list.filter((v) => `${v.title} ${v.repoTitle} ${v.owner} ${v.path}`.toLowerCase().includes(q));
  list = [...list].sort(sort === "new" ? byNew : byStars)
    .map(({ comments, parts, _desc, dislikes, ...v }) => ({ ...v, partCount: parts ? parts.length : 1,
      commentCount: (comments || []).length, dislikeCount: dislikes ? dislikes.total : 0, dislikeAvg: dislikes ? dislikes.avg : 0 })); // в ленте только числа
  res.json({ updated: at, error: error || (tokenBad ? "GITHUB_TOKEN неверный, сайт работает без него (лимит 60 запросов/час)" : null), sort, count: list.length, videos: list });
});

app.get("/api/video", async (req, res) => {
  const { videos } = await getVideos();
  const v = videos.find((x) => x.id === req.query.id);
  if (!v) return res.status(404).json({ error: "Видео не найдено" });
  const { _desc, ...pub } = v;
  res.json({ ...pub, dislikeLabels: DISLIKE_LABELS });
});

// Описание порциями: ?id=<видео>&n=<номер куска, с 0>&offset=<байт>. Режем по границе символа UTF-8.
app.get("/api/desc", async (req, res) => {
  const { videos } = await getVideos();
  const v = videos.find((x) => x.id === req.query.id);
  if (!v || !v._desc || !v._desc.length) return res.status(404).json({ error: "Описания нет" });
  const n = Math.max(0, Number(req.query.n) || 0);
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const chunk = v._desc[n];
  if (!chunk) return res.status(404).json({ error: "Нет такой части описания" });
  const url = `${RAW}/${v.owner}/${chunk.repo}/${encodeURIComponent(chunk.branch || "main")}/${chunk.path.split("/").map(encodeURIComponent).join("/")}`;
  const up = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + DESC_SLICE - 1}` } });
  if (!up.ok) return res.status(502).json({ error: `GitHub ${up.status}` });
  // если GitHub проигнорировал Range (200), сами пропускаем offset и берём DESC_SLICE байт
  const reader = up.body.getReader();
  const bufs = [];
  let got = 0, skip = up.status === 200 ? offset : 0, done = false;
  while (got < DESC_SLICE) {
    const { value, done: d } = await reader.read();
    if (d) { done = true; break; }
    let b = Buffer.from(value);
    if (skip) { const s = Math.min(skip, b.length); b = b.subarray(s); skip -= s; }
    bufs.push(b); got += b.length;
  }
  reader.cancel().catch(() => {});
  let buf = Buffer.concat(bufs).subarray(0, DESC_SLICE);
  const total = chunk.size || Number((up.headers.get("content-range") || "").split("/")[1]) || 0;
  const end = offset + buf.length >= total || (done && got < DESC_SLICE);
  if (!end) { // не разрываем многобайтовый символ
    let i = buf.length - 1, back = 0;
    while (i >= 0 && back < 4 && (buf[i] & 0xc0) === 0x80) { i--; back++; }
    const lead = buf[i], need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (i >= 0 && i + need > buf.length) buf = buf.subarray(0, i);
  }
  const next = !end ? { n, offset: offset + buf.length } : n + 1 < v._desc.length ? { n: n + 1, offset: 0 } : null;
  res.json({ text: buf.toString("utf8"), next, chunk: n + 1, chunks: v._desc.length, chars: v.descChars });
});

// Прокси видеопотока: правильный Content-Type, поддержка перемотки (Range) и скачивания
app.get(/^\/video\/([^/]+)\/([^/]+)\/(.+)$/, async (req, res) => {
  const [owner, repo, filePath] = [req.params[0], req.params[1], req.params[2]];
  const known = cache.files.get(fileKey(owner, repo, decodeURIComponent(filePath)));
  if (!known && !repo.toLowerCase().startsWith(PREFIX)) {
    return res.status(403).send("Репозиторий не участвует в AnyTube");
  }
  if (!VIDEO_EXT.test(filePath)) return res.status(403).send("Это не видео");
  const branch = known?.branch || "HEAD";
  const base = known?.lfs ? LFS_RAW : RAW;
  const url = `${base}/${owner}/${repo}/${branch}/${filePath}`;

  const upstream = await fetch(url, { headers: req.headers.range ? { Range: req.headers.range } : {} });
  if (!upstream.ok && upstream.status !== 206) return res.status(upstream.status).send("Не удалось получить видео");

  const ext = filePath.split(".").pop().toLowerCase();
  res.status(upstream.status);
  res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "public, max-age=3600");
  for (const h of ["content-length", "content-range"]) {
    const val = upstream.headers.get(h);
    if (val) res.setHeader(h, val);
  }
  if (req.query.download) {
    res.setHeader("Content-Disposition", `attachment; filename="${decodeURIComponent(filePath.split("/").pop())}"`);
  }
  Readable.fromWeb(upstream.body).pipe(res);
  req.on("close", () => upstream.body?.cancel?.().catch(() => {}));
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("/healthz", (_, res) => res.send("ok"));

app.listen(PORT, () => {
  console.log(`AnyTube слушает порт ${PORT}${TOKEN ? "" : " (без GITHUB_TOKEN — лимиты GitHub очень маленькие!)"}`);
  getVideos();
});
