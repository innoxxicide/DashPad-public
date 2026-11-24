# DashPad: data-source research (weather, air-raid alerts, power-outage schedules)

Research date: **2026-11-19**. Live tests were run from a Windows machine on a **Ukrainian residential IP** (Kyiv oblast). One extra non-Ukrainian check went through a US-hosted fetcher (`WebFetch`).

Legend:
- **[LIVE]**: verified by a real call on 2026-11-19. The sample response shown is real but trimmed.
- **[READ]**: taken from docs or source code only, not called.
- **[NOT VERIFIED]**: plausible, but unconfirmed. Test it before relying on it.

First target region: **Kyiv oblast (Київська область)**. That means DTEK KREM for outages, and oblast UID 14 (raions 73–79) for alerts.

---

## 0. TL;DR / recommendations

| Feed | Primary | Fallback | Backend (CF Worker) needed? |
|---|---|---|---|
| Weather | Open-Meteo forecast + geocoding [LIVE] | met.no Locationforecast [LIVE] | **No.** CORS `*`, no key. The Worker is optional, as a cache. |
| Air-raid alerts | alerts.in.ua API (token) via Worker [READ; 401 shape LIVE] | siren.pp.ua (public wrapper of ukrainealarm, no key) [LIVE] | **Yes.** The alerts.in.ua ToS forbids shipping the token to clients. siren.pp.ua / vadimklimenko send no CORS headers. |
| Outages, Kyiv oblast | DTEK KREM `/ua/ajax` (`getHomeNum`), the same JSON the official page uses [LIVE from UA IP] | svitlo.live Worker API [LIVE, fresh], then the GitHub mirror `Baskerville42/outage-data-ua` `kyiv-region.json` [LIVE, but **stale 3 h** at test time] | **Yes.** No CORS, needs a cookie + CSRF dance, and the anti-bot layer is Imperva. Whether DTEK accepts requests from **Cloudflare Worker egress IPs** is **[NOT VERIFIED]**. Test it first (see §3.2.7). |

Normalized outage model: **per day, 48 half-hour slots, each `on | off | maybe | unknown`**, plus day status and provenance metadata (§3.6).

---

## 1. Weather

### 1.1 Open-Meteo forecast API [LIVE]

- Endpoint: `https://api.open-meteo.com/v1/forecast`
- **No API key** for non-commercial use. The commercial tier uses `customer-api.open-meteo.com` plus `&apikey=`.
- **CORS**: `access-control-allow-origin: *` [LIVE], so the WebView can call it directly.
- **Rate limits** (free): 600 calls/min, 5,000/hour, 10,000/day, 300,000/month, counted per IP [READ: open-meteo.com/en/terms]. Responses carry headers [LIVE]: `X-RateLimit-Limit: 600.0`, `X-RateLimit-Remaining`, `X-RateLimit-Window: 60`, `X-RateLimit-Cost: 1.5`. Heavy calls with many variables or days cost more than 1.
- **Terms**: free tier is non-commercial only (no ads or subscriptions). Data is CC BY 4.0, so show an "Weather data by Open-Meteo.com" attribution somewhere (a settings/about screen is fine).
- Open-Meteo itself suggests Cloudflare Workers as a proxy host when shared hosts hit limits.

Request used (Kyiv):
```
https://api.open-meteo.com/v1/forecast?latitude=50.45&longitude=30.52
 &current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,precipitation_probability,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day
 &daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,sunrise,sunset
 &timezone=Europe%2FKyiv&forecast_days=7&wind_speed_unit=ms
```
Real response (trimmed, units block shortened):
```json
{"latitude":50.423317,"longitude":30.491209,"utc_offset_seconds":7200,"timezone":"Europe/Kyiv","timezone_abbreviation":"GMT+2","elevation":169.0,
 "current_units":{"temperature_2m":"°C","relative_humidity_2m":"%","precipitation_probability":"%","weather_code":"wmo code","wind_speed_10m":"m/s","wind_direction_10m":"°"},
 "current":{"time":"2026-11-19T14:15","interval":900,"temperature_2m":11.5,"relative_humidity_2m":68,"apparent_temperature":8.8,"precipitation":0.00,
            "precipitation_probability":0,"weather_code":2,"wind_speed_10m":3.18,"wind_gusts_10m":8.90,"wind_direction_10m":257,"is_day":1},
 "daily":{"time":["2026-11-19","2026-11-20","2026-11-21","2026-11-22","2026-11-23","2026-11-24","2026-11-25"],
          "weather_code":[80,63,61,61,73,85,71],
          "temperature_2m_max":[11.6,8.0,7.3,3.0,0.9,0.5,0.3],
          "temperature_2m_min":[6.3,6.3,0.3,0.1,-0.6,-0.9,-0.9],
          "precipitation_probability_max":[100,100,25,23,20,24,21],
          "precipitation_sum":[2.00,15.80,0.80,0.30,17.10,2.10,0.30],
          "wind_speed_10m_max":[3.76,5.10,3.22,3.54,4.53,4.75,4.19],
          "sunrise":["2026-11-19T07:18", "..."],"sunset":["2026-11-19T16:07", "..."]}}
```
Notes:
- `current` is a 15-minute value (`interval: 900`). `precipitation_probability` is accepted in `current` [LIVE].
- `daily[0]` is today, so `forecast_days=7` gives today plus 6 days. Use `forecast_days=8` if you want "today + 7 days ahead".
- Use `is_day` to pick day/night icon variants.
- Suggested refresh: current conditions every 15 min, daily every 1–3 h. That is a tiny fraction of the limits.

### 1.2 Open-Meteo geocoding (Ukrainian city search) [LIVE]

- `https://geocoding-api.open-meteo.com/v1/search?name=<q>&count=10&language=uk&countryCode=UA&format=json`
- CORS `*` [LIVE], `cache-control: public, max-age=86400`.
- Matching: 1 character gives nothing, 2 characters match exact names, 3 or more do a case- and diacritic-insensitive **prefix** match. It is not typo-tolerant [READ].

