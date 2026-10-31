/** Comments on articles. */
import type { Db } from "../db.js";
import { notFound } from "../http.js";
import type { Profile } from "./users.js";

export interface CommentView {
  id: number;
  createdAt: string;
  updatedAt: string;
  body: string;
  author: Profile;
}

type CommentRow = {
  id: number;
  author_id: number;
  body: string;
  created_at: string;
  updated_at: string;
  username: string;
  bio: string | null;
  image: string | null;
  following: number;
};

const SELECT = `SELECT c.id, c.author_id, c.body, c.created_at, c.updated_at, u.username, u.bio, u.image,
  EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = ? AND f.followed_id = u.id) AS following
  FROM comments c JOIN users u ON u.id = c.author_id`;

const toView = (r: CommentRow): CommentView => ({
  id: r.id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  body: r.body,
  author: { username: r.username, bio: r.bio, image: r.image, following: r.following === 1 },
});

export class CommentRepository {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  async list(articleId: number, viewerId: number | undefined): Promise<CommentView[]> {
    const rows = await this.db.all<CommentRow>(
      `${SELECT} WHERE c.article_id = ? ORDER BY c.created_at, c.id`,
      viewerId ?? -1,
      articleId,
    );
    return rows.map(toView);
  }

  async add(articleId: number, authorId: number, body: string, now: string): Promise<CommentView> {
    const id = await this.db.tx((tx) => {
      // The article may have been deleted since the caller looked it up.
      if (!tx.get("SELECT 1 FROM articles WHERE id = ?", articleId)) throw notFound("article");
      return tx.run(
        "INSERT INTO comments (article_id, author_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        articleId,
        authorId,
        body,
        now,
        now,
      ).lastInsertRowid;
    });
    const row = await this.db.get<CommentRow>(`${SELECT} WHERE c.id = ?`, authorId, id);
    return toView(row as CommentRow);
  }

  get(articleId: number, id: number): Promise<{ id: number; author_id: number } | undefined> {
    return this.db.get("SELECT id, author_id FROM comments WHERE id = ? AND article_id = ?", id, articleId);
  }

  async remove(id: number): Promise<void> {
    await this.db.run("DELETE FROM comments WHERE id = ?", id);
  }
}
