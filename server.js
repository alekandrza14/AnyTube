import express from "express";
import { Readable } from "node:stream";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.GITHUB_TOKEN || "";      // очень желателен: без него лимит 60 запросов/час
const PREFIX = "anytubevideo_";                     // префикс имени репозитория
const TOPIC = "anytubevideo";                       // альтернативный способ: topic репозитория
const CACHE_MS = Number(process.env.CACHE_MINUTES || 10) * 60 * 1000;
const MAX_PAGES = Number(process.env.MAX_SEARCH_PAGES || 5); // 5 страниц × 100 = до 500 репо
const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|m4v)$/i;
const MIME = { mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime", webm: "video/webm", ogg: "video/ogg", ogv: "video/ogg" };

const gh = (url) =>
  fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "anytube",
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });

let cache = { at: 0, videos: [], error: null };
let refreshing = null;

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

async function repoVideos(repo) {
  const branch = repo.default_branch;
  const r = await gh(`https://api.github.com/repos/${repo.full_name}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  if (!r.ok) return [];
  const tree = await r.json();
  return (tree.tree || [])
    .filter((f) => f.type === "blob" && VIDEO_EXT.test(f.path))
    .map((f) => ({
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
      src: `/video/${repo.full_name}/${f.path.split("/").map(encodeURIComponent).join("/")}`,
    }));
}

async function refresh() {
  const [byName, byTopic] = await Promise.all([
    searchRepos(`${PREFIX} in:name fork:false`),
    searchRepos(`topic:${TOPIC} fork:false`).catch(() => []),
  ]);
  const map = new Map();
  for (const repo of [...byName, ...byTopic]) {
    const okName = repo.name.toLowerCase().startsWith(PREFIX);
    const okTopic = (repo.topics || []).includes(TOPIC);
    if ((okName || okTopic) && !repo.private) map.set(repo.full_name, repo);
  }
  const lists = [];
  const repos = [...map.values()];
  // по 8 репозиториев параллельно, чтобы не упираться в лимиты
  for (let i = 0; i < repos.length; i += 8) {
    lists.push(...(await Promise.all(repos.slice(i, i + 8).map((r) => repoVideos(r).catch(() => [])))));
  }
  const videos = lists.flat().sort((a, b) => new Date(b.updated) - new Date(a.updated));
  cache = { at: Date.now(), videos, error: null };
  console.log(`[anytube] обновлено: ${repos.length} репо, ${videos.length} видео`);
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
  let list = videos;
  if (author) list = list.filter((v) => v.owner.toLowerCase() === author);
  if (q) list = list.filter((v) => `${v.title} ${v.repoTitle} ${v.owner} ${v.path}`.toLowerCase().includes(q));
  res.json({ updated: at, error, count: list.length, videos: list });
});

app.get("/api/video", async (req, res) => {
  const { videos } = await getVideos();
  const v = videos.find((x) => x.id === req.query.id);
  v ? res.json(v) : res.status(404).json({ error: "Видео не найдено" });
});

// Прокси видеопотока: правильный Content-Type, поддержка перемотки (Range) и скачивания
app.get(/^\/video\/([^/]+)\/([^/]+)\/(.+)$/, async (req, res) => {
  const [owner, repo, filePath] = [req.params[0], req.params[1], req.params[2]];
  if (!repo.toLowerCase().startsWith(PREFIX) && !cache.videos.some((v) => v.owner === owner && v.repo === repo)) {
    return res.status(403).send("Репозиторий не участвует в AnyTube");
  }
  const known = cache.videos.find((v) => v.owner === owner && v.repo === repo && v.path === decodeURIComponent(filePath));
  const branch = known?.branch || "HEAD";
  const base = known?.lfs ? "https://media.githubusercontent.com/media" : "https://raw.githubusercontent.com";
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