Real example, `name=Біла Церква`:
```json
{"results":[{"id":712165,"name":"Біла Церква","latitude":49.7994,"longitude":30.1165,"elevation":163.0,"feature_code":"PPLA2",
  "country_code":"UA","admin1":"Київська область","admin2":"Bilotserkivs’ka Mis’krada","admin3":"Bilotserkivska Terytorialna Hromada",
  "timezone":"Europe/Kyiv","population":207273,"country":"Україна"}]}
```
`name=Київ` returns `{"id":703448,"name":"Київ","admin1":"Місто Київ","population":2952301,"feature_code":"PPLC"}` first, then villages named Київ in other oblasts. Show `admin1`/`admin2` in the picker to disambiguate. Some `admin2`/`admin3` values are still Latin transliterations.

Store in settings: `{name, admin1, lat, lon, timezone}`. Weather calls need only lat/lon. The same `admin1` can pre-select the oblast for alerts and outages.

### 1.3 Alternatives

| Source | Verdict |
|---|---|
| **met.no Locationforecast 2.0** `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=50.45&lon=30.52` [LIVE, 200, CORS `*`] | Good fallback. Free and CC BY 4.0. Caveats: it requires an identifying User-Agent (or Origin/Referer from browsers). Coordinates are capped at 4 decimals. You must respect `Expires`/`If-Modified-Since`. There are no daily min/max aggregates: you compute them from hourly `timeseries`. It uses its own `symbol_code` icons (`partlycloudy_day`) instead of WMO codes. met.no asks apps to go through a backend proxy. |
| **OpenWeatherMap free** [READ: openweathermap.org/price] | Not recommended. Needs an API key, which would need the proxy. The free tier has current weather plus a **5-day / 3-hour** forecast only. The daily 16-day forecast is not free, and One Call 4.0 is pay-per-call (1,000/day free, card on file). |

### 1.4 WMO `weather_code` → description / icon

Open-Meteo returns WMO 4677 codes. Map these (uk text):

| code | uk | icon idea |
|---|---|---|
| 0 | Ясно | sun / moon |
| 1 | Переважно ясно | sun-small-cloud |
| 2 | Мінлива хмарність | partly-cloudy |
| 3 | Хмарно | cloud |
| 45 | Туман | fog |
| 48 | Туман з памороззю | fog |
| 51 / 53 / 55 | Мряка слабка / помірна / сильна | drizzle |
| 56 / 57 | Крижана мряка слабка / сильна | freezing-drizzle |
| 61 / 63 / 65 | Дощ слабкий / помірний / сильний | rain |
| 66 / 67 | Крижаний дощ слабкий / сильний | freezing-rain |
| 71 / 73 / 75 | Сніг слабкий / помірний / сильний | snow |
| 77 | Снігова крупа | snow-grains |
| 80 / 81 / 82 | Зливи слабкі / помірні / сильні | showers |
| 85 / 86 | Снігопад (зливовий) слабкий / сильний | snow-showers |
| 95 | Гроза | thunder |
| 96 / 99 | Гроза з градом слабким / сильним | thunder-hail |

Use `is_day` (current) to swap day and night variants for 0–2.

---

## 2. Air-raid alerts by region

Kyiv oblast fact found live: on 2026-11-19 at about 14:25, Kyiv oblast had **raion-level** alerts only (6 of 7 raions, yellow level). The oblast-level record (`14`) was **not** active. Bilotserkivskyi raion had none. **Oblast-level polling alone gives the wrong answer for Kyiv oblast.** The dashboard must evaluate the user's **raion (and optionally hromada) together with its oblast**.

### 2.1 Region IDs (shared by alerts.in.ua and ukrainealarm/siren) [LIVE]

alerts.in.ua UIDs and ukrainealarm `regionId`s turned out to be **the same numbers** (checked oblast, raion and hromada for Kyiv oblast):

| ID | Name | Type |
|---|---|---|
| 14 | Київська область | oblast (State) |
| 73 | Білоцерківський район | raion (District) |
| 74 | Вишгородський район | raion |
| 75 | Бучанський район | raion |
| 76 | Обухівський район | raion |
| 77 | Фастівський район | raion |
| 78 | Бориспільський район | raion |
| 79 | Броварський район | raion |
| 711 | м. Біла Церква та Білоцерківська ТГ | hromada (Community) |
| 684 | м. Бровари та Броварська ТГ | hromada |
| 706 | м. Ірпінь та Ірпінська ТГ | hromada |
| 31 | м. Київ (separate from the oblast) | city/State |

Oblast UIDs (alerts.in.ua): 3 Хмельницька, 4 Вінницька, 5 Рівненська, 8 Волинська, 9 Дніпропетровська, 10 Житомирська, 11 Закарпатська, 12 Запорізька, 13 Івано-Франківська, 14 Київська, 15 Кіровоградська, 16 Луганська, 17 Миколаївська, 18 Одеська, 19 Полтавська, 20 Сумська, 21 Тернопільська, 22 Харківська, 23 Херсонська, 24 Черкаська, 25 Чернігівська, 26 Чернівецька, 27 Львівська, 28 Донецька, 29 АР Крим, 30 Севастополь, 31 м. Київ. Notes on siren.pp.ua: Crimea is `9999` there, and it has separate entries `564` (Zaporizhzhia city + hromada) and `1293` (Kharkiv city + hromada).

Full tree sources:
- `GET https://siren.pp.ua/api/v3/regions`: states → districts → communities, about 200 KB [LIVE]. This is the easiest way to build the oblast → raion → hromada picker; cache it for days.
- alerts.in.ua spreadsheet (1,600+ rows): `https://docs.google.com/spreadsheets/d/1XnTOzcPHd1LZUrarR1Fk43FUyl8Ae6a6M7pcwDRjNdA/export?format=csv` [LIVE].

### 2.2 alerts.in.ua (recommended primary) [READ docs; error shape LIVE]

- Docs: https://devs.alerts.in.ua/. Token request: form at https://alerts.in.ua/api-request. The form is JS-rendered, and it is not clear whether the token is free or what the conditions are. Approval depends on accepting their rules.
- Auth: `Authorization: Bearer <token>` header or `?token=`.
- Base `https://api.alerts.in.ua`, behind Cloudflare. It returned `X-Country: UA` and `X-City` headers to us.

Endpoints:

