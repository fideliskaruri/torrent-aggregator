# Home categories plan

Owner request (1 Oct 16:02): "The home page has been looking random most of the time. Let's work on
showing different categories of films and all that." Tracker: FEAT-29 (OPS-523 plan, OPS-524 server,
OPS-525 web).

## 1. Who uses home, and their journeys

Home (`/`) is the first screen of a home-lab download app. Two people use it.

- **Owner**: on a desktop over remote desktop or on a phone, a few times a week, looking for something
  to download tonight. Short sessions, low time pressure.
- **Requester** (a trusted friend): mostly on a phone, occasionally. Same UI; title pages offer
  Request instead of Download, and engine details are stripped (`RequesterCatalogProjectionMiddleware`).

### J1. Owner glance (5 seconds): "anything new worth getting?"
1. Opens `/`. Needs: the Downloaded rail first (what is already here), then what is new and popular.
2. Scans the first three rails: Popular films, Popular series, Anime this season. Needs: the same
   rows as this morning, in the same order, so a second look is quick.
3. Spots a title and opens the card; the title page has Download. Done.

### J2. Owner explore: "I want a comedy film"
1. Opens `/`, presses **Films** in the type switch. Needs: films only, popular, new and top rated
   first, then one rail per genre.
2. Presses the **Comedy** chip (or "See all" on the Comedy rail). Needs: a page of comedy films
   (up to 48), with its own URL (`/?type=films&genre=comedy`) so Back and reload keep it.
3. Opens a card, reads the title page, downloads. Back returns to the genre page.

### J3. Requester browse and request
1. Opens the shared link on a phone. Sees the same home, without Downloaded internals.
2. Switches to **Series** or **Anime**, scrolls rails, opens a card.
3. Presses Request on the title page. Done.

Hard moments: first run (nothing cached), a source down (TMDB key missing, Cinemeta timing out),
an empty genre rail, a slow cold start, long titles, keyboard-only use, 390 px phones.

## 2. Why home looks random today (evidence)

Evidence: `files\homecats\owner3930-browse-{1,2,3}.json` (3930, read-only GETs),
`files\homecats\stable-catalog-providers.txt`, live provider samples in this session.

1. **Two rails only, neither is a category.** 3930 returns `trending-now` (24) and `popular-series`
   (24) and nothing else (no Downloaded and no Because rail on that data). "Trending now" is
   Cinemeta's IMDb *Popular movies* list: on 1 Oct it starts with Unabomber, The Love Hypothesis,
   Backrooms, Toy Story 5, The End of Oak Street, Obsession, mostly 2026 titles still in cinemas.
   It is not labelled as films, mixes in unreleased titles and has no genre or type structure.
   (`BrowseService.BuildDiscoveryRailsAsync`, `CatalogService.RunRefreshAsync`.)
2. **The lists churn every hour.** `CatalogRefreshWorker` re-fetches every hour
   (`CatalogService.CatalogTtl = 1h`) whether or not anyone visits, and `EnsureFreshAsync` also
   refreshes on any request older than an hour. IMDb's popularity chart moves daily, so rail order
   and membership change between morning and evening loads.
3. **The provider flips silently.** Each hourly refresh writes the `trending` / `popular`
   partitions from whichever source answers first: Cinemeta, else TMDB `trending/week`, else the
   apibay torrent top-100 charts (`RunRefreshAsync`, lines ~414-450). A Cinemeta timeout (8 s) at
   one refresh replaces the whole rail with a different provider's list, and with the torrent chart
   fallback, with whatever is being pirated that hour. Nothing keeps the last good list.
4. **The hero is "first card of the first rail".** With no Downloaded rail (3930 today),
   `pickHeroItem` features `trending-now[0]`, so the largest thing on the page is whatever IMDb
   ranked first that hour (Unabomber today).
5. Within one hour the payload is stable: three loads on 3930 at 13:08 returned identical rails and
   order (92, 12, 10 ms). There is no shuffle or random seed anywhere in the path; the randomness is
   the source, its churn and its fallbacks.

What the providers can supply (checked live 1 Oct):

