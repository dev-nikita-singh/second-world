/**
 * Client extractors — docs/03-engines/architecture-inspector.md §1.3:
 *  - HTTP: fetch (global/undici/node-fetch), axios (+ axios.create), got (+ extend), undici.request, node:http(s)
 *    with timeout / AbortSignal detection (feeds ARCH001)
 *  - DB: pg, mysql2, Prisma, TypeORM, Drizzle, Mongoose, Knex, node:sqlite (DatabaseSync), better-sqlite3
 *    (.prepare/.exec), plus a naming heuristic for project
 *    repository classes (`Db`, `*Repository`, `*Dao`, `*Store`; confidence 0.5)
 *  - caches: ioredis, redis;  queues: BullMQ, amqplib, kafkajs, AWS SQS
 *  - pool creation without a size (ARCH006 hits)
 */
import path from "node:path";
import type * as ts from "typescript";
import type { ClientOp } from "../../../types.js";
import type { Origin, TsFileContext } from "../context.js";
import type { TsExtractor } from "../walker.js";

const steps = (o: Origin) => o.steps.join("");

// ----------------------------------------------------------------------------- HTTP

function httpTarget(
  ctx: TsFileContext,
  urlArg: ts.Expression | undefined,
): { target: string; heuristic: boolean } {
  const s = ctx.stringValue(urlArg);
  if (s) {
    const m = /^https?:\/\/([^/:?#$]+)/i.exec(s);
    if (m) return { target: (m[1] as string).toLowerCase(), heuristic: false };
  }
  const base = path.posix
    .basename(ctx.file)
    .replace(/\.[^.]+$/, "")
    .replace(/[-_.]?(client|api|service|svc|http)$/i, "");
  return { target: base || "unknown", heuristic: true };
}

function hasAnyProp(
  ctx: TsFileContext,
  obj: ts.ObjectLiteralExpression | undefined,
  names: string[],
): boolean | undefined {
  if (!obj) return undefined;
  const { props, spread } = ctx.objectProps(obj);
  if (names.some((n) => props.has(n))) return true;
  return spread ? undefined : false;
}

/** Timeout for an options argument: missing arg → false; non-literal → unknown. */
function optionTimeout(
  ctx: TsFileContext,
  arg: ts.Expression | undefined,
  names: string[],
): boolean | undefined {
  if (!arg) return false;
  return hasAnyProp(ctx, ctx.objectLiteral(arg), names);
}

interface HttpMatch {
  library: string;
  verb: string;
  urlArg: ts.Expression | undefined;
  timeout: boolean | undefined;
  confidence: number;
}

const AXIOS_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "options", "request"]);
const GOT_VERBS = new Set(["get", "post", "put", "patch", "delete", "head", "stream"]);
const FETCH_MODULES = new Set(["undici", "node-fetch", "cross-fetch", "isomorphic-fetch"]);

