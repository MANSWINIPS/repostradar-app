import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { context, reddit, redis } from "@devvit/web/server";
import type {
  PartialJsonValue,
  TriggerResponse,
  UiResponse,
} from "@devvit/web/shared";
import type { OnAppInstallRequest } from "@devvit/shared/types/triggers.js";
import type { Post } from "@devvit/reddit";
import {
  ApiEndpoint,
  MatchReason,
  ViewMode,
  jaccard,
  normalizeTitleTokens,
  type CurrentPost,
  type DuplicateCandidate,
  type InitResponse,
  type RemoveRequest,
  type RemoveResponse,
  type ReposterEntry,
  type StatsResponse,
} from "../shared/api.ts";

// ---------- HTTP entrypoint ---------------------------------------------------

export async function serverOnRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  try {
    await onRequest(req, rsp);
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`;
    console.error(msg);
    writeJSON<ErrorResponse>(500, { error: msg, status: 500 }, rsp);
  }
}

async function onRequest(
  req: IncomingMessage,
  rsp: ServerResponse,
): Promise<void> {
  const url = req.url;
  if (!url || url === "/") {
    writeJSON<ErrorResponse>(404, { error: "not found", status: 404 }, rsp);
    return;
  }
  const endpoint = stripQuery(url) as ApiEndpoint;
  let body: PartialJsonValue | UiResponse | TriggerResponse | ErrorResponse;
  switch (endpoint) {
    case ApiEndpoint.Init:
      body = await onInit();
      break;
    case ApiEndpoint.Remove:
      body = await onRemove(req);
      break;
    case ApiEndpoint.Stats:
      body = await onStats();
      break;
    case ApiEndpoint.MenuScanPost:
      body = await onMenuScanPost();
      break;
    case ApiEndpoint.MenuStats:
      body = await onMenuStats();
      break;
    case ApiEndpoint.TriggerAppInstall:
      body = await onAppInstall(req);
      break;
    default:
      endpoint satisfies never;
      body = { error: "not found", status: 404 };
      break;
  }
  const status =
    body && typeof body === "object" && "status" in body
      ? (body as ErrorResponse).status
      : 200;
  writeJSON(status, body as PartialJsonValue, rsp);
}

type ErrorResponse = { error: string; status: number };

// ---------- Redis keys --------------------------------------------------------

/**
 * Each "find duplicates" / "stats" menu click creates a custom post.
 * `rr:view:{customPostId}` stores what to render in that custom post's webview.
 */
const k = {
  view: (customPostId: string) => `rr:view:${customPostId}`,
  removed: (sub: string) => `rr:removed:${sub}`,
  reposters: (sub: string) => `rr:reposters:${sub}`,
} as const;

type ScanView = {
  mode: typeof ViewMode.Scan;
  originalPostId: string;
  current: CurrentPost;
  candidates: DuplicateCandidate[];
  scannedAtMs: number;
};

type StatsView = {
  mode: typeof ViewMode.Stats;
  scannedAtMs: number;
};

type ViewData = ScanView | StatsView;

const VIEW_TTL_SECONDS = 30 * 24 * 60 * 60; // 30d retention

// ---------- Context helpers ---------------------------------------------------

function getSubredditName(): string {
  const sub = context.subredditName;
  if (!sub) throw Error("no subreddit context");
  return sub;
}

async function isCurrentUserModerator(sub: string): Promise<boolean> {
  const username = context.username;
  if (!username) return false;
  try {
    const user = await reddit.getUserByUsername(username);
    if (!user) return false;
    const perms = await user
      .getModPermissionsForSubreddit(sub)
      .catch(() => null);
    return perms != null && perms.length > 0;
  } catch {
    return false;
  }
}

// ---------- Scanning ----------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.3;
const MAX_CANDIDATES_OUT = 10;
const NEW_POSTS_SCAN_LIMIT = 100;
const TOP_POSTS_SCAN_LIMIT = 100;

function ageLabel(createdAtMs: number, nowMs: number = Date.now()): string {
  const delta = Math.max(0, nowMs - createdAtMs);
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (delta < hour) return `${Math.max(1, Math.floor(delta / min))}m ago`;
  if (delta < day) return `${Math.floor(delta / hour)}h ago`;
  if (delta < 30 * day) return `${Math.floor(delta / day)}d ago`;
  if (delta < 365 * day) return `${Math.floor(delta / (30 * day))}mo ago`;
  return `${Math.floor(delta / (365 * day))}y ago`;
}

function pickThumbnail(p: Post): string | null {
  const t = p.thumbnail;
  if (!t) return null;
  const candidate = (t as { url?: string }).url;
  if (typeof candidate !== "string") return null;
  if (!candidate.startsWith("http")) return null;
  return candidate;
}

function toCurrentPost(p: Post): CurrentPost {
  return {
    id: p.id as unknown as string,
    title: p.title,
    authorName: p.authorName,
    url: p.url,
    permalink: p.permalink,
    thumbnail: pickThumbnail(p),
    createdAtMs: p.createdAt.getTime(),
    numComments: p.numberOfComments,
    score: p.score,
    removed: p.removed,
  };
}

function toCandidate(
  p: Post,
  similarity: number,
  reason: MatchReason,
): DuplicateCandidate {
  const createdAtMs = p.createdAt.getTime();
  return {
    id: p.id as unknown as string,
    title: p.title,
    authorName: p.authorName,
    url: p.url,
    permalink: p.permalink,
    thumbnail: pickThumbnail(p),
    createdAtMs,
    ageLabel: ageLabel(createdAtMs),
    score: p.score,
    numComments: p.numberOfComments,
    similarity,
    reason,
  };
}

async function collectListing(
  listing: { all: () => Promise<Post[]> },
  cap: number,
): Promise<Post[]> {
  try {
    const all = await listing.all();
    return all.slice(0, cap);
  } catch (err) {
    console.warn(
      `repostradar: listing fetch failed: ${
        err instanceof Error ? err.message : err
      }`,
    );
    return [];
  }
}

async function scanForDuplicates(
  sub: string,
  current: Post,
): Promise<DuplicateCandidate[]> {
  const currentTokens = normalizeTitleTokens(current.title);
  const currentId = current.id as unknown as string;

  const exactDups = await collectListing(
    reddit.getDuplicatesForPost({
      postId: current.id,
      subredditName: sub,
      limit: 25,
      pageSize: 25,
    }),
    25,
  );

  const [newPosts, topPosts] = await Promise.all([
    collectListing(
      reddit.getNewPosts({
        subredditName: sub,
        limit: NEW_POSTS_SCAN_LIMIT,
        pageSize: 100,
      }),
      NEW_POSTS_SCAN_LIMIT,
    ),
    collectListing(
      reddit.getTopPosts({
        subredditName: sub,
        timeframe: "year",
        limit: TOP_POSTS_SCAN_LIMIT,
        pageSize: 100,
      }),
      TOP_POSTS_SCAN_LIMIT,
    ),
  ]);

  const byId = new Map<string, DuplicateCandidate>();

  for (const p of exactDups) {
    const pid = p.id as unknown as string;
    if (pid === currentId) continue;
    const sim = Math.max(
      1.0,
      jaccard(currentTokens, normalizeTitleTokens(p.title)),
    );
    byId.set(pid, toCandidate(p, sim, MatchReason.ExactUrl));
  }

  for (const p of [...newPosts, ...topPosts]) {
    const pid = p.id as unknown as string;
    if (pid === currentId) continue;
    const sim = jaccard(currentTokens, normalizeTitleTokens(p.title));
    if (byId.has(pid)) {
      if (sim >= SIMILARITY_THRESHOLD) {
        const existing = byId.get(pid)!;
        existing.reason = MatchReason.Both;
        existing.similarity = Math.max(existing.similarity, sim);
      }
      continue;
    }
    if (sim < SIMILARITY_THRESHOLD) continue;
    byId.set(pid, toCandidate(p, sim, MatchReason.TitleSimilarity));
  }

  const ranked = Array.from(byId.values()).sort((a, b) => {
    if (a.similarity !== b.similarity) return b.similarity - a.similarity;
    return a.createdAtMs - b.createdAtMs;
  });
  return ranked.slice(0, MAX_CANDIDATES_OUT);
}

// ---------- Menu handlers ----------------------------------------------------

async function onMenuScanPost(): Promise<UiResponse> {
  const sub = getSubredditName();
  const originalPostId = context.postId;
  if (!originalPostId) {
    return {
      showToast: { text: "No post in context.", appearance: "neutral" },
    };
  }
  const isMod = await isCurrentUserModerator(sub);
  if (!isMod) {
    return {
      showToast: {
        text: "Only moderators can run RepostRadar.",
        appearance: "neutral",
      },
    };
  }

  const current = await reddit.getPostById(originalPostId);
  const candidates = await scanForDuplicates(sub, current);
  const scannedAtMs = Date.now();
  const currentSerialized = toCurrentPost(current);

  const titlePreview =
    current.title.length > 70
      ? `${current.title.slice(0, 70)}…`
      : current.title;
  const matchCount = candidates.length;
  const description =
    matchCount === 0
      ? "No likely duplicates found."
      : matchCount === 1
        ? "1 likely duplicate found."
        : `${matchCount} likely duplicates found.`;

  const newPost = await reddit.submitCustomPost({
    subredditName: sub,
    title: `🛰️ RepostRadar scan: ${titlePreview}`,
    splash: {
      appDisplayName: "RepostRadar",
      buttonLabel: "Open results",
      heading: `${matchCount} match${matchCount === 1 ? "" : "es"} found`,
      description,
    },
  });

  const view: ScanView = {
    mode: ViewMode.Scan,
    originalPostId,
    current: currentSerialized,
    candidates,
    scannedAtMs,
  };
  await redis
    .set(k.view(newPost.id as unknown as string), JSON.stringify(view), {
      expiration: new Date(scannedAtMs + VIEW_TTL_SECONDS * 1000),
    })
    .catch(() => undefined);

  return {
    showToast: {
      text:
        matchCount === 0
          ? "RepostRadar: no duplicates found."
          : `RepostRadar: ${matchCount} match${matchCount === 1 ? "" : "es"}.`,
      appearance: "success",
    },
    navigateTo: newPost.url,
  };
}

async function onMenuStats(): Promise<UiResponse> {
  const sub = getSubredditName();
  const isMod = await isCurrentUserModerator(sub);
  if (!isMod) {
    return {
      showToast: {
        text: "Only moderators can view RepostRadar stats.",
        appearance: "neutral",
      },
    };
  }
  const scannedAtMs = Date.now();
  const newPost = await reddit.submitCustomPost({
    subredditName: sub,
    title: `📊 RepostRadar stats — r/${sub}`,
    splash: {
      appDisplayName: "RepostRadar",
      buttonLabel: "Open stats",
      heading: "Repost stats",
      description: "Last 7 days + all-time removals and top reposters.",
    },
  });
  const view: StatsView = { mode: ViewMode.Stats, scannedAtMs };
  await redis
    .set(k.view(newPost.id as unknown as string), JSON.stringify(view), {
      expiration: new Date(scannedAtMs + VIEW_TTL_SECONDS * 1000),
    })
    .catch(() => undefined);
  return {
    showToast: { text: "Opening repost stats…", appearance: "success" },
    navigateTo: newPost.url,
  };
}

// ---------- Client API handlers ----------------------------------------------

async function onInit(): Promise<InitResponse> {
  const sub = getSubredditName();
  const username = context.username ?? "anonymous";
  const customPostId = context.postId;
  if (!customPostId) throw Error("no post context");
  const isModerator = await isCurrentUserModerator(sub);

  const raw = await redis.get(k.view(customPostId));
  if (!raw) {
    // Custom post exists but its view payload expired (or this is the install
    // welcome post). Render an empty stats view as a graceful fallback.
    return {
      type: "init",
      mode: ViewMode.Stats,
      subredditName: sub,
      username,
      isModerator,
      current: null,
      candidates: [],
      scannedAtMs: Date.now(),
    };
  }
  let parsed: ViewData;
  try {
    parsed = JSON.parse(raw) as ViewData;
  } catch {
    throw Error("stored view is corrupt");
  }

  if (parsed.mode === ViewMode.Scan) {
    return {
      type: "init",
      mode: ViewMode.Scan,
      subredditName: sub,
      username,
      isModerator,
      current: parsed.current,
      candidates: parsed.candidates,
      scannedAtMs: parsed.scannedAtMs,
    };
  }
  return {
    type: "init",
    mode: ViewMode.Stats,
    subredditName: sub,
    username,
    isModerator,
    current: null,
    candidates: [],
    scannedAtMs: parsed.scannedAtMs,
  };
}

async function onRemove(req: IncomingMessage): Promise<RemoveResponse> {
  const sub = getSubredditName();
  const customPostId = context.postId;
  if (!customPostId) throw Error("no post context");
  const isMod = await isCurrentUserModerator(sub);
  if (!isMod) throw Error("Only moderators can remove posts.");

  const raw = await redis.get(k.view(customPostId));
  if (!raw) throw Error("Scan results not found or expired.");
  const parsed = JSON.parse(raw) as ViewData;
  if (parsed.mode !== ViewMode.Scan) {
    throw Error("This view does not have a scan target.");
  }
  const originalPostId = parsed.originalPostId;

  const body = await readJSON<RemoveRequest>(req).catch(
    () => ({}) as RemoveRequest,
  );
  const target = await reddit.getPostById(originalPostId as never);
  const authorName = target.authorName;

  try {
    await target.remove(false);
  } catch (err) {
    throw Error(
      `Failed to remove post: ${err instanceof Error ? err.message : err}`,
    );
  }

  let removalCommentPermalink: string | undefined;
  if (body.originalPermalink) {
    const link = body.originalPermalink.startsWith("http")
      ? body.originalPermalink
      : `https://www.reddit.com${body.originalPermalink}`;
    const titleLine = body.originalTitle ? `> ${body.originalTitle}\n\n` : "";
    const text =
      `Hi u/${authorName}, this post has been removed because it appears to ` +
      `be a duplicate of an earlier post in r/${sub}:\n\n` +
      `${titleLine}${link}\n\n` +
      `If you believe this is a mistake, please reach out via modmail.\n\n` +
      `_Detected by [RepostRadar](https://developers.reddit.com/apps/repostradar-app)._`;
    try {
      const comment = await reddit.submitComment({
        id: target.id,
        text,
      });
      removalCommentPermalink = comment.permalink;
      try {
        await comment.distinguish(true);
      } catch {
        // best-effort
      }
    } catch (err) {
      console.warn(
        `repostradar: removal comment failed: ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }

  const now = Date.now();
  await redis
    .zAdd(k.removed(sub), { member: originalPostId, score: now })
    .catch(() => undefined);
  if (authorName) {
    await redis
      .zIncrBy(k.reposters(sub), authorName, 1)
      .catch(() => undefined);
  }

  // Mark the cached scan as removed so the UI reflects it after a refresh.
  parsed.current.removed = true;
  await redis
    .set(k.view(customPostId), JSON.stringify(parsed), {
      expiration: new Date(now + VIEW_TTL_SECONDS * 1000),
    })
    .catch(() => undefined);

  return {
    type: "remove",
    postId: originalPostId,
    removalCommentPermalink,
  };
}

async function onStats(): Promise<StatsResponse> {
  const sub = getSubredditName();
  const now = Date.now();
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const recent = await redis
    .zRange(k.removed(sub), weekAgo, now, { by: "score" })
    .catch(() => [] as { member: string; score: number }[]);
  const removalsLast7d = recent.length;
  const removalsAllTime = await redis.zCard(k.removed(sub)).catch(() => 0);
  const topRows = await redis
    .zRange(k.reposters(sub), 0, 9, { reverse: true, by: "rank" })
    .catch(() => [] as { member: string; score: number }[]);
  const topReposters: ReposterEntry[] = topRows.map((r) => ({
    username: r.member,
    removalCount: Math.round(r.score),
  }));
  return {
    type: "stats",
    subredditName: sub,
    removalsLast7d,
    removalsAllTime,
    topReposters,
  };
}

// ---------- Trigger handlers --------------------------------------------------

async function onAppInstall(req: IncomingMessage): Promise<TriggerResponse> {
  const payload = (await readJSON<OnAppInstallRequest>(req).catch(
    () => ({}),
  )) as Partial<OnAppInstallRequest>;
  const sub = payload.subreddit?.name ?? context.subredditName;
  if (!sub) return {};
  try {
    await reddit.submitCustomPost({
      subredditName: sub,
      title: "🛰️ RepostRadar is now active — one-tap duplicate detection",
      splash: {
        appDisplayName: "RepostRadar",
        buttonLabel: "How it works",
        heading: "RepostRadar",
        description:
          'Mods: open any post → menu → "RepostRadar: find duplicates".',
      },
    });
  } catch (err) {
    console.warn(
      `repostradar: app-install post skipped: ${
        err instanceof Error ? err.message : err
      }`,
    );
  }
  return {};
}

// ---------- HTTP plumbing -----------------------------------------------------

function stripQuery(url: string): string {
  const q = url.indexOf("?");
  return q === -1 ? url : url.slice(0, q);
}

function writeJSON<T extends PartialJsonValue>(
  status: number,
  json: Readonly<T>,
  rsp: ServerResponse,
): void {
  const body = JSON.stringify(json);
  const len = Buffer.byteLength(body);
  rsp.writeHead(status, {
    "Content-Length": len,
    "Content-Type": "application/json",
  });
  rsp.end(body);
}

async function readJSON<T>(req: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = [];
  req.on("data", (chunk) => chunks.push(chunk));
  await once(req, "end");
  const text = `${Buffer.concat(chunks)}`;
  return text ? (JSON.parse(text) as T) : ({} as T);
}
