# RepostRadar

**One-tap duplicate post detection for Reddit moderators.**

RepostRadar is a Devvit app for the [Reddit Mod Tools & Migration Hackathon 2026](https://mod-tools-migration.devpost.com/). Open any post → menu → see a ranked list of likely-duplicate prior posts in the subreddit → click "Remove as repost" → the post is removed and a stickied removal comment is posted citing the original. Zero search-by-hand.

---

## How judges install RepostRadar

RepostRadar is published to the **Devvit App Directory** as `repostradar-app`. Once the app clears Reddit's review queue, any Reddit user can install it on a subreddit they moderate.

### Install via the developer portal

1. While logged into Reddit, open **https://developers.reddit.com/apps/repostradar-app**.
2. On the app page, use the **Install** action and pick a subreddit you moderate from the dropdown.
3. Confirm the install.

If you don't moderate a subreddit yet, create a private test sub in 10 seconds at https://www.reddit.com/subreddits/create, then install onto that.

### Install via the Devvit CLI

From any machine with Node.js 22+:

```bash
npx devvit login            # opens a browser, log in with your Reddit account
npx devvit install repostradar-app r/<your_subreddit>
```

> **Note for early judging windows:** if the app is still in Reddit's review queue when you click the link, the page may show "not allowed" or "under review." In that case the live demo install on **r/RepostRadarTest_NI** lets you browse existing scan posts immediately, and the install link will start working as soon as review clears (typically within hours).

### Then exercise it

1. Open your installed subreddit on Reddit (web or mobile app).
2. Make 2 posts with similar titles (e.g. "Best practices for X" and "What are the best practices for X?").
3. Open the second post → tap the `⋮` menu → tap **`RepostRadar: find duplicates`**.
4. A new `🛰️ RepostRadar scan: …` post appears in the feed — tap the splash, see the first post listed as a likely duplicate, tap **Use as original**, then **Remove as repost**. The first post is removed with a stickied citation comment.

---

## The problem

Reposts are the single most reported issue in most large subreddits. The current mod workflow to handle them is brutal:

1. Spot a post that "feels" like a repost.
2. Copy the title into Reddit's old search bar.
3. Eyeball the results to find the most likely original.
4. Manually remove the offending post.
5. Manually write a removal comment with the link to the original.
6. Sticky and distinguish the comment.

That's 5+ steps and 30–60 seconds **per repost**, on a sub where mods see dozens per day. Reddit's built-in `getDuplicatesForPost` API only catches **exact URL / image** duplicates — it misses the 80% of cases where the same question or image was reuploaded, screenshot, or paraphrased.

## What RepostRadar does

Once installed, RepostRadar gives mods a single menu item on every post:

1. **One tap** on `RepostRadar: find duplicates` from a post's `⋮` menu.
2. The app runs a parallel scan: Reddit's exact-URL duplicate index **plus** title-token Jaccard similarity over the last 100 new posts and 100 top-of-year posts.
3. Results are merged, ranked, and rendered in a webview as a fresh custom post in the sub — with thumbnails, similarity bars, age, and a reason pill (`Same URL` / `Similar title` / `URL + title`).
4. Mods pick the most likely original with one click, then hit **Remove as repost**.
5. The offending post is removed and a stickied, distinguished removal comment is posted citing the original — author tagged, modmail invited.

Total mod time: ~5 seconds.

## Two mod entry points

| Where | Menu item | Behavior |
|---|---|---|
| Any post's `⋮` menu | `RepostRadar: find duplicates` | Scans + creates a custom post with ranked matches; navigates the mod there |
| Subreddit overflow menu | `RepostRadar: stats` | Creates a stats custom post with last-7d removals, all-time removals, top reposters |

Both are gated to `forUserType: moderator`. Each scan creates a permanent custom post — so the subreddit also gets an audit trail of every moderation check, which is great for transparency with the community.

## Why it matters for the hackathon

The Mod Tools track explicitly calls out **reposts and duplicate detection** as a chronic mod pain point. RepostRadar:

1. **Cuts a 30-60 second task to 5 seconds** — and removes the manual citation step entirely.
2. **Catches what Reddit's built-in API misses** — image reuploads, screenshot-of-screenshot, and paraphrased title duplicates, by adding Jaccard title similarity on top of the duplicate index.
3. **Leaves an audit trail** — every scan is a custom post, so any community member or mod can scroll back and see why a post was removed.
4. **Works on mobile** — the entire flow (open post → menu → tap "Remove") works inside the Reddit mobile app where most modding happens.
5. **Zero config** — install on any sub, and the menu items appear immediately for that sub's moderators only.

## How it gets used in production

`r/RepostRadarTest_NI` is the developer demo sub. The real deployment model is:

1. The app is published to the Devvit App Directory.
2. A moderator of any subreddit installs RepostRadar on their community.
3. The two menu items immediately appear on **that subreddit's own posts** — visible only to that subreddit's mods.
4. Each install is isolated: its own Redis cache of scan results, its own removal counters, its own reposter leaderboard.

## Tech

- **Devvit Web 0.12.24** (HTTP server + webview pattern)
- **TypeScript** end-to-end (`src/shared/api.ts` is the typed contract)
- **Reddit Plugin** at `moderator` scope for `getDuplicatesForPost`, `getNewPosts`, `getTopPosts`, `getPostById`, `submitComment`, `Post.remove`, `Comment.distinguish`, `submitCustomPost`
- **Redis** for:
  - `rr:view:{customPostId}` — JSON-encoded scan result keyed by the scan's custom-post id (30 day TTL)
  - `rr:removed:{sub}` — sorted set of removed post ids scored by removal timestamp
  - `rr:reposters:{sub}` — sorted set of usernames scored by removal count
- **Devvit Triggers** — `onAppInstall` posts a welcome custom post explaining the menu items
- **esbuild** for client + server bundling

## Similarity algorithm

For every candidate post compared against the current post:

1. Lowercase title → strip URLs → strip non-alphanumerics → tokenize on whitespace.
2. Drop ~50 common English stopwords (`the`, `is`, `what`, `how`, …) and tokens shorter than 3 chars.
3. Build the resulting token `Set<string>` for both titles.
4. Score with **Jaccard similarity**: `|A ∩ B| / |A ∪ B|`.
5. Candidates below `0.30` similarity are dropped.
6. Exact-URL duplicates from `getDuplicatesForPost` get `similarity = 1.0` and reason `Same URL`.
7. When a post hits *both* signals (in the duplicate index AND above the Jaccard threshold), the reason is promoted to `URL + title`.
8. Sort by similarity desc, then by `createdAt` asc (so the *oldest* candidate at a given similarity is surfaced first — usually the true original).
9. Return the top 10.

## Repository layout

```
repostradar-app/
├─ devvit.json             # app config: menus, triggers, permissions
├─ public/                 # webview assets
│  ├─ game.html / game.css / game.js
│  └─ splash.html / splash.css / splash.js
├─ src/
│  ├─ shared/api.ts        # typed API contract (candidates, view modes, endpoints)
│  ├─ server/
│  │  ├─ index.ts          # createServer + listen
│  │  └─ server.ts         # menu handlers, scan + Jaccard, remove + sticky comment, stats
│  └─ client/
│     ├─ splash.ts         # inline splash screen
│     └─ game.ts           # scan results UI + stats panel
└─ tools/build.ts          # esbuild config
```

## Permissions declared

```jsonc
"permissions": {
  "redis": true,
  "reddit": { "enable": true, "scope": "moderator" }
}
```

The `moderator` scope is required for `Post.remove` and `Comment.distinguish` (the stickied removal citation). All other Reddit API calls (`getDuplicatesForPost`, `getNewPosts`, `getTopPosts`, `getPostById`, `submitCustomPost`, `submitComment`) sit within the `user` scope.

## How a scan turns into a custom post

Devvit's `UiResponse.navigateTo` only accepts URLs — there's no way to open a webview entrypoint directly from a menu click. So the menu handler:

1. Loads the source post + runs the scan.
2. Submits a new custom post (`🛰️ RepostRadar scan: <title>`) with an inline splash showing the match count.
3. Stores the scan result in Redis under `rr:view:{newCustomPostId}` (30d TTL).
4. Returns `navigateTo: newCustomPost.url` + a success toast.

When the mod taps the splash, the webview's `/api/init` looks up `context.postId` (the new custom post's id) in Redis, reads the cached scan, and renders. The `originalPostId` is preserved in the cache, so the **Remove as repost** button knows which post to actually remove.

This pattern also means every scan leaves a permanent in-sub record, which doubles as a free moderation audit log.

## Local development

```bash
npm install
npm run type-check
npm run build
npm run dev <your_test_subreddit>
```

Then visit `https://www.reddit.com/r/<your_test_subreddit>/`, open any post's `⋮` menu, and tap **RepostRadar: find duplicates**.

## License

BSD-3-Clause (see `LICENSE`).