function matchHttp(ctx: TsFileContext, call: ts.CallExpression): HttpMatch | undefined {
  const t = ctx.ts;
  const callee = ctx.skipOuter(call.expression);
  const args = call.arguments;
  // fetch(url, init)
  let isFetch = false;
  let fetchLib = "fetch";
  if (t.isIdentifier(callee) && callee.text === "fetch") {
    const o = ctx.originOf(callee);
    if (o.global) isFetch = true;
    else if (o.module && FETCH_MODULES.has(o.module) && o.steps.length === 0) {
      isFetch = true;
      fetchLib = o.module;
    }
  } else if (
    t.isPropertyAccessExpression(callee) &&
    callee.name.text === "fetch" &&
    t.isIdentifier(callee.expression) &&
    /^(globalThis|window|global|self)$/.test(callee.expression.text)
  ) {
    isFetch = true;
  }
  if (isFetch) {
    const init = args[1];
    const verb =
      (init && ctx.objectLiteral(init)
        ? ctx.stringValue(
            ctx.objectProps(ctx.objectLiteral(init) as ts.ObjectLiteralExpression).props.get("method"),
          )
        : undefined) ?? "GET";
    return {
      library: fetchLib,
      verb: verb.toUpperCase(),
      urlArg: args[0],
      timeout: optionTimeout(ctx, init, ["signal", "timeout"]),
      confidence: 0.9,
    };
  }
  // axios(config) / got(url, opts) / undici.request(url, opts)
  if (t.isIdentifier(callee)) {
    const o = ctx.originOf(callee);
    if (o.module === "axios" && o.steps.length === 0 && (o.name === "default" || o.name === "*")) {
      const cfg = args.length >= 2 ? args[1] : args[0];
      const urlArg = args.length >= 2 ? args[0] : undefined;
      const obj = ctx.objectLiteral(cfg);
      const urlExpr = urlArg ?? (obj ? ctx.objectProps(obj).props.get("url") : undefined);
      return {
        library: "axios",
        verb: "REQUEST",
        urlArg: urlExpr,
        timeout: hasAnyProp(ctx, obj, ["timeout", "signal", "cancelToken"]),
        confidence: 0.85,
      };
    }
    if (o.module === "got" && steps(o) === "") {
      return {
        library: "got",
        verb: "GET",
        urlArg: args[0],
        timeout: optionTimeout(ctx, args[1], ["timeout", "signal"]),
        confidence: 0.85,
      };
    }
    if (o.module === "got" && steps(o) === ".extend()") {
      const ext = o.nodes[0] as ts.CallExpression | undefined;
      const base = ext ? hasAnyProp(ctx, ctx.objectLiteral(ext.arguments[0]), ["timeout"]) : undefined;
      return {
        library: "got",
        verb: "GET",
        urlArg: args[0],
        timeout: base === true ? true : optionTimeout(ctx, args[1], ["timeout", "signal"]),
        confidence: 0.8,
      };
    }
    if (o.module === "undici" && o.steps.length === 0 && o.name === "request") {
      return {
        library: "undici",
        verb: "REQUEST",
        urlArg: args[0],
        timeout: optionTimeout(ctx, args[1], ["headersTimeout", "bodyTimeout", "signal"]),
        confidence: 0.5,
      };
    }
    if (
      (o.module === "http" || o.module === "https") &&
      (o.name === "request" || o.name === "get") &&
      o.steps.length === 0
    ) {
      return {
        library: `node:${o.module}`,
        verb: o.name.toUpperCase(),
        urlArg: args[0],
        timeout: optionTimeout(ctx, args.length >= 2 && ctx.objectLiteral(args[1]) ? args[1] : args[0], [
          "timeout",
          "signal",
        ]),
        confidence: 0.6,
      };
    }
    return undefined;
  }
  if (t.isPropertyAccessExpression(callee)) {
    const verb = callee.name.text;
    const o = ctx.originOf(callee.expression);
    if (o.module === "axios" && AXIOS_VERBS.has(verb)) {
      const s = steps(o);
      let instanceTimeout: boolean | undefined = false;
      if (s === ".create()") {
        const c = o.nodes[0] as ts.CallExpression | undefined;
        instanceTimeout = c
          ? hasAnyProp(ctx, ctx.objectLiteral(c.arguments[0]), ["timeout", "signal"])
          : undefined;
      } else if (s !== "") return undefined;
      const cfgIdx = verb === "request" ? 0 : ["post", "put", "patch"].includes(verb) ? 2 : 1;
      const cfgArg = args[cfgIdx];
      const urlArg =
        verb === "request"
          ? ctx.objectLiteral(args[0])
            ? ctx.objectProps(ctx.objectLiteral(args[0]) as ts.ObjectLiteralExpression).props.get("url")
            : undefined
          : args[0];
      const own = cfgArg
        ? hasAnyProp(ctx, ctx.objectLiteral(cfgArg), ["timeout", "signal", "cancelToken"])
        : false;
      const timeout =
        instanceTimeout === true || own === true
          ? true
          : own === undefined || instanceTimeout === undefined
            ? undefined
            : false;
      return { library: "axios", verb: verb.toUpperCase(), urlArg, timeout, confidence: 0.85 };
    }
    if (o.module === "got" && GOT_VERBS.has(verb) && (steps(o) === "" || steps(o) === ".extend()")) {
      let base: boolean | undefined;
      if (steps(o) === ".extend()") {
        const c = o.nodes[0] as ts.CallExpression | undefined;
        base = c ? hasAnyProp(ctx, ctx.objectLiteral(c.arguments[0]), ["timeout"]) : undefined;
      }
      return {
        library: "got",
        verb: verb.toUpperCase(),
        urlArg: args[0],
        timeout: base === true ? true : optionTimeout(ctx, args[1], ["timeout", "signal"]),
        confidence: 0.85,
      };
    }
    if (
      (o.module === "http" || o.module === "https") &&
      o.steps.length === 0 &&
      (verb === "request" || verb === "get") &&
      (o.name === "*" || o.name === "default")
    ) {
      return {
        library: `node:${o.module}`,
        verb: verb.toUpperCase(),
        urlArg: args[0],
        timeout: optionTimeout(ctx, args.length >= 2 && ctx.objectLiteral(args[1]) ? args[1] : args[0], [
          "timeout",
          "signal",
        ]),
        confidence: 0.6,
      };
    }
    if (
      o.module === "undici" &&
      o.steps.length === 0 &&
      (verb === "request" || verb === "fetch") &&
      (o.name === "*" || o.name === "default")
    ) {
      return {
        library: "undici",
        verb: verb.toUpperCase(),
        urlArg: args[0],
        timeout: optionTimeout(ctx, args[1], ["headersTimeout", "bodyTimeout", "signal"]),
        confidence: 0.5,
      };
    }
  }
  return undefined;
}

