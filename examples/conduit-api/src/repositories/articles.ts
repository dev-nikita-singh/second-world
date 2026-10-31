/** Articles, tags and favorites. */
import type { Db, Param } from "../db.js";
import { notFound } from "../http.js";
import type { Profile } from "./users.js";

export interface ArticleRow {
  id: number;
  slug: string;
  title: string;
  description: string;
  body: string;
  author_id: number;
  favorites_count: number;
  created_at: string;
  updated_at: string;
}

export interface ArticleView {
  slug: string;
  title: string;
  description: string;
  body: string;
  tagList: string[];
  createdAt: string;
  updatedAt: string;
  favorited: boolean;
  favoritesCount: number;
  author: Profile;
}

export interface ListFilter {
  tag?: string | undefined;
  author?: string | undefined;
  favorited?: string | undefined;
}

type JoinedRow = ArticleRow & {
  a_username: string;
  a_bio: string | null;
  a_image: string | null;
};

const JOINED = `SELECT a.*, u.username AS a_username, u.bio AS a_bio, u.image AS a_image
  FROM articles a JOIN users u ON u.id = a.author_id`;

const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(", ");

export function slugify(title: string, id: number): string {
  const base = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return base ? `${base}-${id.toString(36)}` : `article-${id.toString(36)}`;
}

export class ArticleRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private filterSql(f: ListFilter): { where: string; params: Param[] } {
    const clauses: string[] = [];
    const params: Param[] = [];
    if (f.tag !== undefined) {
      clauses.push("a.id IN (SELECT article_id FROM article_tags WHERE tag = ?)");
      params.push(f.tag);
    }
    if (f.author !== undefined) {
      clauses.push("a.author_id = (SELECT id FROM users WHERE username = ?)");
      params.push(f.author);
    }
    if (f.favorited !== undefined) {
      clauses.push(
        "a.id IN (SELECT article_id FROM favorites WHERE user_id = (SELECT id FROM users WHERE username = ?))",
      );
      params.push(f.favorited);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  /** One page of articles (newest first) and the total number matching the filter. */
  async list(f: ListFilter, limit: number, offset: number): Promise<{ rows: ArticleRow[]; total: number }> {
    const { where, params } = this.filterSql(f);
    const total = await this.db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM articles a ${where}`,
      ...params,
    );
    // Fetch one extra row so callers can tell whether another page exists.
    const rows = await this.db.all<ArticleRow>(
      `SELECT a.* FROM articles a ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      ...params,
      limit + 1,
      offset,
    );
    // SEEDED-DEFECT:pagination-off-by-one — the look-ahead row is never dropped: a page has limit + 1 articles.
    return { rows, total: total?.n ?? 0 };
  }

