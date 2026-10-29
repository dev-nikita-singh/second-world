/** In-memory "database" with an artificial async per-query delay (see shop-express/src/db.ts). */
export interface Product {
  id: number;
  name: string;
  price: number;
  stock: number;
  category: string;
}
export interface Order {
  id: string;
  userId: string;
  productId: number;
  qty: number;
  total: number;
  status: "paid" | "payment_failed";
  createdAt: string;
}

const CATEGORIES = ["books", "games", "tools", "garden"] as const;
const WORDS = ["red", "blue", "green", "fast", "quiet", "tiny", "giant", "smart"] as const;

function seedProducts(): Product[] {
  const out: Product[] = [];
  for (let i = 1; i <= 40; i++) {
    out.push({
      id: i,
      name: `${WORDS[i % WORDS.length] ?? "plain"} ${CATEGORIES[i % CATEGORIES.length] ?? "thing"} ${i}`,
      price: Math.round((3 + i * 1.75) * 100) / 100,
      stock: i === 40 ? 1 : 50,
      category: CATEGORIES[i % CATEGORIES.length] ?? "books",
    });
  }
  return out;
}

export class Db {
  queries = 0;
  private products = seedProducts();
  /** Inverted index word → product ids (used by the FIXED search). */
  private index = new Map<string, Set<number>>();
  private orders = new Map<string, Order>();
  private idempotency = new Map<string, Order>();
  /** Order id → the Idempotency-Key it was created with (only orders sent with a key). */
  private orderKeys = new Map<string, string>();
  private nextOrder = 1;

  constructor(private readonly queryDelayMs = 1) {
    this.reindex();
  }

  private reindex(): void {
    this.index.clear();
    for (const p of this.products) {
      for (const w of p.name.toLowerCase().split(/\s+/)) {
        let s = this.index.get(w);
        if (!s) this.index.set(w, (s = new Set()));
        s.add(p.id);
      }
    }
  }

  async query<T>(fn: () => T): Promise<T> {
    this.queries++;
    if (this.queryDelayMs > 0) await new Promise((r) => setTimeout(r, this.queryDelayMs));
    return structuredClone(fn());
  }

  reset(): void {
    this.queries = 0;
    this.products = seedProducts();
    this.reindex();
    this.orders.clear();
    this.idempotency.clear();
    this.orderKeys.clear();
    this.nextOrder = 1;
  }

  countProducts(): Promise<number> {
    return this.query(() => this.products.length);
  }
  pageProducts(offset: number, limit: number): Promise<Product[]> {
    return this.query(() => this.products.slice(offset, offset + limit));
  }
  productIds(): Promise<number[]> {
    return this.query(() => this.products.map((p) => p.id));
  }
  getProduct(id: number): Promise<Product | undefined> {
    return this.query(() => this.products.find((p) => p.id === id));
  }
  searchIndexed(word: string): Promise<Product[]> {
    return this.query(() => {
      const ids = this.index.get(word.toLowerCase()) ?? new Set<number>();
      return this.products.filter((p) => ids.has(p.id));
    });
  }
  deleteProduct(id: number): Promise<boolean> {
    return this.query(() => {
      const before = this.products.length;
      this.products = this.products.filter((p) => p.id !== id);
      this.reindex();
      return this.products.length !== before;
    });
  }
  /** Atomic conditional decrement (correct: no race). */
  decrementStock(id: number, qty: number): Promise<"ok" | "not_found" | "out_of_stock"> {
    return this.query(() => {
      const p = this.products.find((x) => x.id === id);
      if (!p) return "not_found" as const;
      if (p.stock < qty) return "out_of_stock" as const;
      p.stock -= qty;
      return "ok" as const;
    });
  }
  insertOrder(o: Omit<Order, "id" | "createdAt">, idempotencyKey?: string): Promise<Order> {
    return this.query(() => {
      const order: Order = { ...o, id: `ord_${this.nextOrder++}`, createdAt: new Date().toISOString() };
      this.orders.set(order.id, order);
      if (idempotencyKey) {
        this.idempotency.set(`${o.userId}:${idempotencyKey}`, order);
        this.orderKeys.set(order.id, idempotencyKey);
      }
      return order;
    });
  }
  byIdempotencyKey(userId: string, key: string): Promise<Order | undefined> {
    return this.query(() => this.idempotency.get(`${userId}:${key}`));
  }
  /** The user's own orders in creation order, each with the Idempotency-Key it was created with (if any). */
  ordersForUser(userId: string): Promise<(Order & { idempotencyKey?: string })[]> {
    return this.query(() => {
      const out: (Order & { idempotencyKey?: string })[] = [];
      for (const o of this.orders.values()) {
        if (o.userId !== userId) continue;
        const key = this.orderKeys.get(o.id);
        out.push(key === undefined ? o : { ...o, idempotencyKey: key });
      }
      return out;
    });
  }
  getOrder(id: string): Promise<Order | undefined> {
    return this.query(() => this.orders.get(id));
  }
}
