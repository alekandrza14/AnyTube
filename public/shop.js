// Магазин на странице видео: платное видео (почасово / навсегда), приложения (покупка / подписка), обои.
const RUB = (k) => (k / 100).toFixed(2).replace(".", ",").replace(",00", "") + " ₽";
const PER = { hour: "час", day: "день", month: "месяц", year: "год" };
const postJ = (u, b) => fetch(u, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).then(async (r) => ({ status: r.status, ...(await r.json().catch(() => ({}))) }));

async function shopInit(v) {
  const box = document.getElementById("shop");
  if (!box) return;
  const hasFree = v.files && v.files.length;
  if (!v.sale && !hasFree && !v.game) { box.remove(); return; }
  const vid = document.getElementById("vid");
  let a = await api("/api/shop/access?id=" + encodeURIComponent(v.id));
  let spent = 0, timer = null, fullMode = false;
  const back = encodeURIComponent(location.pathname + location.search);
  const kindName = { video: "Видео", app: "📦 Приложение", wallpaper: "🖼 Анимированные обои", game: "🎮 WebGL-игра", model: "🧊 3D-модель" }[v.kind];
  const isGame = v.kind === "game", isModel = v.kind === "model";

  const kitLink = () => `<a class="btn shop-dl big" href="/wallpaper/kit?id=${encodeURIComponent(v.id)}">⬇ Скачать обои с установщиком <small>Windows 10/11 · архив с install.cmd</small></a>`;
  const fileLinks = (list, paid) => (isWall ? kitLink() + `<span class="muted" style="align-self:center">или <a href="${paid ? `/paid/file?id=${encodeURIComponent(v.id)}&f=0` : esc(list[0]?.url || "#")}" ${paid ? "" : "download"}>только видео</a></span>` : "") + (isWall ? "" : list.map((f) => `<a class="btn shop-dl" href="${paid ? `/paid/file?id=${encodeURIComponent(v.id)}&f=${f.i}` : esc(f.url)}" ${paid ? "" : 'download target="_blank" rel="noopener"'}>⬇ Скачать ${esc(f.name)} <small>${(f.size / 1048576).toFixed(1)} МБ</small></a>`).join(""));

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
    if (isGame && plan === "buy") { render(); startGame(false); return; }
    render();
    if (isWall && v.paidFiles[0]) location.href = `/wallpaper/kit?id=${encodeURIComponent(v.id)}`; // сразу скачиваем купленное с установщиком
  }

  const wallInfo = () => `<details class="wall-howto"><summary>🖥 Как поставить живые обои на рабочий стол</summary>
    <ol><li><b>Windows 10/11:</b> скачайте «обои с установщиком», распакуйте архив («Извлечь все») и запустите <b>install.cmd</b>.
      Он сам поставит всё нужное, запустит обои под иконками рабочего стола и спросит про автозапуск. Остановить: <b>stop.cmd</b>.</li>
    <li><b>Android:</b> скачайте «только видео» и поставьте через любое приложение «видеообои» из Google Play.</li></ol></details>`;
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
    if (!v.sale && isGame) {
      html += game ? "" : `<div class="shop-row"><button class="btn big" data-play>▶ Играть бесплатно</button></div>`;
    } else if (!v.sale) {
      html += `<div class="shop-row">${fileLinks(v.files, false)}</div>`;
    } else if (!a.loggedIn) {
      html += `${isWall ? "" : `<p>${priceList(s)}</p>`}<a class="btn" href="/auth/login?back=${back}">Войти через GitHub, чтобы купить</a>`;
    } else if (a.owned) {
      const until = a.until ? `доступ до <b>${new Date(a.until).toLocaleString("ru")}</b>` : (a.owner ? "это ваш товар" : "куплено навсегда");
      html += `<p>✅ ${until}</p>`;
      if (v.kind === "video") html += `<p class="muted">Видео играет полностью.</p>`;
      else if (isGame) html += game ? "" : `<div class="shop-row"><button class="btn big" data-play>▶ Играть</button></div>`;
      else if (isWall && !a.owner) html += `<p class="muted">Спасибо за покупку! Скачивайте сколько угодно раз.</p>`;
      else html += `<div class="shop-row">${fileLinks(v.paidFiles, true)}</div>`;
      if (s.sub && a.until) html += `<p class="muted">Продлить:</p><div class="shop-row">${subButtons(s)}</div>`;
    } else {
      if (v.kind === "video") html += `<p class="muted">Сейчас идёт бесплатный трейлер. Полное видео — ${fmtDur(v.paidParts.reduce((x, p) => x + p.duration, 0))}.</p>`;
      html += `<div class="shop-row">`;
      if (s.per_hour && isGame) html += game ? "" : `<button class="btn big" data-gamehour>▶ Играть · ${RUB(s.per_hour)}/час<small>оплата поминутно, только пока игра открыта</small></button>`;
      else if (s.per_hour) html += timer ? "" : `<button class="btn" data-hourly>▶ Смотреть полностью · ${RUB(s.per_hour)}/час<small>${perMin(s.per_hour)} в минуту, только пока видео играет</small></button>`;
      if (s.buy) html += `<button class="btn ${s.per_hour ? "ghost" : ""} ${isWall ? "big" : ""}" data-buy="buy">${isWall ? "🛒 Купить и скачать обои" : isGame ? "Купить игру навсегда" : isModel ? "🛒 Купить модель" : "Купить навсегда"} · ${RUB(s.buy)}</button>`;
      html += subButtons(s) + `</div>`;
      html += `<p id="hourly" class="muted">На балансе ${RUB(a.funds)} · <a href="/bux?tab=wallet">пополнить</a></p>`;
    }
    if (isWall) html += wallInfo();
    const glb = modelFile();
    if (glb) html += `<div class="shop-row"><button class="btn ghost" data-3d>🧊 ${viewer ? "Скрыть 3D" : "Посмотреть модель в 3D"}</button></div>`;
    if (isGame) html += `<p class="muted">🎮 Игра запускается прямо в браузере (WebGL). Работает в изолированном окне: у игры нет доступа к вашему аккаунту и балансу.${v.sale?.per_hour && !a.owned ? " Деньги списываются поминутно, только пока игра открыта на этой странице." : ""}</p>`;
    html += `<p class="muted" id="shopMsg"></p>`;
    box.innerHTML = html;
    box.querySelectorAll("[data-buy]").forEach((b) => (b.onclick = () => buy(b.dataset.buy)));
    box.querySelector("[data-hourly]")?.addEventListener("click", startHourly);
    box.querySelector("[data-play]")?.addEventListener("click", () => startGame(false));
    box.querySelector("[data-gamehour]")?.addEventListener("click", () => startGame(true));
    box.querySelector("[data-3d]")?.addEventListener("click", toggle3d);
  }
  const perMin = (k) => (k % 60 ? "≈" : "") + (k / 6000).toLocaleString("ru", { maximumFractionDigits: 3 }) + " ₽";

  // ── WebGL-игра: изолированный iframe, поминутная оплата, сохранения ──
  let game = null, gameTimer = null;
  const saveKey = "atsave:" + v.id;
  async function gameTick() {
    const r = await postJ("/api/shop/tick", { id: v.id });
    if (!r.ok) { stopGame(r.error || "Не удалось списать оплату"); return false; }
    spent += r.charged || 0;
    if (typeof r.funds === "number") a.funds = r.funds;
    const st = document.getElementById("gameStatus");
    if (st && !r.owned) st.textContent = `⏱ Игра по времени · списано ${RUB(spent)} · на балансе ${RUB(a.funds)}`;
    return true;
  }
  async function startGame(hourly) {
    const msg = document.getElementById("shopMsg");
    if (hourly && !(await gameTick())) return;
    const r = await postJ("/api/game/start", { id: v.id });
    if (!r.ok) { if (msg) msg.innerHTML = `❌ ${esc(r.error || "Игра не запустилась")}`; return; }
    vid.pause();
    const wrap = document.createElement("div");
    wrap.className = "game-stage";
    wrap.innerHTML = `<iframe title="${esc(v.title)}" allow="fullscreen; autoplay; gamepad; xr-spatial-tracking" allowfullscreen
        sandbox="allow-scripts allow-pointer-lock allow-popups allow-forms allow-modals allow-downloads allow-orientation-lock"></iframe>
      <div class="game-bar"><button class="btn" data-fs>⛶ На весь экран</button><button class="btn ghost" data-stop>⏹ Закончить игру</button>
        <span class="muted" id="gameStatus">${hourly ? "" : "🎮 Приятной игры!"}</span></div>`;
    const frame = wrap.querySelector("iframe");
    let saved = ""; try { saved = localStorage.getItem(saveKey) || ""; } catch {}
    frame.name = "anytube:" + (saved || "{}"); // сохранения игры передаются внутрь песочницы
    frame.src = r.url;
    (vid.closest(".vwrap") || vid).before(wrap);
    (vid.closest(".vwrap") || vid).style.display = "none";
    wrap.querySelector("[data-fs]").onclick = () => (frame.requestFullscreen || frame.webkitRequestFullscreen)?.call(frame);
    wrap.querySelector("[data-stop]").onclick = () => stopGame();
    game = { wrap, frame };
    if (hourly) {
      gameTimer = setInterval(() => { if (!document.hidden) gameTick(); }, 30000);
      document.addEventListener("visibilitychange", onVis);
      gameTick();
    }
    render();
    wrap.scrollIntoView({ behavior: "smooth", block: "start" });
    frame.focus();
  }
  const onVis = () => { if (!document.hidden && gameTimer) gameTick(); };
  function stopGame(err) {
    clearInterval(gameTimer); gameTimer = null;
    document.removeEventListener("visibilitychange", onVis);
    if (game) { game.wrap.remove(); (vid.closest(".vwrap") || vid).style.display = ""; game = null; }
    render();
    if (err) document.getElementById("shopMsg").innerHTML = `⛔ ${esc(err)} <a href="/bux?tab=wallet">Пополнить баланс</a>`;
  }
  window.addEventListener("message", (e) => { // сохранения из игры (localStorage) — только от нашего iframe
    if (!game || e.source !== game.frame.contentWindow) return;
    const d = e.data && e.data.anytubeSave;
    if (typeof d === "string" && d.length < 4e6) try { localStorage.setItem(saveKey, d); } catch {}
  });

  // ── 3D-модель: просмотр .glb прямо на странице ──
  let viewer = null;
  function modelFile() {
    if (!isModel) return null;
    if (!v.sale) { const i = v.files.findIndex((f) => /\.glb$/i.test(f.name)); return i < 0 ? null : `/file?id=${encodeURIComponent(v.id)}&f=${i}`; }
    if (!a.owned) return null;
    const f = v.paidFiles.find((x) => /\.glb$/i.test(x.name));
    return f ? `/paid/file?id=${encodeURIComponent(v.id)}&f=${f.i}` : null;
  }
  async function toggle3d() {
    if (viewer) { viewer.remove(); viewer = null; render(); return; }
    if (!customElements.get("model-viewer")) {
      await new Promise((ok, bad) => { const sc = document.createElement("script"); sc.type = "module";
        sc.src = "https://ajax.googleapis.com/ajax/libs/model-viewer/3.5.0/model-viewer.min.js"; sc.onload = ok; sc.onerror = bad; document.head.appendChild(sc); }).catch(() => {});
    }
    viewer = document.createElement("div");
    viewer.className = "model-stage";
    viewer.innerHTML = `<model-viewer src="${modelFile()}" camera-controls auto-rotate touch-action="pan-y" shadow-intensity="1" exposure="1"
      alt="${esc(v.title)}" style="width:100%;height:100%;background:#1b1b22"><div slot="progress-bar" class="muted" style="padding:12px">Загрузка модели…</div></model-viewer>
      <p class="muted">Крутите мышкой или пальцем, колёсико — приблизить.</p>`;
    (vid.closest(".vwrap") || vid).before(viewer);
    render();
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
