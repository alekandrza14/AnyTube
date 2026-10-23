const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = (u) => fetch(u).then((r) => r.json());
const ago = (d) => {
  const s = (Date.now() - new Date(d)) / 1000;
  for (const [n, w] of [[31536000, "г."], [2592000, "мес."], [86400, "дн."], [3600, "ч."], [60, "мин."]]) if (s >= n) return `${Math.floor(s / n)} ${w} назад`;
  return "только что";
};
const fmtDur = (s) => {
  s = Math.floor(Number(s) || 0);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  const pad = (x) => String(x).padStart(2, "0");
  return (d ? `${d} дн. ` : "") + (h || d ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`);
};
const card = (v) => `
  <a class="card" href="/watch?v=${encodeURIComponent(v.id)}">
    <div class="thumb"><video src="${esc(v.src)}#t=1" preload="metadata" muted></video><div class="play">▶</div>${v.duration ? `<span class="dur">${fmtDur(v.duration)}</span>` : ""}${v.partCount > 1 ? `<span class="pc">${v.partCount} ч.</span>` : ""}</div>
    <div class="meta"><img src="${esc(v.avatar)}&s=72" alt="" loading="lazy">
      <div><h3>${esc(v.title)}</h3><p>${esc(v.owner)} · ${esc(v.repoTitle)}</p><p><span class="stars">★ ${v.stars}</span>${v.commentCount ? ` · 💬 ${v.commentCount}` : ""}${v.dislikeCount ? ` · 👎 ${v.dislikeCount}` : ""} · ${ago(v.updated)}</p></div>
    </div>
  </a>`;