| Category | Without TMDB key | With TMDB key |
|---|---|---|
| Popular films / series | Cinemeta `movie/top`, `series/top` (50 each) | TMDB `trending/{movie,tv}/week` |
| New films / series | Cinemeta `{movie,series}/year/genre=2026` | TMDB discover, released in the last 90 days at home (types 4,5) / first aired in the last 180 days |
| Top rated films / series | none reliable (Cinemeta "Featured" is not a rating sort) | TMDB discover `vote_average.desc` with a vote floor |
| Genres (films, series) | Cinemeta `top/genre=<Genre>` (19 film, 22 series genres) | TMDB discover `with_genres` |
| Anime this season, trending, top rated, genres | AniList (keyless) | AniList |
| Now in cinemas | Cinemeta lists them inside Popular; no gate without TMDB | TMDB `now_playing` (not used: not downloadable) |
| "Popular on Netflix" style | none | TMDB `with_watch_providers` + region (deferred) |
| New episodes of your shows | TVmaze schedule per library show | same (deferred) |
| Because you downloaded X | existing `because-you-are-watching` rail (library seed) | TMDB recommendations |
| Collections / franchises | none | TMDB collections (deferred) |

## 3. The rail set and its order

One config list, `HomeRails.All` (server), drives every rail: id, title, kind (films, series,
anime), optional genre, and an ordered list of feeds (TMDB, Cinemeta, AniList). The web never
hardcodes rails or genres; it renders what the payload names.

**All** (default `/`), in this order:
1. Downloaded (personal, live)
2. Because you're watching X (when the library has a seed)
3. Popular films
4. Popular series
5. Anime this season
6. New films
7. New series
8. Trending anime
9. Top rated films (TMDB key only)
10. Top rated series (TMDB key only)
11. Top rated anime
12. In cinemas (films still in their theatrical window, see "Available now first" below)

**Films** (`/?type=films`): Popular films, New films, Top rated films, then genre rails: Action,
Comedy, Drama, Thriller, Horror, Science fiction, Crime, Romance, Family, Documentary, then
In cinemas last.

**Series** (`/?type=series`): Popular series, New series, Top rated series, then: Drama, Comedy,
Crime, Action and adventure, Sci-fi and fantasy, Mystery, Documentary, Reality.

**Anime** (`/?type=anime`): Anime this season, Trending anime, Top rated anime, then: Action,
Romance, Fantasy, Comedy, Slice of life, Sci-fi, Sports, Mystery.

**Genre page** (`/?type=films&genre=comedy`): one rail's titles as a grid, up to 48.

Stability rules:
- Rails refresh **once per local day** (the stored rows' refresh date is before today), in the
  background. Within a day the same request returns the same rails in the same order; only the
  Downloaded rail and the cinema chips are live.
- **The provider is sticky.** A refresh writes a rail only when its feed answered with at least 6
  titles. If the rail's current provider fails, yesterday's rows stay. The next feed is used only
  when the rail has no rows, or the rail's preferred provider changed (a TMDB key was added or
  removed).
- No torrent-chart fallback for home rails: a pirate top-100 is not a category.
- Nothing is shuffled. Order is the provider's order at the daily refresh.

**Available now first** (owner follow-up, 1 Oct). Home is for finding something to get, so rows
lead with titles that can be fetched now. One rule decides, the card gate that draws the
"In cinemas" and "Coming" chips (`ReleaseGates.Gate` on the server, `browseReleaseGate` on the
web), applied in `BrowseService.LeadWithAvailable`:
- A film in cinemas leaves Popular, New, Top rated, genre and Because rows for one In cinemas row,
  last on All and Films. Genre pages, Series and Anime have no In cinemas row.
- A film not out yet leaves home.
- A series or anime that has not aired yet moves to the end of its row, so Anime this season
  leads with what has started.
- The hero is the first title that passes the same gate: Because you're watching first, then the
  rows in page order, Downloaded last. It is never In cinemas, Coming or Unreleased, and it only
  changes when the rows do (daily).

## 4. Type switch and genres

- A type switch (All, Films, Series, Anime) sits at the top of home. Each option is a link
  (`/?type=films`), so Back, reload and sharing keep the view.
