# AnyTube

Видеохостинг, который берёт видео из публичных GitHub-репозиториев с именем `anytubevideo_*` (или с topic `anytubevideo`).
Пример: `autor/anytubevideo_myvideo` с файлом `myvideo.mp4`.

Возможности: лента, поиск, каналы авторов, плеер с перемоткой, скачивание, поддержка Git LFS, страница-инструкция `/upload`.

## Запуск локально
```
npm install
set GITHUB_TOKEN=ghp_xxx      # Linux/macOS: export GITHUB_TOKEN=ghp_xxx
npm start
```
Открыть http://localhost:3000

## Деплой на Render
1. Залейте эту папку в свой репозиторий GitHub (например `anytube`).
2. На https://dashboard.render.com → **New → Blueprint** → выберите репозиторий (Render прочитает `render.yaml`).
   Или **New → Web Service**: Build `npm install`, Start `npm start`.
3. Создайте токен: GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained**, доступ только к публичным репозиториям, без прав. Вставьте его в переменную `GITHUB_TOKEN` на Render.
   Без токена GitHub даёт всего 60 запросов в час — сайт быстро упрётся в лимит.

## Переменные
| Переменная | По умолчанию | Что делает |
|---|---|---|
| `GITHUB_TOKEN` | — | токен GitHub (очень желателен) |
| `CACHE_MINUTES` | 10 | как часто обновлять список видео |
| `MAX_SEARCH_PAGES` | 5 | страниц поиска по 100 репо |

## Ограничения
- Бесплатный Render засыпает после 15 минут без запросов; первый заход после сна — ~30–60 с.
- Видео идут через сервер (прокси), поэтому трафик Render расходуется. Бесплатный план включает ограниченный исходящий трафик в месяц.
- Обычные файлы в GitHub — до 100 МБ; больше — только через Git LFS (у которого своя квота).