export const httpClientExtractor: TsExtractor = {
  id: "clients/http",
  version: "1",
  kinds: ["CallExpression", "BinaryExpression"],
  visit(node, ctx) {
    const t = ctx.ts;
    if (t.isBinaryExpression(node)) {
      // axios.defaults.timeout = 5000
      if (
        node.operatorToken.kind === t.SyntaxKind.EqualsToken &&
        t.isPropertyAccessExpression(node.left) &&
        node.left.name.text === "timeout"
      ) {
        const inner = node.left.expression;
        if (t.isPropertyAccessExpression(inner) && inner.name.text === "defaults") {
          const o = ctx.originOf(inner.expression);
          if (o.module === "axios") ctx.addFlag("axios.defaults.timeout");
        }
      }
      return;
    }
    const call = node as ts.CallExpression;
    const m = matchHttp(ctx, call);
    if (!m) return;
    const { target, heuristic } = httpTarget(ctx, m.urlArg);
    const c: Parameters<TsFileContext["addClient"]>[0] = {
      kind: "http",
      library: m.library,
      op: "calls",
      target,
      detail: `${m.library} ${m.verb}`,
      extractor: "clients/http",
      confidence: heuristic ? Math.min(m.confidence, 0.5) : m.confidence,
    };
    if (heuristic) c.heuristicTarget = true;
    if (m.timeout !== undefined) c.timeout = m.timeout;
    ctx.addClient(c, call);
  },
};

// ----------------------------------------------------------------------------- DB

const WRITE_SQL = /^\s*(insert|update|delete|merge|upsert|create|drop|alter|truncate|replace)\b/i;
const WRITE_METHOD =
  /^(insert|update|delete|remove|set|save|create|upsert|put|decrement|increment|patch|destroy|add|bulk|replace|drop|truncate|execute)/i;
const PRISMA_OPS =
  /^(findUnique|findUniqueOrThrow|findFirst|findFirstOrThrow|findMany|count|aggregate|groupBy|create|createMany|createManyAndReturn|update|updateMany|upsert|delete|deleteMany)$/;
const MONGOOSE_OPS =
  /^(find|findOne|findById|countDocuments|estimatedDocumentCount|aggregate|distinct|exists|create|insertMany|updateOne|updateMany|replaceOne|deleteOne|deleteMany|findOneAndUpdate|findByIdAndUpdate|findOneAndDelete|findByIdAndDelete|bulkWrite)$/;
const TYPEORM_OPS =
  /^(find|findOne|findBy|findOneBy|findAndCount|findOneOrFail|count|exist|exists|query|save|insert|update|delete|remove|softDelete|upsert|increment|decrement|createQueryBuilder)$/;