| Endpoint | Returns |
|---|---|
| `/v1/alerts/active.json` | `{"alerts":[...]}` with all active alerts at every level (oblast/raion/hromada/city) |
| `/v1/iot/active_air_raid_alerts_by_oblast.json` | 27-char string, one char per oblast in **alphabetical order**: 1 Крим, 2 Волинська, 3 Вінницька, 4 Дніпропетровська, 5 Донецька, 6 Житомирська, 7 Закарпатська, 8 Запорізька, 9 Ів.-Франківська, **10 м. Київ, 11 Київська**, 12 Кіровоградська, 13 Луганська, 14 Львівська, 15 Миколаївська, 16 Одеська, 17 Полтавська, 18 Рівненська, 19 Севастополь, 20 Сумська, 21 Тернопільська, 22 Харківська, 23 Херсонська, 24 Хмельницька, 25 Черкаська, 26 Чернівецька, 27 Чернігівська. Example `"ANNNNNNNNNNNANNNNNNNNNNNNNN"` |
| `/v2/iot/active_air_raid_alerts_by_oblast.json` | Same, but distinguishes `R` (red) / `Y` (yellow) |
| `/v1/iot/active_air_raid_alerts/{uid}.json` | One char: `"A"` (whole region), `"P"` (partial, some raions/hromadas), `"N"` (no info / none). Accepts oblast, raion or hromada UIDs. |
| `/v2/iot/active_air_raid_alerts/{uid}.json` | Same with R/Y |
| `/v1/iot/active_air_raid_alerts.json` / `/v2/...` | One long string; character position = UID |
| `/v1/regions/{uid}/alerts/month_ago.json` | History. Separate limit of 2 req/min; not meant for real time. |
| `/v3/alerts/active.md` | **Public, no token** [LIVE]. Markdown "SITREP" for humans/LLMs, refreshed every minute. Not a machine API; don't parse it. |

Alert object fields: `id, location_title, location_title_en, location_type (oblast|raion|city|hromada|unknown), started_at, finished_at, updated_at, alert_type (air_raid|artillery_shelling|urban_fights|chemical|nuclear), location_uid, location_oblast, location_oblast_uid, location_raion, notes, alert_level (red|yellow), threats[]`. Each threat has `threat_type`, which is one of `tactic_aircraft_activity`, `strategic_aircraft_activity`, `mig31k_departure`, `ballistic_missiles`, `cruise_missiles`, `unspecified_missiles`, `drones`, `guided_aerial_bombs`, `air_defense` or `unknown`. It also has `level`, `started_at` and `source_message`.

Alert levels (new since 2025): **red** means missiles or a mass strike, go to shelter. **yellow** means drones; businesses may keep operating. Show both on the dashboard with distinct colours.

Limits and terms [READ]:
- Soft limit 8–10 req/min per IP, hard limit 12/min, then 429. A token can be blocked for abnormal daily volume.
- Supports `If-Modified-Since` → `304`.
- Error codes: 401 (no or bad token), 403 (IP blocked or **unavailable in your country**), 429.
- **The token must not be put in client code** (web pages, apps). Public services must proxy through their own server.
- Not for critical infrastructure. No liability.

Unauthenticated call [LIVE]:
```
HTTP/1.1 401 Unauthorized   (Server: cloudflare, no CORS headers)
{"message":"API token required. Please contact api@alerts.in.ua for details."}
```

Worker usage:
- Poll `/v1/alerts/active.json` (or `/v2/iot/active_air_raid_alerts.json`) about every 15–20 s with `If-Modified-Since`, and cache the result in the Cache API.
- The tablet reads `/alerts?ids=14,73,711` from the Worker.
- **Risk:** the per-IP limit applies to the Worker's egress IP, which is shared Cloudflare infrastructure. The 403 "unavailable in your country" path also exists; Worker subrequests leave from the colo serving the request, probably a Cloudflare IP not geolocated to UA. **[NOT VERIFIED]**. Test with the real token.

### 2.3 ukrainealarm.com official API (api.ukrainealarm.com) [partly LIVE]

- Base `https://api.ukrainealarm.com/api/v3`. Swagger at `/swagger/index.html`, but it sits behind a Cloudflare challenge, so we could not read it.
- Endpoints [READ, mirrored 1:1 by siren.pp.ua, which is LIVE]: `GET /alerts`, `GET /alerts/{regionId}`, `GET /alerts/status` (`{"lastActionIndex":…}`, a cheap change detector), `GET /regions`. Per older docs, also `/alerts/regionHistory?regionId=` and webhooks.
- Auth: `Authorization: <key>` header (raw key) [READ]. Verified behaviour [LIVE]: a request **without** an Authorization header gets a Cloudflare **403 "Sorry, you have been blocked"** HTML page. **With** any Authorization header, the origin answers `401` with an empty body. No CORS headers.
- Key: you apply on the site (form with contact details plus a project description) [READ: Ajax Systems blog]. There is no self-service key.

### 2.4 No-key public endpoints [LIVE]

| Endpoint | Status 2026-11-19 | Granularity | CORS | Notes |
|---|---|---|---|---|
| `https://siren.pp.ua/api/v3/alerts`, `/alerts/{regionId}`, `/alerts/status`, `/regions` | **Works, fresh** (snapshot age about 1–2 s) | oblast + raion + hromada, red/yellow, alert types AIR/ARTILLERY/URBAN_FIGHTS… | **none** (proxy needed) | Public wrapper of ukrainealarm, used by the **Home Assistant core `ukraine_alarm` integration** (lib `uasiren`). Limit **50 req/min per IP**. Burst limit [LIVE, 2026-11-21 18:44–18:45]: 40 back-to-back GETs from one IP in 7 s → at least 20 answered HTTP 429. Sits behind an nginx cache: `X-Cache-Status: STALE` is nginx's stale-cache answer during upstream errors or timeouts, and `UPDATING` is a stale copy too (`proxy_cache_use_stale`: "the updating parameter permits using a stale cached response if it is currently being updated", https://nginx.org/en/docs/http/ngx_http_proxy_module.html); DashPad treats both as a siren failure. Best no-key fallback. |
| `https://vadimklimenko.com/map/statuses.json` | Works, fresh (`Last-Modified` current) | oblast + `districts` with `enabled`, `alert_level` | none | Free, informal ("contact mail@vadimklimenko.com"). Key names are Ukrainian region names. Field `"type:"` really has a typo. |
| `https://ubilling.net.ua/aerialalerts/` | Works (`cachedat` current) | oblast only; `alertnow` is **true if any raion** is under alert | none | Re-publishes the Vadym Klymenko feed with a 60 s cache. Too coarse for Kyiv oblast. |
| `https://alerts.com.ua/api/states` | **Stale or broken.** `м. Київ alert:true changed 2026-11-07`, max `changed` across all = 2026-11-07 | oblast | – | **Do not use.** |
| `emapa.fra1.cdn.digitaloceanspaces.com/statuses.json`, `war-api.ukrzen.in.ua/...` | Timed out | – | – | Dead. |