  /** Articles by authors the viewer follows: one page, views assembled with batched queries. */
  async feed(
    viewerId: number,
    limit: number,
    offset: number,
  ): Promise<{ views: ArticleView[]; total: number }> {
    const where = "WHERE a.author_id IN (SELECT followed_id FROM follows WHERE follower_id = ?)";
    const total = await this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM articles a ${where}`, viewerId);
    const rows = await this.db.all<JoinedRow>(
      `${JOINED} ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT ? OFFSET ?`,
      viewerId,
      limit,
      offset,
    );
    return { views: await this.views(rows, viewerId), total: total?.n ?? 0 };
  }

  async bySlug(slug: string): Promise<ArticleRow | undefined> {
    return this.db.get<ArticleRow>("SELECT * FROM articles WHERE slug = ?", slug);
  }

  async view(slug: string, viewerId: number | undefined): Promise<ArticleView> {
    const rows = await this.db.all<JoinedRow>(`${JOINED} WHERE a.slug = ?`, slug);
    if (rows.length === 0) throw notFound("article");
    return (await this.views(rows, viewerId))[0] as ArticleView;
  }

  /** Assemble views for many rows with three batched queries (tags, favorited, following). */
  private async views(rows: JoinedRow[], viewerId: number | undefined): Promise<ArticleView[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const authorIds = [...new Set(rows.map((r) => r.author_id))];
    const tags = await this.db.all<{ article_id: number; tag: string }>(
      `SELECT article_id, tag FROM article_tags WHERE article_id IN (${placeholders(ids.length)}) ORDER BY tag`,
      ...ids,
    );
    const favs =
      viewerId === undefined
        ? []
        : await this.db.all<{ article_id: number }>(
            `SELECT article_id FROM favorites WHERE user_id = ? AND article_id IN (${placeholders(ids.length)})`,
            viewerId,
            ...ids,
          );
    const follows =
      viewerId === undefined
        ? []
        : await this.db.all<{ followed_id: number }>(
            `SELECT followed_id FROM follows WHERE follower_id = ? AND followed_id IN (${placeholders(authorIds.length)})`,
            viewerId,
            ...authorIds,
          );
    const tagMap = new Map<number, string[]>();
    for (const t of tags) {
      const list = tagMap.get(t.article_id) ?? [];
      list.push(t.tag);
      tagMap.set(t.article_id, list);
    }
    const favSet = new Set(favs.map((f) => f.article_id));
    const followSet = new Set(follows.map((f) => f.followed_id));
    return rows.map((r) => ({
      ...toView(r, tagMap.get(r.id) ?? [], favSet.has(r.id)),
      author: {
        username: r.a_username,
        bio: r.a_bio,
        image: r.a_image,
        following: followSet.has(r.author_id),
      },
    }));
  }

  tagsOf(articleId: number): Promise<{ tag: string }[]> {
    return this.db.all<{ tag: string }>(
      "SELECT tag FROM article_tags WHERE article_id = ? ORDER BY tag",
      articleId,
    );
  }

  async isFavorited(articleId: number, userId: number | undefined): Promise<boolean> {
    if (userId === undefined) return false;
    const row = await this.db.get(
      "SELECT 1 AS x FROM favorites WHERE user_id = ? AND article_id = ?",
      userId,
      articleId,
    );
    return row !== undefined;
  }

  /** Insert the article and its tags in one transaction; the slug embeds the new id, so it is unique. */
  create(
    authorId: number,
    a: { title: string; description: string; body: string; tagList: string[] },
    now: string,
  ): Promise<string> {
    return this.db.tx((tx) => {
      const { lastInsertRowid: id } = tx.run(
        "INSERT INTO articles (slug, title, description, body, author_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        `tmp-${now}-${authorId}`,
        a.title,
        a.description,
        a.body,
        authorId,
        now,
        now,
      );
      const slug = slugify(a.title, id);
      tx.run("UPDATE articles SET slug = ? WHERE id = ?", slug, id);
      for (const tag of new Set(a.tagList))
        tx.run("INSERT INTO article_tags (article_id, tag) VALUES (?, ?)", id, tag);
      return slug;
    });
  }

  /** Update title/description/body/tags; a new title gives a new slug. Returns the (new) slug. */
  update(
    id: number,
    patch: {
      title?: string | undefined;
      description?: string | undefined;
      body?: string | undefined;
      tagList?: string[] | undefined;
    },
    now: string,
  ): Promise<string> {
    return this.db.tx((tx) => {
      if (!tx.get("SELECT 1 FROM articles WHERE id = ?", id)) throw notFound("article");
      if (patch.title !== undefined)
        tx.run(
          "UPDATE articles SET title = ?, slug = ? WHERE id = ?",
          patch.title,
          slugify(patch.title, id),
          id,
        );
      if (patch.description !== undefined)
        tx.run("UPDATE articles SET description = ? WHERE id = ?", patch.description, id);
      if (patch.body !== undefined) tx.run("UPDATE articles SET body = ? WHERE id = ?", patch.body, id);
      if (patch.tagList !== undefined) {
        tx.run("DELETE FROM article_tags WHERE article_id = ?", id);
        for (const tag of new Set(patch.tagList))
          tx.run("INSERT INTO article_tags (article_id, tag) VALUES (?, ?)", id, tag);
      }
      tx.run("UPDATE articles SET updated_at = ? WHERE id = ?", now, id);
      return (tx.get<{ slug: string }>("SELECT slug FROM articles WHERE id = ?", id) as { slug: string })
        .slug;
    });
  }

  async remove(id: number): Promise<void> {
    await this.db.run("DELETE FROM articles WHERE id = ?", id);
  }

  /** Favorite (idempotent per user). */
  async favorite(articleId: number, userId: number): Promise<void> {
    // SEEDED-DEFECT:favorites-count-race — read-modify-write of favorites_count across awaits, no transaction: concurrent favorites lose updates.
    const current = await this.db.get<{ favorites_count: number }>(
      "SELECT favorites_count FROM articles WHERE id = ?",
      articleId,
    );
    const inserted = await this.db.run(
      "INSERT OR IGNORE INTO favorites (user_id, article_id) VALUES (?, ?)",
      userId,
      articleId,
    );
    if (inserted.changes === 1 && current)
      await this.db.run(
        "UPDATE articles SET favorites_count = ? WHERE id = ?",
        current.favorites_count + 1,
        articleId,
      );
  }

  /** Unfavorite (idempotent per user), atomically. */
  async unfavorite(articleId: number, userId: number): Promise<void> {
    await this.db.tx((tx) => {
      const r = tx.run("DELETE FROM favorites WHERE user_id = ? AND article_id = ?", userId, articleId);
      if (r.changes === 1)
        tx.run("UPDATE articles SET favorites_count = favorites_count - 1 WHERE id = ?", articleId);
    });
  }

  async allTags(): Promise<string[]> {
    const rows = await this.db.all<{ tag: string }>("SELECT DISTINCT tag FROM article_tags ORDER BY tag");
    return rows.map((r) => r.tag);
  }
}

export function toView(r: ArticleRow, tagList: string[], favorited: boolean): Omit<ArticleView, "author"> {
  return {
    slug: r.slug,
    title: r.title,
    description: r.description,
    body: r.body,
    tagList,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    favorited,
    favoritesCount: r.favorites_count,
  };
}