const REPO_CLASS = /(^Db$|^DB$|Database$|Db$|DB$|Repo$|Repository$|Dao$|DAO$|Store$|DataSource$)/;

function opFromMethod(m: string): ClientOp {
  return WRITE_METHOD.test(m) && !/^(find|get|list|count|select|read|search|query)/i.test(m)
    ? "writes"
    : "reads";
}

function opFromSql(ctx: TsFileContext, arg: ts.Expression | undefined): ClientOp {
  const s = ctx.stringValue(arg);
  return s !== undefined && WRITE_SQL.test(s) ? "writes" : "reads";
}

function dbClient(
  ctx: TsFileContext,
  node: ts.Node,
  library: string,
  target: string,
  op: ClientOp,
  detail: string,
  confidence: number,
  heuristic = false,
): void {
  const c: Parameters<TsFileContext["addClient"]>[0] = {
    kind: "db",
    library,
    op,
    target,
    detail,
    extractor: "clients/db",
    confidence,
  };
  if (heuristic) c.heuristicTarget = true;
  ctx.addClient(c, node);
}

const SQLITE_METHODS = new Set(["prepare", "exec"]);
const SQLITE_MODULES = new Set(["node:sqlite", "better-sqlite3"]);

function knexOp(ctx: TsFileContext, call: ts.CallExpression): ClientOp {
  const t = ctx.ts;
  let n: ts.Node = call;
  for (let i = 0; i < 20 && n.parent; i++) {
    const p: ts.Node = n.parent;
    if (t.isPropertyAccessExpression(p)) {
      if (/^(insert|update|del|delete|truncate|upsert|increment|decrement)$/.test(p.name.text))
        return "writes";
    } else if (!t.isCallExpression(p) && !t.isAwaitExpression(p)) break;
    n = p;
  }
  return "reads";
}