siren.pp.ua samples [LIVE, 14:25 Kyiv]:
```json
GET /api/v3/alerts/14
[{"regionId":"14","regionType":"State","regionName":"Київська область","regionEngName":"Kyivska region","lastUpdate":"2025-11-04T01:37:05.931809Z","activeAlerts":[]}]

GET /api/v3/alerts/79   (sample; region id replaced)
[{"regionId":"79","regionType":"District","regionName":"Броварський район","regionEngName":"Brovarskyi district","lastUpdate":"2026-11-19T10:01:57.931556Z",
  "activeAlerts":[{"regionId":"79","regionType":"District","type":"AIR","lastUpdate":"2026-11-19T10:01:57.931556Z",
                   "activeAlertLevels":[{"alertLevel":"Yellow","reason":"","createdAt":"2026-11-19T10:01:58.004843Z"}]}]}]

GET /api/v3/alerts/73   → "activeAlerts":[]     (Білоцерківський район: clear)
GET /api/v3/alerts/status → {"lastActionIndex":639306888015961866}
```
`/alerts/{id}` returns only alerts declared **at that exact level**. Compute:
- `activeForUser = alerts(oblast) || alerts(raion) || alerts(hromada)`
- `level = max(level)`, where red > yellow

Better still, fetch the full `/alerts` list once and filter it in the Worker.

vadimklimenko sample [LIVE]:
```json
"Київська область":{"enabled":false,"alert_level":null,"districts":{"Броварський район":{"enabled":true,"alert_level":"yellow",...},"Білоцерківський район":{"enabled":false,"alert_level":null,...}, ...}}
"м. Київ":{"enabled":true,"type:":"state","enabled_at":"2026-11-19T12:32:58.877Z","disabled_at":null,"alert_level":"yellow"}
```

### 2.5 Recommendation (alerts)

1. **Primary: alerts.in.ua** through the Worker. It is the most widely used source, has a documented API, threats, red/yellow levels and IoT strings. The user needs to **apply for a token**.
2. **Fallback, and the starting point until the token arrives: siren.pp.ua** through the Worker, filtered by oblast + raion (+ hromada).
3. Tablet poll interval: 15–30 s against the Worker. The Worker caches upstream for 10–15 s.
4. Settings: oblast → raion → (optional) hromada, built from `siren.pp.ua/api/v3/regions`.

---

## 3. Scheduled power outages (графіки відключень)

### 3.1 Group naming

- **Kyiv oblast (DTEK KREM)**, and most oblenergos: 12 groups, `1.1, 1.2, 2.1 … 6.2` (черга.підчерга). DTEK keys them as `GPV1.1` … `GPV6.2` [LIVE]. Strip the `GPV` prefix for display ("Черга 2.2").
- **Kyiv city (DTEK KEM / YASNO)**: as of Nov 2026, **60 groups `1.1 … 60.1`** [LIVE via YASNO and svitlo.live]. This is no longer 6×2, so don't hard-code 12 groups.
- Chernivtsi: numbered groups 1–12 [READ: RobinCK/blackout].

### 3.2 DTEK KREM (dtek-krem.com.ua): Kyiv oblast, **deep dive**

#### 3.2.1 Anti-bot [LIVE]

- Every GET page (including `/ua/shutdowns`) is behind **Imperva Incapsula**. A non-browser GET receives a 212–843-byte JS challenge (`<script src="/_Incapsula_Resource?...">`) instead of the page. So the `DisconSchedule.fact = {...}` blob embedded in the page HTML **cannot be scraped without a real browser** (headless Chromium/Playwright). Cookie-retry tricks did not get through for us with a plain client. We did not pursue browser impersonation.
- **However, `POST /ua/ajax` is not challenged** [LIVE]. That is the endpoint the page's own JS uses to look up an address. It returns the **same `fact` and `preset` objects** that are embedded in the page. The open-source HA integration `NetZhizni/ha-dtek-krem-outages` uses this method (verified by its author 2026-10-18), and so did we. The same flow worked on `dtek-kem`, `dtek-oem` and `dtek-dnem` [LIVE: bootstrap + `getStreets` 200 on all four].
- `robots.txt` says `User-agent: * / Disallow: /`. Polling the AJAX endpoint is low volume and per-user, not crawling, but it is unofficial. Keep it polite: at least 5–10 min between polls, one shared Worker cache, an identifying UA.

#### 3.2.2 CSRF / session flow (Yii2) [LIVE]

1. `POST https://www.dtek-krem.com.ua/ua/ajax` with body `method=getHomeNum`, no token. The response is **400** `Bad Request (#400): Не вдалося перевірити передані дані.` It sets these cookies:
   - `_csrf-dtek-krem=<hmac>a:2:{i:0;s:15:"_csrf-dtek-krem";i:1;s:32:"<TOKEN>";}` (URL-encoded, signed but **not encrypted**, PHP-serialized)
   - `dtek-krem=<PHPSESSID>` (30 min)
   - `_language`
   - Incapsula `visid_incap_*` / `incap_ses_*`
2. Extract `<TOKEN>` with the regex `i:1;s:\d+:"([^"]+)"`, applied to the URL-decoded cookie.
3. Mask it like Yii2 `Security::maskToken`: `X-CSRF-Token = base64url(mask ‖ (mask XOR token))`, where `mask` is random bytes of the token's length.
4. Re-POST with all cookies plus these headers: `X-CSRF-Token`, `X-Requested-With: XMLHttpRequest`, `Origin: https://www.dtek-krem.com.ua`, `Referer: https://www.dtek-krem.com.ua/ua/shutdowns`, `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`.
5. If you get 400 again, refresh the cookie/token once and retry.

