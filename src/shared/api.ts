/**
 * Shared API contract between client and server.
 *
 * RepostRadar: one-tap duplicate detection for Reddit moderators.
 * Combines Reddit's built-in URL/image duplicate detection with title
 * similarity scoring to surface likely reposts in any subreddit.
 */

/** Reasons a candidate post matched the current post. */
export const MatchReason = {
  /** Reddit's getDuplicatesForPost returned this — same URL/image. */
  ExactUrl: "exact_url",
  /** Title tokens overlap significantly with the current post. */
  TitleSimilarity: "title_similarity",
  /** Both (URL match and title overlap). */
  Both: "both",
} as const;
export type MatchReason = (typeof MatchReason)[keyof typeof MatchReason];

/** A single candidate duplicate of the post under inspection. */
export type DuplicateCandidate = {
  id: string;
  title: string;
  authorName: string;
  url: string;
  permalink: string;
  thumbnail: string | null;
  /** Unix ms. */
  createdAtMs: number;
  ageLabel: string;
  score: number;
  numComments: number;
  /** 0..1 — Jaccard on normalized title tokens. 1.0 for exact-URL duplicates. */
  similarity: number;
  reason: MatchReason;
};

export type CurrentPost = {
  id: string;
  title: string;
  authorName: string;
  url: string;
  permalink: string;
  thumbnail: string | null;
  createdAtMs: number;
  numComments: number;
  score: number;
  removed: boolean;
};

/** Custom-post view mode — depends on which menu launched the scan post. */
export const ViewMode = {
  Scan: "scan",
  Stats: "stats",
} as const;
export type ViewMode = (typeof ViewMode)[keyof typeof ViewMode];

export type InitResponse = {
  type: "init";
  mode: ViewMode;
  subredditName: string;
  username: string;
  isModerator: boolean;
  /** Present when mode === "scan". */
  current: CurrentPost | null;
  candidates: DuplicateCandidate[];
  /** Server-side timestamp when scan was performed (ms). */
  scannedAtMs: number;
};

export type RemoveRequest = {
  originalPermalink?: string;
  originalTitle?: string;
};

export type RemoveResponse = {
  type: "remove";
  postId: string;
  removalCommentPermalink?: string;
};

export type ReposterEntry = {
  username: string;
  removalCount: number;
};

export type StatsResponse = {
  type: "stats";
  subredditName: string;
  removalsLast7d: number;
  removalsAllTime: number;
  topReposters: ReposterEntry[];
};

export const ApiEndpoint = {
  // Client HTTP routes
  Init: "/api/init",
  Remove: "/api/remove",
  Stats: "/api/stats",
  // Menu actions
  MenuScanPost: "/internal/menu/scan-post",
  MenuStats: "/internal/menu/stats",
  // Triggers
  TriggerAppInstall: "/internal/triggers/app-install",
} as const;
export type ApiEndpoint = (typeof ApiEndpoint)[keyof typeof ApiEndpoint];

// ---------- Title normalization ----------------------------------------------

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "in", "on", "at", "for", "and", "or", "but",
  "with", "is", "are", "was", "were", "be", "been", "this", "that", "these",
  "those", "it", "its", "my", "your", "our", "their", "his", "her", "i", "you",
  "we", "they", "he", "she", "what", "when", "where", "why", "how", "who",
  "which", "do", "does", "did", "can", "could", "should", "would", "will",
  "just", "also", "very", "really", "even", "too", "so", "than", "then",
  "from", "by", "as", "if", "not", "no", "yes", "have", "has", "had",
]);

export function normalizeTitleTokens(title: string): Set<string> {
  const cleaned = title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter(
    (t) => t.length >= 3 && !STOPWORDS.has(t),
  );
  return new Set(tokens);
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