export const dbClientExtractor: TsExtractor = {
  id: "clients/db",
  version: "1",
  kinds: ["CallExpression", "NewExpression"],
  visit(node, ctx) {
    const t = ctx.ts;
    if (t.isNewExpression(node)) {
      poolSizeCheck(ctx, node);
      return;
    }
    const call = node as ts.CallExpression;
    const callee = ctx.skipOuter(call.expression);
    if (t.isIdentifier(callee)) {
      const o = ctx.originOf(callee);
      if (o.module === "knex" && steps(o) === "()") {
        const table = ctx.stringValue(call.arguments[0]) ?? "?";
        dbClient(ctx, call, "knex", "knex", knexOp(ctx, call), `knex(${table})`, 0.8);
        return;
      }
      if (o.module === "mysql2" || o.module === "mysql2/promise" || o.module === "knex")
        poolSizeCheck(ctx, call);
      return;
    }
    if (!t.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    const recv = callee.expression;
    const o = ctx.originOf(recv);
    const s = steps(o);
    const mod = o.module;
    if (mod === "pg" || mod === "pg-pool") {
      if (method === "query" && s.startsWith("new"))
        dbClient(ctx, call, "pg", "postgres", opFromSql(ctx, call.arguments[0]), `pg.${method}`, 0.9);
      return;
    }
    if (mod === "mysql2" || mod === "mysql2/promise" || mod === "mysql") {
      if (method === "createPool") poolSizeCheck(ctx, call);
      if ((method === "query" || method === "execute") && s.includes("()"))
        dbClient(ctx, call, "mysql2", "mysql", opFromSql(ctx, call.arguments[0]), `mysql.${method}`, 0.9);
      return;
    }
    // node:sqlite `new DatabaseSync(...)` / better-sqlite3 `new Database(...)`: .prepare(sql) / .exec(sql)
    if (
      SQLITE_METHODS.has(method) &&
      ((mod === "sqlite" && o.name === "DatabaseSync" && s === "new") ||
        (mod === "better-sqlite3" && s === "new"))
    ) {
      const lib = mod === "sqlite" ? "node:sqlite" : "better-sqlite3";
      dbClient(ctx, call, lib, "sqlite", opFromSql(ctx, call.arguments[0]), `sqlite.${method}`, 0.9);
      return;
    }
    // A field/parameter typed DatabaseSync (assigned in a constructor): `this.sql.prepare(sql)`.
    if (o.param && SQLITE_METHODS.has(method) && o.typeName && /^(DatabaseSync|Database)$/.test(o.typeName)) {
      if (ctx.facts.imports.some((i) => SQLITE_MODULES.has(i.specifier))) {
        dbClient(
          ctx,
          call,
          "node:sqlite",
          "sqlite",
          opFromSql(ctx, call.arguments[0]),
          `sqlite.${method}`,
          0.8,
        );
        return;
      }
    }
    if (mod === "@prisma/client") {
      if (/^new\.[A-Za-z_]\w*$/.test(s) && PRISMA_OPS.test(method)) {
        const model = s.slice(5);
        dbClient(ctx, call, "prisma", "prisma", opFromMethod(method), `prisma.${model}.${method}`, 0.9);
      } else if (s === "new" && /^\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)$/.test(method)) {
        dbClient(
          ctx,
          call,
          "prisma",
          "prisma",
          method.startsWith("$execute") ? "writes" : "reads",
          `prisma.${method}`,
          0.9,
        );
      }
      return;
    }
    if (mod === "mongoose") {
      const isModel = s === ".model()" || (o.name === "model" && s === "()");
      if (isModel && MONGOOSE_OPS.test(method))
        dbClient(ctx, call, "mongoose", "mongodb", opFromMethod(method), `mongoose.${method}`, 0.85);
      return;
    }
    if (mod === "typeorm") {
      const isRepo =
        s.endsWith(".getRepository()") ||
        s.endsWith(".manager") ||
        (o.name === "getRepository" && s === "()");
      if (isRepo && TYPEORM_OPS.test(method))
        dbClient(ctx, call, "typeorm", "typeorm", opFromMethod(method), `typeorm.${method}`, 0.85);
      return;
    }
    if (mod && /^drizzle-orm/.test(mod)) {
      if (s === "()" && /^(select|selectDistinct|insert|update|delete|execute)$/.test(method)) {
        dbClient(
          ctx,
          call,
          "drizzle",
          "drizzle",
          /^(insert|update|delete)$/.test(method) ? "writes" : "reads",
          `drizzle.${method}`,
          0.85,
        );
      } else if (/^\(\)\.query\.\w+$/.test(s) && /^(findMany|findFirst)$/.test(method)) {
        dbClient(ctx, call, "drizzle", "drizzle", "reads", `drizzle.query.${method}`, 0.85);
      }
      return;
    }
    if (
      mod === "knex" &&
      s === "()" &&
      /^(select|insert|update|del|delete|raw|from|table|transaction)$/.test(method)
    ) {
      dbClient(
        ctx,
        call,
        "knex",
        "knex",
        /^(insert|update|del|delete)$/.test(method) ? "writes" : opFromSql(ctx, call.arguments[0]),
        `knex.${method}`,
        0.8,
      );
      return;
    }
    if (o.param && o.typeName && /^Repository</.test(o.typeName) && TYPEORM_OPS.test(method)) {
      dbClient(ctx, call, "typeorm", "typeorm", opFromMethod(method), `typeorm.${method}`, 0.6);
      return;
    }
    // Heuristic: methods of project classes named like a data-access layer (`Db`, `UserRepository`, …).
    if (recv.kind === t.SyntaxKind.ThisKeyword) return;
    const owner = ctx.resolveMethodOwner(call);
    if (owner && REPO_CLASS.test(owner.className)) {
      dbClient(
        ctx,
        call,
        `project:${owner.className}`,
        owner.className,
        opFromMethod(method),
        `${owner.className}.${method}`,
        0.5,
        true,
      );
    }
  },
};