Reference implementation: a one-off Node ≥18 `fetch` script (about 80 lines; not kept with the Worker code; ports directly to a Worker, which has `crypto.getRandomValues`, `btoa` and `Headers.getSetCookie()`).

#### 3.2.3 Methods [LIVE]

**`method=getStreets`** returns `{"result":true,"streets":{"<settlement>":["<street>",...]}}`. The response is **about 467 KB**, with **1,197 settlements** and about 25,400 streets. Keys look like `м. Біла Церква` (370 streets), `м. Бровари`, `м. Ірпінь`, `с. Ємчиха`. Villages often have `"Без вулиці"`. Cache it in the Worker for about 1 day, or bundle a snapshot. Use it to drive the settlement → street pickers.

**`method=getHomeNum`** takes form pairs that mimic jQuery `serializeArray`:
```
method=getHomeNum
data[0][name]=city        data[0][value]=м. Біла Церква
data[1][name]=street      data[1][value]=вул. Січових Стрільців
data[2][name]=updateFact  data[2][value]=01.01.2000 00:00
```
- `updateFact` works as a version. If it is truthy and differs from the current `fact.update`, the response **includes `fact` + `preset`**. If it is empty or equal, they are omitted, which is cheap. Sending an old date forces the full payload.

Real response (trimmed; 123 houses on that street, about 45 KB with fact/preset):
```json
{"result":true,
 "data":{
   "70": {"sub_type":"","start_date":"","end_date":"","type":"","sub_type_reason":["GPV2.2"],"voluntarily":null,"cek":null},
   "5А": {"sub_type":"","start_date":"","end_date":"","type":"","sub_type_reason":["GPV2.2"],"voluntarily":null,"cek":null}
 },
 "showCurOutageParam":true,"showCurSchedule":true,"showTableSchedule":true,"showTablePlan":false,"showTableFact":true,"showUserGroup":true,
 "updateTimestamp":"14:18 19.11.2026",
 "fact":{"data":{"1795039200":{"GPV1.1":{...},"GPV2.2":{"1":"yes","2":"yes","3":"yes","4":"yes","5":"yes","6":"yes","7":"yes","8":"yes","9":"yes","10":"yes",
                                         "11":"second","12":"no","13":"no","14":"no","15":"first","16":"yes","17":"yes","18":"yes","19":"yes","20":"yes",
                                         "21":"yes","22":"second","23":"no","24":"no"}, "...":"GPV1.1..GPV6.2"}},
         "update":"19.11.2026 13:46","today":1795039200},
 "preset":{"data":{"GPV2.2":{"1":{"1":"maybe","2":"maybe","3":"maybe","4":"maybe","5":"maybe","6":"mfirst","7":"yes","8":"yes","9":"yes","10":"maybe",
                                   "11":"maybe","12":"maybe","13":"maybe","14":"maybe","15":"maybe","16":"maybe","17":"yes","18":"yes","19":"yes",
                                   "20":"msecond","21":"maybe","22":"maybe","23":"maybe","24":"maybe"}, "2":{...}, "...7":{...}}, "...":"all 12 groups"},
           "sch_names":{"GPV1.1":"Черга 1.1", "...":"...", "GPV6.2":"Черга 6.2"},
           "days":{"1":"Понеділок", "...":"...", "7":"Неділя"},
           "time_zone":{"1":["00-01","00:00","01:00"], "...":"...", "24":["23-24","23:00","24:00"]},
           "time_type":{"yes":"Світло є","maybe":"Можливо відключення","no":"Світла немає",
                        "first":"Світла не буде перші 30 хв.","second":"Світла не буде другі 30 хв",
                        "mfirst":"Світла можливо не буде перші 30 хв.","msecond":"Світла можливо не буде другі 30 хв"},
           "updateFact":"19.11.2026 13:46"}}
```

#### 3.2.4 Encoding: today / tomorrow / definite / possible [LIVE + READ]

