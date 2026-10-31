/**
 * Bug Hunter value dictionary (src/engines/bugs/dictionary.ts), wave 7b: values for the path
 * parameters the contract uses (slug, username, *Id) are harvested from 2xx responses, including
 * wrapped single objects ({ article: { slug } }) and wrapped arrays ({ articles: [...] }). They fill
 * path parameters of that name only: a harvested `username` must not end up in a registration
 * body (409). Configured `values` keep applying to parameters and body properties.
 */
import { describe, expect, it } from "vitest";
import { Dictionary } from "../../../src/engines/bugs/dictionary.js";

const PARAMS = ["slug", "username", "id", "articleId"];

describe("Dictionary.harvest: contract path-parameter names", () => {
  it("wrapped single object: {article:{slug, id, author:{username}}}", () => {
    const d = new Dictionary({});
    d.harvest("/api/articles", { article: { slug: "a-1", id: 5, author: { username: "alice" } } }, PARAMS);
    expect(d.lookup("slug", "/api/articles/{slug}")).toEqual(["a-1"]);
    expect(d.lookup("username", "/api/profiles/{username}")).toEqual(["alice"]);
    expect(d.lookup("id", "/api/articles/{id}")).toEqual([5]);
  });

  it("wrapped arrays: {articles:[...], articlesCount}", () => {
    const d = new Dictionary({});
    d.harvest("/api/articles", { articles: [{ slug: "x" }, { slug: "y" }], articlesCount: 2 }, PARAMS);
    expect(d.lookup("slug", "/api/articles/{slug}/comments")).toEqual(["x", "y"]);
  });

  it("*Id fields and ids of wrapped lists under a matching key", () => {
    const d = new Dictionary({});
    d.harvest("/api/articles/{slug}/comments", { comments: [{ id: 1, articleId: 9 }] }, PARAMS);
    expect(d.lookup("articleId", "/api/x/{articleId}")).toEqual([9]);
    expect(d.lookup("id", "/api/articles/{slug}/comments/{id}")).toEqual([1]);
  });

  it("harvested path values do not fill body properties (no 409 on registration)", () => {
    const d = new Dictionary({});
    d.harvest("/api/profiles/{username}", { profile: { username: "alice" } }, PARAMS);
    expect(d.lookup("username", "/api/profiles/{username}")).toEqual(["alice"]);
    expect(d.lookup("username", "/api/users")).toEqual([]);
    expect(d.lookup("username")).toEqual([]);
  });

  it("names the contract does not use as path parameters are not harvested", () => {
    const d = new Dictionary({});
    d.harvest("/api/articles", { article: { slug: "a", title: "t" } }, PARAMS);
    expect(d.lookup("title", "/api/{title}")).toEqual([]);
  });

  it("bounded: at most 20 values per name", () => {
    const d = new Dictionary({});
    const articles = Array.from({ length: 100 }, (_, i) => ({ slug: `s${i}` }));
    d.harvest("/api/articles", { articles }, PARAMS);
    expect(d.lookup("slug", "/api/articles/{slug}").length).toBeLessThanOrEqual(20);
    expect(d.lookup("slug", "/api/articles/{slug}").length).toBeGreaterThan(0);
  });

  it("configured values win and still apply to body properties (documented)", () => {
    const d = new Dictionary({ slug: ["welcome"], username: ["bob"] });
    d.harvest("/api/articles", { article: { slug: "other", author: { username: "alice" } } }, PARAMS);
    expect(d.lookup("slug", "/api/articles/{slug}")).toEqual(["welcome"]);
    expect(d.lookup("username", "/api/users")).toEqual(["bob"]);
  });

  it("existing behaviour: top-level and items[] ids → <resource>Id", () => {
    const d = new Dictionary({});
    d.harvest("/products", { items: [{ id: 1 }, { id: 2 }] });
    d.harvest("/products", [{ id: 3 }]);
    expect(d.lookup("productId")).toEqual([1, 2, 3]);
    expect(d.lookup("id", "/products/{id}")).toEqual([1, 2, 3]);
  });
});