function poolSizeCheck(ctx: TsFileContext, node: ts.NewExpression | ts.CallExpression): void {
  const t = ctx.ts;
  const o = ctx.originOf(t.isNewExpression(node) ? node.expression : node.expression);
  const args = node.arguments ?? [];
  let lib: string | undefined;
  let keys: string[] = [];
  if (
    t.isNewExpression(node) &&
    (o.module === "pg" || o.module === "pg-pool") &&
    (o.name === "Pool" || o.module === "pg-pool")
  ) {
    lib = "pg";
    keys = ["max"];
  } else if (
    t.isCallExpression(node) &&
    (o.module === "mysql2" || o.module === "mysql2/promise" || o.module === "mysql")
  ) {
    const isCreatePool = o.name === "createPool" || (o.steps.length === 1 && o.steps[0] === ".createPool");
    if (isCreatePool) {
      lib = "mysql2";
      keys = ["connectionLimit"];
    }
  } else if (t.isCallExpression(node) && o.module === "knex" && o.steps.length === 0) {
    lib = "knex";
    keys = ["pool"];
  }
  if (!lib) return;
  const a0 = args[0];
  let has: boolean | undefined;
  if (!a0) has = false;
  else {
    const obj = ctx.objectLiteral(a0);
    has = obj ? hasAnyProp(ctx, obj, keys) : undefined;
  }
  if (has === false) {
    ctx.addHit(
      {
        ruleId: "ARCH006",
        message: `${lib} pool created without an explicit size (${keys.join("/")}); the default may not match the expected concurrency`,
        confidence: 0.7,
        data: { library: lib },
      },
      node,
    );
  }
}

// ----------------------------------------------------------------------------- caches & queues

const REDIS_READ =
  /^(get|mget|hget|hgetall|hmget|exists|ttl|pttl|smembers|sismember|zrange|zscore|lrange|scan|keys|type|strlen)$/;
const REDIS_WRITE =
  /^(set|setex|psetex|setnx|mset|del|unlink|hset|hmset|hdel|incr|incrby|decr|decrby|expire|pexpire|lpush|rpush|lpop|rpop|sadd|srem|zadd|zrem|getset|getdel|flushall|flushdb)$/;

function queueName(ctx: TsFileContext, e: ts.Expression | undefined, fallback: string): string {
  return ctx.stringValue(e) ?? fallback;
}