- In a type view, genre chips follow the switch: "All genres" plus one chip per genre rail of that
  type, from `payload.genres`. Only genre rails get a "See all" link in their heading (to the same
  genre page). Popular, New and Top rated rails do not: the type switch already leads to them.
- The genre page has the same switch and chips, the genre chip marked current
  (`aria-current="page"`; the type chip gets `aria-current="true"`).
- The All view shows the switch only: genres belong to a type, so chips appear once a type is picked.

## 5. Keyless fallback

Each rail lists its feeds in order. TMDB feeds are skipped without a usable key. Without a key:
- Films and series: Popular, New and every genre come from Cinemeta. Top rated films and Top
  rated series have no keyless feed, so they are omitted (not shown empty).
- Anime: all rails come from AniList either way.
- In cinemas without TMDB release dates (no key, or TMDB lists none for the film): a film counts
  as in cinemas for 21 days after its release date (`HomeRelease.UncheckedCinemaDays`). It is a
  trade-off with no clear winner. Against TMDB's evidence for 121 home films on 1 Oct, 21 days
  caught 12 of the 24 films still in cinemas and wrongly gated 16; 45 days caught 17 and wrongly
  gated 34 (`shots\api\keyed2\calibration.txt`). So without a key, long cinema runs (The Odyssey,
  digital on 15 Nov) still lead rows, and a streaming original released in the last 21 days
  (Unabomber, Netflix) shows as In cinemas until it is 22 days old. With a key, TMDB decides.

## 6. Caching and performance budget

- Rows live in `CatalogEntry`, one partition per rail id (`Source = rail id`, `SeedTitle = null`).
  Each rail stores up to 96 titles: TMDB feeds read 5 pages of 20, Cinemeta and AniList read 2
  pages of 50 (the second page counts only behind a non-empty first page), de-duplicated by
  provider id.
- `GET /api/browse` reads every rail of the view in **one** indexed query, then maps cards. Budget:
  under 150 ms warm for All, under 300 ms for a type view or genre page, and a cold first visit
  capped at 12 s (existing `ColdStartBudgetMs`).
- A rail is **stale** when it has no rows, its rows are from an earlier local day, or its
  preferred provider changed (TMDB key added or removed). Freshness is read from the rail's
  rank-0 row, so no extra state table is needed.
- At request time only the requested view's rails are checked. Stale rails that still have rows
  refresh in the background and the old rows are served. Rails with **no rows** (first visit, new
  rail, key just added) are fetched before answering, up to the 12 s cap; a rail still empty after
  that fills on a later load.
- Refresh is per-rail single-flight with at most 4 provider calls at once. A rail whose feeds all
  fail backs off for 30 minutes.
- The hourly worker keeps ticking and refreshes every stale rail across all views, so the first
  visit of a day is usually already warm.
- Measured on the memtest instance (1 Oct): warm loads 8 to 44 ms keyless and 8 to 110 ms keyed,
  for every view and genre page. Cold All took 3.4 s keyless and the first Films visit 2.8 s
  (all 12 rails filled). The first load after adding the key took 1.8 s, with the featured rails
  already from TMDB.

## 7. Empty rails

- A rail with no rows is omitted by the server (`DistinctAcrossRails` drops empties). Without a
  key, Top rated films and Top rated series have no feed and are simply absent.
- A rail is written only when its feed returns at least 6 titles; a thinner answer counts as a
  failure and the old rows stay.
- De-duplication walks the rails in order. Each rail claims only as many titles as it shows (24 on
  a rail, 48 on a genre page; personal rails claim all) and then stops, so an early rail cannot
  starve a later one. Before this cap, keyless Thriller showed 5 cards; now every rail is full.
- A genre page with no titles shows "<Genre> <type> could not load", Try again, and
  "Meanwhile: See all <type>". A type view with no rails shows "<Type> could not load" with
  "Meanwhile: See everything".
