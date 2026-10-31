/** /api/articles (list, feed, CRUD, favorites, comments) and /api/tags routes. */
import { optionalUser, requireUser } from "../auth.js";
import { forbidden, intParam, invalid, notFound, type Router, send, str, wrapper } from "../http.js";
import {
  type ArticleRepository,
  type ArticleRow,
  type ArticleView,
  toView,
} from "../repositories/articles.js";
import type { CommentRepository } from "../repositories/comments.js";
import type { UserRepository } from "../repositories/users.js";
import { param } from "./users.js";

const MAX_LIMIT = 100;
const MAX_OFFSET = 1_000_000;

function tagList(o: Record<string, unknown>, required: boolean): string[] | undefined {
  const v = o.tagList;
  if (v === undefined) return required ? [] : undefined;
  if (!Array.isArray(v)) throw invalid("tagList", "must be an array");
  if (v.length > 10) throw invalid("tagList", "must have at most 10 tags");
  for (const t of v)
    if (typeof t !== "string" || t.length < 1 || t.length > 30)
      throw invalid("tagList", "must contain strings of 1 to 30 characters");
  return v as string[];
}

function queryStr(q: URLSearchParams, key: string): string | undefined {
  return q.get(key) ?? undefined;
}

export function articleRoutes(
  r: Router,
  deps: {
    users: UserRepository;
    articles: ArticleRepository;
    comments: CommentRepository;
    now: () => string;
  },
): void {
  const { users, articles, comments, now } = deps;

  async function article(slug: string): Promise<ArticleRow> {
    const a = await articles.bySlug(slug);
    if (!a) throw notFound("article");
    return a;
  }

  r.get("/api/articles", async (req, res) => {
    const viewer = await optionalUser(req, users);
    const limit = intParam(req.query, "limit", 1, MAX_LIMIT, 20);
    const offset = intParam(req.query, "offset", 0, MAX_OFFSET, 0);
    const filter = {
      tag: queryStr(req.query, "tag"),
      author: queryStr(req.query, "author"),
      favorited: queryStr(req.query, "favorited"),
    };
    const { rows, total } = await articles.list(filter, limit, offset);
    const views: ArticleView[] = [];
    for (const row of rows) {
      // SEEDED-DEFECT:n-plus-one-article-list — three queries per listed article (author, tags, favorited) instead of the batched views() the feed uses.
      const author = await users.profileById(row.author_id, viewer?.id);
      const tags = await articles.tagsOf(row.id);
      const favorited = await articles.isFavorited(row.id, viewer?.id);
      views.push({
        ...toView(
          row,
          tags.map((t) => t.tag),
          favorited,
        ),
        author,
      });
    }
    send(res, 200, { articles: views, articlesCount: total });
  });

  r.get("/api/articles/feed", async (req, res) => {
    const viewer = await requireUser(req, users);
    const limit = intParam(req.query, "limit", 1, MAX_LIMIT, 20);
    const offset = intParam(req.query, "offset", 0, MAX_OFFSET, 0);
    const { views, total } = await articles.feed(viewer.id, limit, offset);
    send(res, 200, { articles: views, articlesCount: total });
  });

  r.post("/api/articles", async (req, res) => {
    const user = await requireUser(req, users);
    const a = wrapper(req.body, "article");
    const input = {
      title: str(a, "title", { required: true, min: 1, max: 120 }) as string,
      description: str(a, "description", { required: true, min: 1, max: 255 }) as string,
      body: str(a, "body", { required: true, min: 1, max: 20_000 }) as string,
      tagList: tagList(a, true) as string[],
    };
    const slug = await articles.create(user.id, input, now());
    send(res, 201, { article: await articles.view(slug, user.id) });
  });

  r.get("/api/articles/:slug", async (req, res) => {
    const viewer = await optionalUser(req, users);
    const slug = param(req.params, "slug");
    // SEEDED-DEFECT:slug-header-500 — the decoded slug is echoed in a response header; characters outside Latin-1 (e.g. emoji) make setHeader throw ERR_INVALID_CHAR → 500 instead of 404.
    res.setHeader("content-location", `/api/articles/${slug}`);
    send(res, 200, { article: await articles.view(slug, viewer?.id) });
  });

  r.put("/api/articles/:slug", async (req, res) => {
    const user = await requireUser(req, users);
    const a = wrapper(req.body, "article");
    const patch = {
      title: str(a, "title", { required: false, min: 1, max: 120 }),
      description: str(a, "description", { required: false, min: 1, max: 255 }),
      body: str(a, "body", { required: false, min: 1, max: 20_000 }),
      tagList: tagList(a, false),
    };
    const existing = await article(param(req.params, "slug"));
    if (existing.author_id !== user.id) throw forbidden("article");
    const slug = await articles.update(existing.id, patch, now());
    send(res, 200, { article: await articles.view(slug, user.id) });
  });

  r.delete("/api/articles/:slug", async (req, res) => {
    await requireUser(req, users);
    const existing = await article(param(req.params, "slug"));
    // SEEDED-DEFECT:delete-article-no-ownership — no author check (PUT has one): any signed-in user can delete anyone's article.
    await articles.remove(existing.id);
    send(res, 204);
  });

  r.post("/api/articles/:slug/favorite", async (req, res) => {
    const user = await requireUser(req, users);
    const existing = await article(param(req.params, "slug"));
    await articles.favorite(existing.id, user.id);
    send(res, 200, { article: await articles.view(existing.slug, user.id) });
  });

  r.delete("/api/articles/:slug/favorite", async (req, res) => {
    const user = await requireUser(req, users);
    const existing = await article(param(req.params, "slug"));
    await articles.unfavorite(existing.id, user.id);
    send(res, 200, { article: await articles.view(existing.slug, user.id) });
  });

  r.get("/api/articles/:slug/comments", async (req, res) => {
    const viewer = await optionalUser(req, users);
    const existing = await article(param(req.params, "slug"));
    send(res, 200, { comments: await comments.list(existing.id, viewer?.id) });
  });

  r.post("/api/articles/:slug/comments", async (req, res) => {
    const user = await requireUser(req, users);
    const c = wrapper(req.body, "comment");
    const body = str(c, "body", { required: true, min: 1, max: 5000 }) as string;
    const existing = await article(param(req.params, "slug"));
    send(res, 201, { comment: await comments.add(existing.id, user.id, body, now()) });
  });

  r.delete("/api/articles/:slug/comments/:id", async (req, res) => {
    const user = await requireUser(req, users);
    const existing = await article(param(req.params, "slug"));
    const raw = param(req.params, "id");
    const id = /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
    const comment = Number.isSafeInteger(id) ? await comments.get(existing.id, id) : undefined;
    if (!comment) throw notFound("comment");
    if (comment.author_id !== user.id) throw forbidden("comment");
    await comments.remove(comment.id);
    send(res, 204);
  });

  r.get("/api/tags", async (_req, res) => {
    send(res, 200, { tags: await articles.allTags() });
  });
}