export const cacheQueueExtractor: TsExtractor = {
  id: "clients/cache-queue",
  version: "1",
  kinds: ["CallExpression", "NewExpression"],
  visit(node, ctx) {
    const t = ctx.ts;
    if (t.isNewExpression(node)) {
      const o = ctx.originOf(node.expression);
      const args = node.arguments ?? [];
      if (o.module === "bullmq" && o.name === "Worker" && o.steps.length === 0) {
        const name = queueName(ctx, args[0], "bullmq");
        const fn = args[1];
        const unit = fn ? ctx.unitIdOfExpression(fn, "consumer", `worker:${name}`) : undefined;
        ctx.addClient(
          {
            kind: "queue",
            library: "bullmq",
            op: "consumes",
            target: name,
            detail: "bullmq Worker",
            extractor: "clients/cache-queue",
            confidence: 0.9,
          },
          node,
          unit,
        );
      } else if (
        o.module === "@aws-sdk/client-sqs" &&
        o.steps.length === 0 &&
        /^(SendMessageCommand|SendMessageBatchCommand|ReceiveMessageCommand)$/.test(o.name ?? "")
      ) {
        const obj = ctx.objectLiteral(args[0]);
        const url = obj ? ctx.stringValue(obj && ctx.objectProps(obj).props.get("QueueUrl")) : undefined;
        const name = url ? (url.split("/").pop() ?? "sqs") : "sqs";
        const op = o.name === "ReceiveMessageCommand" ? "consumes" : "publishes";
        ctx.addClient(
          {
            kind: "queue",
            library: "sqs",
            op,
            target: name,
            detail: `sqs ${o.name}`,
            extractor: "clients/cache-queue",
            confidence: url ? 0.85 : 0.6,
          },
          node,
        );
      }
      return;
    }
    const call = node as ts.CallExpression;
    const callee = ctx.skipOuter(call.expression);
    if (!t.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    const o = ctx.originOf(callee.expression);
    const s = steps(o);
    const mod = o.module;
    if (
      (mod === "ioredis" && s === "new") ||
      ((mod === "redis" || mod === "@redis/client") && o.name === "createClient" && s === "()")
    ) {
      const lib = mod === "ioredis" ? "ioredis" : "redis";
      const lower = method.toLowerCase();
      if (lower === "publish") {
        ctx.addClient(
          {
            kind: "queue",
            library: lib,
            op: "publishes",
            target: `redis:${queueName(ctx, call.arguments[0], "pubsub")}`,
            detail: `${lib}.publish`,
            extractor: "clients/cache-queue",
            confidence: 0.8,
          },
          call,
        );
      } else if (lower === "subscribe" || lower === "psubscribe") {
        ctx.addClient(
          {
            kind: "queue",
            library: lib,
            op: "consumes",
            target: `redis:${queueName(ctx, call.arguments[0], "pubsub")}`,
            detail: `${lib}.${method}`,
            extractor: "clients/cache-queue",
            confidence: 0.8,
          },
          call,
        );
      } else if (REDIS_READ.test(lower) || REDIS_WRITE.test(lower)) {
        ctx.addClient(
          {
            kind: "cache",
            library: lib,
            op: REDIS_READ.test(lower) ? "reads" : "writes",
            target: "redis",
            detail: `${lib}.${method}`,
            extractor: "clients/cache-queue",
            confidence: 0.85,
          },
          call,
        );
      }
      return;
    }
    if (mod === "bullmq" && o.name === "Queue" && s === "new" && (method === "add" || method === "addBulk")) {
      const ne = o.nodes[0] as ts.NewExpression | undefined;
      const name = queueName(ctx, ne?.arguments?.[0], "bullmq");
      ctx.addClient(
        {
          kind: "queue",
          library: "bullmq",
          op: "publishes",
          target: name,
          detail: `bullmq.${method}`,
          extractor: "clients/cache-queue",
          confidence: 0.9,
        },
        call,
      );
      return;
    }
    if (
      ((mod === "amqplib" || mod === "amqplib/callback_api") && s.includes(".createChannel()")) ||
      ((mod === "amqplib" || mod === "amqplib/callback_api") && s.includes(".createConfirmChannel()"))
    ) {
      if (method === "sendToQueue" || method === "publish") {
        ctx.addClient(
          {
            kind: "queue",
            library: "amqplib",
            op: "publishes",
            target: queueName(ctx, call.arguments[0], "amqp"),
            detail: `amqp.${method}`,
            extractor: "clients/cache-queue",
            confidence: 0.85,
          },
          call,
        );
      } else if (method === "consume") {
        const name = queueName(ctx, call.arguments[0], "amqp");
        const fn = call.arguments[1];
        const unit = fn ? ctx.unitIdOfExpression(fn, "consumer", `consumer:${name}`) : undefined;
        ctx.addClient(
          {
            kind: "queue",
            library: "amqplib",
            op: "consumes",
            target: name,
            detail: "amqp.consume",
            extractor: "clients/cache-queue",
            confidence: 0.85,
          },
          call,
          unit,
        );
      }
      return;
    }
    if (mod === "kafkajs" && o.name === "Kafka") {
      const obj = ctx.objectLiteral(call.arguments[0]);
      const topicExpr = obj
        ? (ctx.objectProps(obj).props.get("topic") ?? ctx.objectProps(obj).props.get("topics"))
        : undefined;
      let topic = ctx.stringValue(topicExpr);
      if (!topic && topicExpr && t.isArrayLiteralExpression(ctx.skipOuter(topicExpr)))
        topic = ctx.stringValue((ctx.skipOuter(topicExpr) as ts.ArrayLiteralExpression).elements[0]);
      if (s === "new.producer()" && (method === "send" || method === "sendBatch")) {
        ctx.addClient(
          {
            kind: "queue",
            library: "kafkajs",
            op: "publishes",
            target: topic ?? "kafka",
            detail: `kafka.${method}`,
            extractor: "clients/cache-queue",
            confidence: topic ? 0.85 : 0.6,
          },
          call,
        );
      } else if (s === "new.consumer()" && method === "subscribe") {
        ctx.addClient(
          {
            kind: "queue",
            library: "kafkajs",
            op: "consumes",
            target: topic ?? "kafka",
            detail: "kafka.subscribe",
            extractor: "clients/cache-queue",
            confidence: topic ? 0.85 : 0.6,
          },
          call,
        );
      }
    }
  },
};