- An unknown type or genre gets a 400 with a plain message ("Home does not have that category.
  Pick one from the list above."), shown in the error state with Try again.
- The type switch and, when known, the genre chips stay on screen in every state, so the user can
  always move to another category.

## 8. Requester view

Same rails, same switch and chips (the walk found identical rail ids for owner and requester).
Catalog cards are links in both views; the title page carries Request (J3 found one Request
control). The Downloaded rail is unchanged by design (OPS-515). The projection middleware already
strips engine fields on `/api/browse`; the new fields (`kind`, `genre`, `genres`, `view`) are
plain catalog data.

## 9. Wireframes

390 px (phone), All view:
```
+--------------------------------------+
| TorrentFlow              [search][=] |  header (fixed)
+--------------------------------------+
| [All][Films][Series][Anime]          |  type switch (scrolls with page)
+--------------------------------------+
|  HERO poster/backdrop                |
|  Downloaded / Popular films          |
|  Title            [Details]          |
+--------------------------------------+
| Downloaded                           |
| [poster][poster][pos>  (swipe)       |  each rail scrolls sideways
| Popular films                        |
| [poster][poster][pos>                |
| Popular series ...                   |
| Anime this season ...                |
+--------------------------------------+
| [Browse][Library][Downloads][Alerts][More] |  bottom nav (fixed)
+--------------------------------------+
```
390 px, Films > Comedy:
```
+--------------------------------------+
| [All][Films*][Series][Anime]         |
| [All genres][Action][Comedy*][Dr>    |  chips scroll sideways
| [poster][poster][poster]             |  grid, 3 per row, no hero
| [poster][poster][poster]             |
+--------------------------------------+
```
1280 px, Films view:
```
+------------------------------------------------------------------------+
| TorrentFlow  Browse Library Downloads ...    [Search] [View as requester]|
| [All][Films*][Series][Anime]                                            |
| [All genres][Action][Comedy][Drama][Thriller][Horror][Science fiction]..|
| HERO (backdrop, title, Details)                                         |
| Popular films                                                           |
| [p][p][p][p][p][p][p][>                                                 |
| New films ...   Top rated films ...                                     |
| Action films                                              See all       |
| [p][p][p][p][p][p][p][>                                                 |
+------------------------------------------------------------------------+
```
Scroll plan: one page scroller; each rail and the chip row scroll sideways inside themselves.

## 10. Proof matrix

Evidence root: `D:\code\memtest\homecats\shots` (`api\keyless`, `api\keyed`, `keyless`, `keyed`).

| # | Check | How | Result | Evidence |
|---|---|---|---|---|
| P1 | Rails stable across loads | 4 loads each of All, 3 types and 3 genre pages, keyless and keyed; compare ids and card order | Identical in every view, both runs | `api\*\summary.txt`, per-load JSON |
| P2 | Keyless set | instance without a TMDB key | All has 7 rails (no Top rated films or series); films and series from Cinemeta, anime from AniList; every rail 24 | `api\keyless` |
| P3 | Keyed set | same data with `TMDB_API_KEY` | All has 9 rails; featured rails from TMDB on the first load, genre rails switched after one background refresh | `api\keyed` |
| P4 | No duplicates | every card's work once per payload and per page | None in any view, both runs | `summary.txt`, `walk.txt` |
| P5 | Type and genre views | `?type=films`, `?type=films&genre=comedy`, bad type or genre | Films 13 rails, Series 11, Anime 11; genre pages 48; bad type or genre gives 400 | `summary.txt`, `api\keyed\bad-requests.txt` |
| P6 | Warm latency | timings of each load | 8 to 44 ms keyless, 8 to 110 ms keyed; cold All 3.4 s | `summary.txt` |
| P7 | UI owner and requester | headless Edge at 390, 768, 1280; All, Films, Anime, Films > Comedy; both roles; both runs | All shots taken; J2 and J3 walked; "View as requester" toggle works | `keyless\*.png`, `keyed\*.png`, `walk.txt` |
| P8 | Copy rules | page text has no em dash; no sideways scroll; targets 44 px at 390 | No problems found | `walk.txt` (PROBLEMS lists only the expected 400 and the aborted request) |
| P9 | Keyboard | Tab to a type chip, a genre chip and See all | All reached; focus ring visible | `focus-*.png` |
| P10 | Empty and error | unknown genre (400), empty genre (mocked), API down (aborted) | Named error and empty states with Try again; chips stay | `state-*.png` |
| P11 | Available now first (follow-up) | `tools\gates.py` applies the card gate to every card of All, 3 types and 2 genre pages; the walk checks the hero and each row's lead card | No film in cinemas or not out yet outside In cinemas; no row led by a gated card; In cinemas last on All and Films only; unaired anime at the end of Anime this season | `api\keyless2\gates.txt`, `api\keyed2\gates.txt`, `keyless2\walk.txt`, `keyed2\walk.txt` |
| P12 | Hero available now (follow-up) | headless walk, both roles, 3 widths, both runs | Hero never gated: keyless Backrooms, keyed Unabomber (Popular films; out on Netflix per TMDB); Anime hero has aired | `keyless2\owner-all-1280.png`, `keyed2\owner-all-1280.png`, `walk.txt` |
| P13 | Stable after the follow-up | 4 loads of each view, both runs | Identical in every view, no duplicates | `api\keyless2\summary.txt`, `api\keyed2\summary.txt` |

## 11. Critic findings and resolutions

One critic pass (gpt-5.6-luna) over this plan and the code paths it touches. Its 13 findings:

| # | Finding | Resolution |
|---|---|---|
| C1 | The requester still sees the Downloaded rail. | Kept by design (OPS-515: requesters see what is already on the server). The new payload fields are plain catalog data, so the projection middleware needs no change. |
| C2 | One global cold start would make the first visit wait for every rail. | Fixed: request-time refresh covers only the requested view's rails, and only rails with no rows block, up to 12 s. Measured: cold All 3.4 s, first Films 2.8 s. |
| C3 | Old `trending` / `popular` partitions and the related-title pool would linger. | Fixed: a one-time delete of the old partitions. The related pool reads the new rails (`HomeRails.RelatedPool`). |
| C4 | Daily refresh and sticky provider need state that is not persisted. | Freshness and provider come from each rail's rank-0 row. A rail is written only with at least 6 titles, so a thin answer never replaces a good list. Adding or removing the key is detected as a provider change. |
| C5 | No budget for provider calls or response time. | Budgets in section 6: 4 concurrent fetches, per-rail single-flight, 30-minute back-off, hourly worker for the rest, home-release checks limited to the last 180 days. Measured timings recorded. |
| C6 | TMDB discover queries need explicit filters or they return noise. | Every discover query sets a vote floor and `include_adult=false`. New films add region US, release types 4 and 5 (digital and physical) and a 90-day window. New series use a 180-day first-air window. Series queries exclude talk shows and anime. Popular uses `trending/week`. 5 pages, de-duplicated by TMDB id. |
| C7 | Cinemeta genre names differ per type and lists can be short. | The generic `top` catalog with explicit per-type genre labels in `HomeRails`, 2 pages. Under 6 titles counts as a failure. |
| C8 | AniList needs season, year and genre handled, and rate limits respected. | `BrowseAsync` takes sort, season, year, genre and page, with a 10 s timeout. 2 pages per rail, about 22 calls a day. |
| C9 | Cross-rail de-duplication could erase later categories. | Fixed: 96 stored rows per rail, and each rail claims only what it shows. Every rail now shows 24 (keyless Thriller showed 5 before). |
| C10 | The web must not hardcode rail or genre ids. | Chips and See all links come from the payload. Only the four type routes are known to the web (`lib/browse/views.ts`). |
| C11 | Query plumbing and the empty and error states were underspecified. | `type` and `genre` query params with a plain 400 message. The nav renders in every state. A named empty state per type or genre links to a wider view. |
| C12 | The genre grid and accessibility. | `TitleCard` gained a grid layout. Navs carry `aria-label` and `aria-current`. Targets are 44 px on phones, and the focus ring is visible (P9). |
| C13 | The hero would still change hourly. | The hero comes from the rows, which are now stable for the day. Genre pages have no hero. Since the owner follow-up it is the first title available now (Because first), never one in cinemas or not out yet. |
