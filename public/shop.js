// Магазин на странице видео: платное видео (почасово / навсегда), приложения (покупка / подписка), обои.
const RUB = (k) => (k / 100).toFixed(2).replace(".", ",").replace(",00", "") + " ₽";
const PER = { hour: "час", day: "день", month: "месяц", year: "год" };
const postJ = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

async function shopInit(v) {
  const box = document.getElementById("shop");
  if (!box) return;
  const hasFree = v.files && v.files.length;
  if (!v.sale && !hasFree) { box.remove(); return; }
  const vid = document.getElementById("vid");
  let a = await api("/api/shop/access?id=" + encodeURIComponent(v.id));
  let spent = 0, timer = null, fullMode = false;
  const back = encodeURIComponent(location.pathname + location.search);
  const kindName = { video: "Видео", app: "📦 Приложение", wallpaper: "🖼 Анимированные обои" }[v.kind];

  const fileLinks = (list, paid) => list.map((f) => `<a class="btn shop-dl" href="${paid ? `/paid/file?id=${encodeURIComponent(v.id)}&f=${f.i}` : esc(f.url)}" ${paid ? "" : 'download target="_blank" rel="noopener"'}>⬇ Скачать ${esc(f.name)} <small>${(f.size / 1048576).toFixed(1)} МБ</small></a>`).join("");

  function playFull(i = 0) { // полное платное видео из приватного репозитория
    fullMode = true;
    document.querySelector(".parts")?.remove();
    const n = v.paidParts.length;
    vid.src = `/paid/part?id=${encodeURIComponent(v.id)}&n=${i + 1}`;
    vid.play().catch(() => {});
    vid.onended = () => { if (i + 1 < n) playFull(i + 1); };
    const dl = document.getElementById("dl");
    if (dl) dl.style.display = "none";
  }
  async function tick() {
    const r = await postJ("/api/shop/tick", { id: v.id });
    if (!r.ok) { vid.pause(); stopHourly(r.error || "Не удалось списать оплату"); return false; }
    spent += r.charged || 0;
    if (typeof r.funds === "number") a.funds = r.funds;
    const st = document.getElementById("hourly");
    if (st) st.innerHTML = `⏱ Идёт почасовой просмотр · списано ${RUB(spent)} · на балансе ${RUB(a.funds)}`;
    return true;
  }
  function stopHourly(msg) {
    clearInterval(timer); timer = null;
    const st = document.getElementById("hourly");
    if (st) st.innerHTML = `⛔ ${esc(msg)} <a href="/bux?tab=wallet">Пополнить баланс</a>`;
  }
  async function startHourly() {
    if (!(await tick())) return;
    playFull(0);
    timer = setInterval(() => { if (!vid.paused) tick(); }, 30000);
    vid.addEventListener("play", () => { if (timer) tick(); });
    render();
  }
  async function buy(plan) {
    const r = await postJ("/api/shop/buy", { id: v.id, plan });
    if (!r.ok) { document.getElementById("shopMsg").innerHTML = `❌ ${esc(r.error)} ${r.status === 402 ? '<a href="/bux?tab=wallet">Пополнить</a>' : ""}`; return; }
    a = await api("/api/shop/access?id=" + encodeURIComponent(v.id));
    if (v.kind === "video") playFull(0);
    document.querySelector(".wm")?.remove();
    render();
    if (isWall && v.paidFiles[0]) location.href = `/paid/file?id=${encodeURIComponent(v.id)}&f=0`; // сразу скачиваем купленное
  }

  const wallInfo = () => `<details class="wall-howto"><summary>🖥 Как поставить живые обои на рабочий стол</summary>
    <ol><li><b>Windows:</b> установите бесплатную программу <b>Lively Wallpaper</b> (Microsoft Store) → «Добавить обои» → выберите скачанный файл.</li>
    <li><b>Android:</b> любое приложение «видеообои» из Google Play → выберите файл → «Установить на главный экран».</li>
    <li>Файл можно также открыть в любом плеере с повтором.</li></ol></details>`;
  const isWall = v.kind === "wallpaper";

  function render() {
    const s = v.sale || {};
    let html = `<div class="shop-head"><b>${kindName}</b>${v.sale ? ` <span class="shop-tag">💰 ${isWall ? "В ПРОДАЖЕ" : "платно"}</span>` : ` <span class="shop-tag free">бесплатно</span>`}</div>`;
    if (isWall && v.sale && !a.owned) {
      const f = v.paidFiles[0];
      html += `<div class="wall-sale"><div class="wall-price">${RUB(s.buy)}</div><div>
        <b>Анимированные обои для рабочего стола и телефона</b><br>
        <span class="muted">Сейчас показано короткое превью в низком качестве.${f ? ` После покупки — оригинальный файл <b>${esc(f.name)}</b> (${(f.size / 1048576).toFixed(1)} МБ), навсегда.` : ""}</span></div></div>`;
    }
    if (!v.sale) {
      html += `<div class="shop-row">${fileLinks(v.files, false)}</div>`;
    } else if (!a.loggedIn) {
      html += `${isWall ? "" : `<p>${priceList(s)}</p>`}<a class="btn" href="/auth/login?back=${back}">Войти через GitHub, чтобы купить</a>`;
    } else if (a.owned) {
      const until = a.until ? `доступ до <b>${new Date(a.until).toLocaleString("ru")}</b>` : (a.owner ? "это ваш товар" : "куплено навсегда");
      html += `<p>✅ ${until}</p>`;
      if (v.kind === "video") html += `<p class="muted">Видео играет полностью.</p>`;
      else if (isWall && !a.owner) html += `<p class="muted">Спасибо за покупку! Скачивайте сколько угодно раз.</p>`;
      else html += `<div class="shop-row">${fileLinks(v.paidFiles, true)}</div>`;
      if (s.sub && a.until) html += `<p class="muted">Продлить:</p><div class="shop-row">${subButtons(s)}</div>`;
    } else {
      if (v.kind === "video") html += `<p class="muted">Сейчас идёт бесплатный трейлер. Полное видео — ${fmtDur(v.paidParts.reduce((x, p) => x + p.duration, 0))}.</p>`;
      html += `<div class="shop-row">`;
      if (s.per_hour) html += timer ? "" : `<button class="btn" data-hourly>▶ Смотреть полностью · ${RUB(s.per_hour)}/час<small>${RUB(Math.max(1, Math.round(s.per_hour / 60)))} в минуту, только пока видео играет</small></button>`;
      if (s.buy) html += `<button class="btn ${s.per_hour ? "ghost" : ""} ${isWall ? "big" : ""}" data-buy="buy">${isWall ? "🛒 Купить и скачать обои" : "Купить навсегда"} · ${RUB(s.buy)}</button>`;
      html += subButtons(s) + `</div>`;
      html += `<p id="hourly" class="muted">На балансе ${RUB(a.funds)} · <a href="/bux?tab=wallet">пополнить</a></p>`;
    }
    if (isWall) html += wallInfo();
    html += `<p class="muted" id="shopMsg"></p>`;
    box.innerHTML = html;
    box.querySelectorAll("[data-buy]").forEach((b) => (b.onclick = () => buy(b.dataset.buy)));
    box.querySelector("[data-hourly]")?.addEventListener("click", startHourly);
  }
  const subButtons = (s) => Object.entries(s.sub || {}).map(([p, k]) => `<button class="btn ghost" data-buy="${p}">Подписка на ${PER[p]} · ${RUB(k)}</button>`).join("");
  const priceList = (s) => [s.per_hour && `просмотр ${RUB(s.per_hour)}/час`, s.buy && `покупка ${RUB(s.buy)}`,
    ...Object.entries(s.sub || {}).map(([p, k]) => `подписка ${RUB(k)}/${PER[p]}`)].filter(Boolean).join(" · ");

  if (v.sale && a.owned && v.kind === "video") playFull(0);
  if (isWall) {
    vid.loop = true; vid.muted = true; vid.play().catch(() => {});
    vid.classList.add("wall-frame");
    if (v.sale && !a.owned && !document.querySelector(".wm")) {
      const wrap = document.createElement("div"); wrap.className = "vwrap";
      vid.parentNode.insertBefore(wrap, vid); wrap.appendChild(vid);
      wrap.insertAdjacentHTML("beforeend", `<div class="wm"><span>ПРЕВЬЮ · ${RUB(v.sale.buy)}</span></div>`);
    }
  }
  render();
}
