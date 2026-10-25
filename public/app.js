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
const badge = (v) => {
  const k = { app: "📦 Приложение", wallpaper: "🖼 Обои", game: "🎮 Игра", model: "🧊 3D-модель" }[v.kind] || "";
  const s = v.sale, R = (x) => (x / 100).toFixed(2).replace(".", ",").replace(",00", "") + " ₽";
  const price = s ? (s.per_hour ? `${R(s.per_hour)}/час` : s.buy ? R(s.buy) : s.sub ? "подписка" : "") : (v.kind !== "video" ? "бесплатно" : "");
  if (v.kind === "wallpaper") return s
    ? `<span class="ribbon">🖼 ОБОИ В ПРОДАЖЕ</span><span class="pricetag">${price}</span>`
    : `<span class="ribbon free">🖼 ОБОИ</span><span class="pricetag free">БЕСПЛАТНО</span>`;
  return k || price ? `<span class="kb">${[k, price && (s ? "💰 " + price : price)].filter(Boolean).join(" · ")}</span>` : "";
};
// процент, который автор получает с продаж (рядом с аватаркой): кто для кого батя
const shareChip = (pct, tier, diff) => pct == null ? "" : `<span class="share-chip ${pct > 100 ? "legend" : pct >= 90 ? "vip" : pct > 63 ? "plus" : ""}" title="Автор получает ${pct}% от денег покупателей${tier ? " · " + tier : ""}${diff ? ` (${diff > 0 ? "+" : ""}${diff}% к обычной ставке)` : ""}">${pct > 100 ? "👑 " : pct >= 90 ? "✅ " : ""}${pct}%</span>`;
const card = (v) => `
  <a class="card" href="/watch?v=${encodeURIComponent(v.id)}">
    <div class="thumb"><video src="${esc(v.src)}#t=1" preload="metadata" muted></video><div class="play">▶</div>${v.duration ? `<span class="dur">${fmtDur(v.duration)}</span>` : ""}${v.partCount > 1 ? `<span class="pc">${v.partCount} ч.</span>` : ""}${badge(v)}</div>
    <div class="meta"><img src="${esc(v.avatar)}&s=72" alt="" loading="lazy">
      <div><h3>${esc(v.title)}</h3><p>${esc(v.owner)}${shareChip(v.share)} · ${esc(v.repoTitle)}</p><p><span class="likes">+${v.likes || 0}</span>${v.commentCount ? ` · 💬 ${v.commentCount}` : ""}${v.dislikeCount ? ` · 👎 ${v.dislikeCount}` : ""} · ${ago(v.updated)}</p></div>
    </div>
  </a>`;

// ── подвал: правила, жалобы, контакты администрации ──
(function footer() {
  if (document.querySelector(".site-foot")) return;
  const f = document.createElement("footer");
  f.className = "site-foot";
  f.innerHTML = `<a href="/report">⚠ Сообщить о нарушении</a> · <a href="/report#rules">Правила</a> · <span id="footContacts"></span>`;
  document.body.appendChild(f);
  fetch("/api/contacts").then((r) => r.json()).then((c) => {
    document.getElementById("footContacts").innerHTML =
      `<a href="mailto:${esc(c.email)}">✉ ${esc(c.email)}</a>` + (c.phone ? ` · <a href="tel:${esc(c.phone.replace(/[^+\d]/g, ""))}">📞 ${esc(c.phone)}</a>` : "");
  }).catch(() => {});
})();

// Видео грузятся прямо с GitHub (мимо сервера — экономим трафик Render).
// Если браузер не смог сыграть прямую ссылку (редкие браузеры, сбой GitHub), один раз переключаемся на сервер AnyTube.
const viaServer = (url) => {
  const m = String(url).match(/^https:\/\/(?:raw\.githubusercontent\.com|media\.githubusercontent\.com\/media)\/([^/]+)\/([^/]+)\/[^/]+\/(.+?)(?:[?#].*)?$/);
  return m ? `/video/${m[1]}/${m[2]}/${m[3]}` : null;
};
document.addEventListener("error", (e) => {
  const el = e.target;
  if (!el || el.tagName !== "VIDEO" || el.dataset.viaServer) return;
  const alt = viaServer(el.currentSrc || el.src);
  if (!alt) return;
  el.dataset.viaServer = "1";
  const t = el.currentTime || 0, play = !el.paused || el.autoplay;
  el.src = alt + (String(el.src).includes("#t=") ? "#t=1" : "");
  if (t) el.addEventListener("loadedmetadata", () => { el.currentTime = t; }, { once: true });
  if (play) el.play().catch(() => {});
}, true);
