/**
 * In-memory "database" with an artificial async query delay, so that query count
 * translates into latency the way a real DB round-trip would.
 */
export interface Product {
  id: number;
  name: string;
  price: number;
  stock: number;
  category: string;
}
export interface Review {
  id: number;
  productId: number;
  rating: number;
  text: string;
}
export interface OrderItem {
  productId: number;
  qty: number;
  unitPrice: number;
}
export interface Order {
  id: string;
  userId: string;
  items: OrderItem[];
  total: number;
  status: "pending" | "paid" | "payment_failed";
  chargeId?: string;
  createdAt: string;
}
export interface CartItem {
  productId: number;
  qty: number;
  unitPrice: number;
}

const CATEGORIES = ["books", "games", "tools", "garden"] as const;

export function seedProducts(): Product[] {
  const out: Product[] = [];
  for (let i = 1; i <= 19; i++) {
    out.push({
      id: i,
      name: `Product ${i}`,
      price: Math.round((5 + i * 2.5) * 100) / 100,
      stock: 100,
      category: CATEGORIES[i % CATEGORIES.length] ?? "books",
    });
  }
  // A scarce product used to demonstrate the stock race.
  out.push({ id: 20, name: "Limited edition", price: 99.99, stock: 1, category: "games" });
  return out;
}

export function seedReviews(): Review[] {
  const out: Review[] = [];
  let id = 1;
  for (let p = 1; p <= 20; p++) {
    for (let k = 0; k < 3; k++) out.push({ id: id++, productId: p, rating: 1 + ((p + k) % 5), text: `Review ${k} of ${p}` });
  }
  return out;
}

export class Db {
  /** Total queries executed since the last reset (observable via /__test/stats). */
  queries = 0;
  private products: Product[] = seedProducts();
  private reviews: Review[] = seedReviews();
  private orders = new Map<string, Order>();
  private carts = new Map<string, CartItem[]>();
  private nextOrder = 1;

  constructor(private readonly queryDelayMs = 1) {}

  /** Every data access goes through here: counts the query and waits like a DB round-trip. */
  async query<T>(fn: () => T): Promise<T> {
    this.queries++;
    if (this.queryDelayMs > 0) await new Promise((r) => setTimeout(r, this.queryDelayMs));
    return structuredClone(fn());
  }

  reset(): void {
    this.queries = 0;
    this.products = seedProducts();
    this.reviews = seedReviews();
    this.orders.clear();
    this.carts.clear();
    this.nextOrder = 1;
  }

  listProducts(category?: string): Promise<Product[]> {
    return this.query(() => this.products.filter((p) => category === undefined || p.category === category));
  }
  getProduct(id: number): Promise<Product | undefined> {
    return this.query(() => this.products.find((p) => p.id === id));
  }
  reviewsFor(productId: number): Promise<Review[]> {
    return this.query(() => this.reviews.filter((r) => r.productId === productId));
  }
  reviewsForMany(productIds: number[]): Promise<Review[]> {
    const set = new Set(productIds);
    return this.query(() => this.reviews.filter((r) => set.has(r.productId)));
  }
  setStock(id: number, stock: number): Promise<void> {
    return this.query(() => {
      const p = this.products.find((x) => x.id === id);
      if (p) p.stock = stock;
    });
  }
  insertOrder(o: Omit<Order, "id" | "createdAt">): Promise<Order> {
    return this.query(() => {
      const order: Order = { ...o, id: `ord_${this.nextOrder++}`, createdAt: new Date().toISOString() };
      this.orders.set(order.id, order);
      return order;
    });
  }
  updateOrder(id: string, patch: Partial<Order>): Promise<Order | undefined> {
    return this.query(() => {
      const o = this.orders.get(id);
      if (!o) return undefined;
      Object.assign(o, patch);
      return o;
    });
  }
  getOrder(id: string): Promise<Order | undefined> {
    return this.query(() => this.orders.get(id));
  }
  ordersForUser(userId: string): Promise<Order[]> {
    return this.query(() => [...this.orders.values()].filter((o) => o.userId === userId));
  }
  allOrders(): Promise<Order[]> {
    return this.query(() => [...this.orders.values()]);
  }
  getCart(userId: string): Promise<CartItem[]> {
    return this.query(() => this.carts.get(userId) ?? []);
  }
  setCart(userId: string, items: CartItem[]): Promise<void> {
    return this.query(() => {
      this.carts.set(userId, items);
    });
  }
}