- **`fact`** is the schedule actually in force: **"definite"** outages for **today and, once published, tomorrow**.
  - `fact.data` keys are Unix timestamps of **local Kyiv midnight**. `1795039200` = 2026-11-18T22:00Z = 2026-11-19 00:00 EET.
  - `fact.today` says which key is today.
  - Tomorrow appears as a second key, usually in the evening. At 14:30 on test day only today was present.
  - `fact.update` = `"dd.mm.YYYY HH:MM"` local; it is the source publication time.
  - `fact.data` can be `[]` (empty array) when nothing is published. Around midnight, `today` can advance to a day with no data yet (see the mirror's incident report, 2026-10-30). Treat **missing as `unknown`, never as "power on"**.
- **`preset`** is the weekly template of **possible** outages (`maybe`/`mfirst`/`msecond`). `preset.data[group][isoWeekday 1..7][hour 1..24]`. `showTablePlan:false` (as today) means DTEK currently hides the weekly table, so treat preset as informational only.
- **Hours** `"1".."24"` = 00:00–01:00 … 23:00–24:00 local. Values map to two half-hour slots:

  | value | slot 1 (:00–:30) | slot 2 (:30–:00) |
  |---|---|---|
  | `yes` | on | on |
  | `no` | **off** | **off** |
  | `first` | off | on |
  | `second` | on | off |
  | `maybe` | maybe | maybe |
  | `mfirst` | maybe | on |
  | `msecond` | on | maybe |

  Example (GPV2.2 today): `11:second, 12–14:no, 15:first` gives **off 10:30–14:30**. `22:second, 23–24:no` gives **off 21:30–24:00**. This was cross-checked against svitlo.live [LIVE]; they match.
- **Per-address current outage** (`data[house]`):
  - `sub_type` = reason text. It is empty when there is no outage, e.g. "Стабілізаційне відключення" or "Аварійне відключення".
  - `start_date` / `end_date` = `"HH:MM dd.mm.YYYY"`.
  - `type` = `"2"` or `""`.
  - Classify by text: `стабіліз` = stabilization (schedule), `аварій|екстрен` = emergency, `план` = planned works [READ: NetZhizni].
  - A house can carry a list of records (one per outage).
- **Region-wide "emergency, schedule not applied"** banner ("Діють аварійні відключення — графік не застосовується"): this does **not** appear in the AJAX JSON as far as known. It lives in the challenged page HTML [READ: groove-max/ha-dtek-monitor#13]. svitlo.live exposes an `emergency` boolean per region (§3.3). Use that as the emergency signal.
- `show*` flags: `showTableFact=false` or `showTableSchedule=false` means DTEK currently hides the daily schedule. In that case, show "графік не публікується" rather than all-on.

#### 3.2.5 Address → group lookup (for settings) [LIVE]

DTEK KREM assigns groups **per house**. `data[house].sub_type_reason` is an array, normally one group (`["GPV2.2"]`), sometimes none or several. During a stabilization outage, only the affected group is listed [READ: NetZhizni]. Settings flow:
1. Settlement picker (from `getStreets` keys).
2. Street picker (from `streets[settlement]`).
3. House picker (keys of `getHomeNum.data`). Normalize Latin/Cyrillic look-alikes and spaces: DTEK has both `8а` and `8 а`.
4. Show the resolved group(s) and let the user confirm or override. Store `{settlement, street, house, group}`.
5. Always offer **"I know my group" → pick 1.1–6.2 directly**. This covers the mirror and svitlo fallbacks, which have no address data, and houses with no group listed.

#### 3.2.6 Update frequency

`fact.update` changed at 21:25 on 2026-11-18 and at 13:46 on 2026-11-19. Changes come irregularly, several times a day during active outage periods; tomorrow is published in the evening. Poll every **5–10 min** in the Worker, using the `updateFact` versioning so most polls return about 3 KB without fact/preset.

#### 3.2.7 Geo / datacenter IP

- From a **Ukrainian residential IP**: everything above works [LIVE].
- From a **non-UA datacenter IP**: a GET of `robots.txt` via a US-hosted fetcher returned the normal file, so there is **no edge-level geo-block** [LIVE]. A GET of `/ua/ajax` returned an empty or challenge-like page, the same as from UA [LIVE, inconclusive].
- **POST `/ua/ajax` from Cloudflare Workers egress: [NOT VERIFIED].** Indirect evidence:
  - `Baskerville42/outage-data-ua` scrapes all four DTEK sites from **GitHub-hosted Actions runners** (US/EU Azure IPs) with Playwright Chromium. Its sources sit in a secret, so a proxy can't be ruled out.
  - The svitlo.live API is itself a Cloudflare Worker serving fresh Kyiv-oblast data, but we can't tell where it fetches from.
  - Another integration (aavdberg/ha-dtek#28/#29) saw KREM pages return a "security page" or HTTP 403 for page GETs on some networks.
- **First implementation task:** deploy a 30-line test Worker that runs the §3.2.2 flow and logs status codes. If Imperva blocks Cloudflare egress, the options are:
  - **(a)** Have the **tablet itself** call DTEK. It is on a Ukrainian residential IP, but this only works through a native bridge in the Android wrapper, because a WebView page can't read cross-origin `/ua/ajax` responses (no CORS) or set `Origin`/`Referer`/`Cookie`.
  - **(b)** Rely on svitlo.live plus the mirror.
  - **(c)** Use a tiny relay at home (e.g. on a router or Raspberry Pi).

### 3.3 svitlo.live API (best aggregator fallback; covers Kyiv oblast) [LIVE]

- `GET https://dtek-api.svitlo-proxy.workers.dev/` (a Cloudflare Worker). CORS `*`. No key. Returns the whole country in one response, about 213 KB.
- Used by the HA integration `chaichuk/svitlo_live` (76★, default poll 600 s), whose parsers come from `yaroslav2901`. An older endpoint `https://svitlo-proxy.svitlo-proxy.workers.dev` covers other regions [READ].
- The author says the free server is near its limits and runs on donations. Fetch it **once per 10 min in our Worker and share the result**; don't let tablets hit it directly. Consider asking the author (Telegram `@serhii_chaichuk`) before relying on it.

Shape [LIVE]: `{"body":"<JSON string>","timestamp":1795091137257}`. Here `timestamp` is ms epoch of the snapshot, 2 min old at test time. The parsed `body`:
```json
{"date_today":"2026-11-19","date_tomorrow":"2026-11-20",
 "regions":[{"cpu":"kiivska-oblast","name_ua":"Київська область","name_en":"Kyiv Region","emergency":false,
             "schedule":{"2.2":{"2026-11-19":{"00:00":1,"00:30":1, "...":"...", "10:30":2,"11:00":2, "...":"...", "14:00":2,"14:30":1, "...":"...", "21:30":2, "...":"...", "23:30":2}}, "...":"12 groups 1.1..6.2"}},
            {"cpu":"kyiv", "...":"60 groups"}, {"cpu":"dnipro-dnem"}, {"cpu":"dnipro-cek"}, {"cpu":"odeska-oblast"}, "..."]}
```
- Values: `1` = on, `2` = off. These were the only values seen; there is **no "possible" state**.
- **No source update time** per region.
- Some regions carry old dates only, e.g. lvivska 2026-10-17, i.e. no current schedule. Check that the date equals today.
- `emergency: true` was set for dnipropetrovska-oblast at test time. This is the flag for "аварійні відключення".
- `cpu` values present: kiivska-oblast, odeska-oblast, dnipropetrovska-oblast, lvivska-oblast, poltavska-oblast, cherkaska-oblast, chernihivska-oblast, kharkivska-oblast, khmelnytska-oblast, ivano-frankivska-oblast, rivnenska-oblast, ternopilska-oblast, zakarpatska-oblast, zaporizka-oblast, zhytomyrska-oblast, kyiv, dnipro-dnem, dnipro-cek.

### 3.4 GitHub mirror `Baskerville42/outage-data-ua` [LIVE]

(The old name `outage-data-ukraine` now returns 404.)

- Raw files: `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/{kyiv,kyiv-region,dnipro,odesa}.json`
- Headers: CORS `*`, `Cache-Control: max-age=300`, `ETag` (so `If-None-Match` → 304). File size about 62 KB.
- Content: DTEK `fact` + `preset` **unchanged**, plus `regionId`, `regionAffiliation`, `lastUpdated` (ISO UTC), `lastUpdateStatus{status,ok,code,at,attempt}`, `meta{schemaVersion,contentHash}`. On a parse error only `lastUpdateStatus` changes (`code 422`).
- Updated by GitHub Actions (Playwright), triggered externally every 5 min. PNG images are also published per group.
- **Freshness at test time: stale.**
  - The last run was 09:18Z. No runs for 3+ h.
  - `kyiv-region.json` `lastUpdated 09:16Z`, `fact.update "18.11.2026 21:25"`, while DTEK itself already had `"19.11.2026 13:46"`.
  - It had a documented incident on 2026-10-30, publishing an empty schedule after midnight.
- Use it only as a **third-tier fallback**, always showing "оновлено HH:MM" and flagging staleness when `now - lastUpdated > 30 min`.
- `NetZhizni/ha-dtek-krem-outages` uses it as its backup too.

### 3.5 YASNO API: Kyiv city and Dnipro only [LIVE]

- `GET https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2/regions` [LIVE] returns `[{"id":25,"value":"Київ","dsos":[{"id":902,"name":"ТОВ «ДТЕК КИЇВСЬКІ ЕЛЕКТРОМЕРЕЖІ»"}]},{"id":3,"value":"Дніпро","dsos":[{"id":301,"name":"ДнЕМ"},{"id":303,"name":"ЦЕК"}]}]`. **No Kyiv oblast.**
- `GET .../shutdowns/regions/{regionId}/dsos/{dsoId}/planned-outages` [LIVE: 25/902 and 3/301]. `Cache-Control: private,max-age=120`. **No CORS header.**
```json
{"1.1":{"today":{"slots":[{"start":0,"end":450,"type":"NotPlanned"},{"start":450,"end":750,"type":"Definite"},{"start":750,"end":1050,"type":"NotPlanned"},
                          {"start":1050,"end":1320,"type":"Definite"},{"start":1320,"end":1440,"type":"NotPlanned"}],
                 "date":"2026-11-19T00:00:00+02:00","status":"ScheduleApplies"},
        "tomorrow":{"slots":[],"date":"2026-11-20T00:00:00+02:00","status":"WaitingForSchedule"},
        "updatedOn":"2026-11-18T20:30:01+00:00"},
 "2.1":{...}, "...":"Kyiv: 60 groups 1.1..60.1"}
```
  - `start`/`end` are minutes from local midnight.
  - Slot `type`: `Definite` = off, `NotPlanned` = on, `Possible` = maybe.
  - Day `status`: `ScheduleApplies`, `WaitingForSchedule`, `NoOutages`, `EmergencyShutdowns` (emergency: the schedule doesn't apply).
- `GET .../shutdowns/probable-outages?regionId=25&dsoId=902` [LIVE] gives the weekly "possible" template: `{"25":{"dsos":{"902":{"groups":{"1.1":{"slots":{"0":[...],..."6":[...]}}}}}}}`. Weekday `0` = Monday.
- Address lookup [LIVE for streets]: `.../addresses/v2/streets?regionId=25&dsoId=902&query=Хрещ` → `[{"id":906,"value":"вул. Хрещатик"},...]`. Then `.../addresses/v2/houses?regionId&dsoId&streetId&query`, then `.../addresses/v2/group?regionId&dsoId&streetId&houseId` [READ: denysdovhan/ha-yasno-outages].
- **YASNO is the cleanest API, but it does not cover Kyiv oblast.**

### 3.6 Normalized data model (adapters map into this)

```ts
type SlotState = 'on' | 'off' | 'maybe' | 'unknown';
type DayStatus = 'schedule' | 'no_outages' | 'waiting' | 'emergency' | 'hidden' | 'unknown';

interface OutageDay {
  date: string;            // 'YYYY-MM-DD' in Europe/Kyiv
  status: DayStatus;
  slots: SlotState[];      // length 48 (00:00, 00:30, ... 23:30). DST days: still 48 wall-clock slots; skip non-existent ones when rendering.
}

interface OutageFeed {
  provider: 'dtek-krem' | 'dtek-kem' | 'dtek-dnem' | 'dtek-oem' | 'yasno' | 'svitlo.live' | 'mirror' | string;
  region: string;          // 'kyiv-oblast'
  group: string;           // '2.2'  (no 'GPV' prefix)
  days: OutageDay[];       // today, tomorrow (if known)
  weekly?: Record<1|2|3|4|5|6|7, SlotState[]>;   // possible-outage template (DTEK preset / YASNO probable)
  emergency?: boolean;     // region-wide "аварійні відключення, графік не діє"
  addressOutage?: { kind: 'stabilization'|'emergency'|'planned'|'other'; reason: string; start?: string; end?: string };
  sourceUpdatedAt?: string;  // DTEK fact.update / YASNO updatedOn (ISO)
  fetchedAt: string;         // when the Worker got it
  stale: boolean;            // fetchedAt or sourceUpdatedAt too old / fallback used
}
```
Adapter mapping:
- **DTEK / mirror**: each hour value becomes 2 slots (table in §3.2.4). Day keys are unix midnight → Kyiv date. `fact.data=[]` or a missing group gives `status:'unknown'`, all slots `unknown`.
- **YASNO**: slot `i` takes the state of the interval containing minute `i*30+15`. Statuses map 1:1: `EmergencyShutdowns` → `emergency`, `WaitingForSchedule` → `waiting`.
- **svitlo.live**: `"HH:MM"` keys, `1` → on, `2` → off, missing → unknown. A date other than today/tomorrow is ignored. `emergency` flag → `OutageFeed.emergency`.
- **UI rule:** `unknown` is never rendered as "light on". Show "дані відсутні".

### 3.7 Coverage table (other oblasts, brief)

"Mirror" means a GitHub raw JSON in the DTEK `fact`/`preset` format, readable by the same DTEK adapter.

| Oblast | Operator | Best source(s) | Status |
|---|---|---|---|
| **Київська** | DTEK KREM | KREM `/ua/ajax`; svitlo `kiivska-oblast`; mirror `kyiv-region.json` | **LIVE** (mirror stale at test) |
| м. Київ | DTEK KEM | YASNO 25/902; KEM `/ua/ajax`; svitlo `kyiv`; mirror `kyiv.json` | LIVE |
| Дніпропетровська | DTEK DnEM / ЦЕК | YASNO 3/301 and 3/303; DnEM `/ua/ajax`; svitlo `dnipro-dnem`/`dnipro-cek`/`dnipropetrovska-oblast`; mirror `dnipro.json` | LIVE |
| Одеська | DTEK OEM | OEM `/ua/ajax`; svitlo `odeska-oblast`; mirror `odesa.json` | LIVE (bootstrap + streets) |
| Черкаська, Чернігівська, Харківська, Хмельницька, Полтавська, Рівненська, Тернопільська, Закарпатська, Житомирська, Івано-Франківська, Львівська | oblenergos | mirror `yaroslav2901/OE_OUTAGE_DATA` `data/<Name>.json` (e.g. `Zhytomyroblenergo.json`, `Lvivoblenerho.json`), plus svitlo.live | Repo LIVE, pushed 12:15Z today. Zhytomyr/Cherkasy fresh today; Lviv last 2026-10-17 |
| Запорізька | Zaporizhzhiaoblenergo | mirror `milkmann/gpv-zoe-zaporizhzhia` (fresh, 12:15Z today), OE_OUTAGE_DATA, svitlo `zaporizka-oblast` | LIVE |
| Вінницька | Vinnytsiaoblenergo | mirror `olnet93/gpv-voe-vinnytsia` / `vn-progr/gpv-voe-vinnytsia` | olnet93 **stale** (lastUpdated 2025-12-14); **vn-progr LIVE and fresh** (`lastUpdated` unix 1795094005, `fact.update "19.11.2026 15:13"`) |
| Миколаївська | Mykolaivoblenergo | official API `https://off.energy.mk.ua/api/v2/schedule/active` (+ `/api/outage-queue/by-type/3`, `/api/schedule/time-series`) | LIVE (200, schedule for 2026-11-19) |
| Львівська (official) | LOE | `https://api.loe.lviv.ua/api/menus?page=1&type=photo-grafic` | LIVE, but it is 3 MB of CMS menu JSON with HTML/images. Hard to parse; prefer OE_OUTAGE_DATA |
| Чернівецька, Сумська | – | svitlo.live old API only (per RobinCK/blackout). Not in the `dtek-api` worker response | not verified |
| Волинська, Кіровоградська, Херсонська | – | no known machine-readable source | – |
| (commercial) all | alerts.energy | `https://alerts.energy/api/v1` (OpenAPI at `/api/v1/openapi`, Bearer key, **paid subscription**) | 401 without key [LIVE] |

Useful reference code:
- `RobinCK/blackout` (`custom_components/blackout/regions.py` + `sources/*.py`): a 21-region registry with source fallbacks.
- `NetZhizni/ha-dtek-krem-outages` (`api.py`, `schedule.py`): the definitive KREM client.
- `denysdovhan/ha-yasno-outages` (`api/const.py`): YASNO endpoints.
- `chaichuk/svitlo_live`.

### 3.8 Recommended approach (outages)

1. **Phase 1, Kyiv oblast.** A Worker endpoint `/outages?region=kyiv-oblast&group=2.2` that works as a fallback chain:
   - **DTEK KREM `/ua/ajax`** (cache 5–10 min; `getStreets` cached 24 h)
   - → **svitlo.live** (cache 10 min)
   - → **mirror** (respect ETag, flag stale)

   Return the normalized `OutageFeed`, including `provider`, `sourceUpdatedAt` and `stale`.
2. If the Worker cannot reach DTEK (§3.2.7), make svitlo.live primary. Optionally add a native-bridge path on the tablet for DTEK.
3. Settings: region → (optional) address lookup via `getStreets`/`getHomeNum` → group. A manual group override is always available.
4. Later: YASNO adapter (Kyiv city, Dnipro), OE_OUTAGE_DATA adapter (same parser as DTEK), Mykolaiv adapter.

---

## 4. Cloudflare Worker sketch (free tier)

- Free tier: 100k requests/day and 10 ms CPU per request. Fine for one tablet polling every 15–30 s (about 3–6k requests/day). Use the **Cache API** (`caches.default`) for upstream caching. Avoid KV for hot data: the free tier allows only 1k writes/day.
- Secrets: `ALERTS_IN_UA_TOKEN` (wrangler secret). Optionally a shared `DASHPAD_KEY` header so randoms can't use the Worker.
- Routes:
  - `/weather?lat&lon`: optional pass-through.
  - `/alerts?ids=14,73,711`: alerts.in.ua → siren.pp.ua fallback.
  - `/outages?region&group`
  - `/regions/alerts`: the siren tree.
  - `/dtek/streets`
  - `/dtek/houses?city&street`
- Add `Access-Control-Allow-Origin` for the tablet origin.

---

## 5. Sources consulted

- Open-Meteo: https://open-meteo.com/en/terms, https://open-meteo.com/en/docs/geocoding-api
- met.no: https://api.met.no/doc/TermsOfService
- OpenWeatherMap: https://openweathermap.org/price
- alerts.in.ua: https://devs.alerts.in.ua/, https://alerts.in.ua/api-request, https://api.alerts.in.ua/v3/alerts/active.md
- ukrainealarm / siren: https://github.com/PaulAnnekov/uasiren (siren.pp.ua; 50 req/min), HA core `homeassistant/components/ukraine_alarm`, https://ajax.systems/ua/blog/air-alert-3-0/
- DTEK KREM client: https://github.com/NetZhizni/ha-dtek-krem-outages (`api.py`, `schedule.py`, `const.py`)
- Mirror: https://github.com/Baskerville42/outage-data-ua (README, `docs/incidents/2026-10-30-missing-kyiv-schedule.md`, `.github/workflows/scheduled.yml`)
- Multi-region registry: https://github.com/RobinCK/blackout
- YASNO: https://github.com/denysdovhan/ha-yasno-outages
- svitlo.live: https://github.com/chaichuk/svitlo_live
- Oblenergo mirrors: https://github.com/yaroslav2901/OE_OUTAGE_DATA
- Emergency-banner gap: https://github.com/groove-max/ha-dtek-monitor/issues/13
- KREM page 403 / security page: https://github.com/aavdberg/ha-dtek/issues/28, /29
- alerts.energy: https://alerts.energy/developers, https://alerts.energy/api/v1/openapi
