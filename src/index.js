/**
 * Cloudflare Worker · GitHub 反向代理加速
 *
 * 用法：https://你的域名/https://github.com/用户/仓库
 *       https://你的域名/?url=https://raw.githubusercontent.com/...
 *
 * 设计要点：
 * 1. 普通页面：手动处理重定向并重写 Location，保证链接不跳出代理域名。
 * 2. 下载资源（Release / latest / codeload / 对象存储）：Worker 内部跟随重定向，
 *    浏览器始终只看到干净的原始代理链接，绝不暴露带签名的临时 URL。
 * 3. 下载资源使用稳定 cacheKey（剥离每次都变的签名查询串），
 *    边缘缓存可以真正命中，重复下载由 CF 边缘直接返回。
 * 4. 成功的下载响应允许浏览器缓存，二次下载连 Worker 都不经过。
 * 5. 二进制响应保留 Content-Length / Accept-Ranges / Content-Range，支持断点续传。
 * 6. 全链路结构化日志，可在 Workers Logs（Observability）中查询。
 */

// 静态页面在构建时由 index.html 注入；本地直接运行时为空串，请以部署版本为准
const UI_HTML = "__UI_HTML__";

// 用于线上确认部署版本（/health 中返回）
const BUILD_ID = "2026-11-20.7";

// 允许代理的源站，防止被当作开放代理滥用
// github.githubassets.com 承载 GitHub 页面的绝大部分 JS/CSS，必须走代理，
// 否则页面资源仍直连 GitHub CDN，"加速"体感会大幅打折。
const ALLOWED_HOSTS = new Set([
  "github.com",
  "www.github.com",
  "raw.githubusercontent.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "objects-origin.githubusercontent.com",
  "avatars.githubusercontent.com",
  "gist.github.com",
  "gist.githubusercontent.com",
  "githubusercontent.com",
  "user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "secured-user-images.githubusercontent.com",
  "github.githubassets.com",
  "github.io",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "assets.githubusercontent.com",
]);
const HOST_LIST = Array.from(ALLOWED_HOSTS).sort((a, b) => b.length - a.length);

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// 不应转发给源站的 hop-by-hop / Cloudflare 内部头
const REQ_SKIP = new Set([
  "host", "connection", "keep-alive", "proxy-connection",
  "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "cookie", "accept-encoding",
  "cf-connecting-ip", "cf-ipcountry", "cf-ray", "cf-visitor",
  "cf-worker", "x-forwarded-for", "x-forwarded-host",
  "x-forwarded-proto", "x-forwarded-port", "x-forwarded-server",
]);

// 回包中必须移除的 hop-by-hop / 内部头。
// content-length / content-encoding 对二进制透传是有意义的，只在文本改写时删除。
const RESP_SKIP = new Set([
  "set-cookie", "transfer-encoding", "connection", "keep-alive",
  "upgrade", "cf-ray", "age",
]);

const STATIC_EXT =
  /\.(?:js|mjs|css|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|map|pdf|zip|tar|gz|bz2|xz|7z|dmg|exe|deb|rpm|whl)$/i;

const CACHEABLE_HOSTS = new Set([
  "raw.githubusercontent.com",
  "avatars.githubusercontent.com",
  "gist.githubusercontent.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "objects-origin.githubusercontent.com",
  "user-images.githubusercontent.com",
  "camo.githubusercontent.com",
  "private-user-images.githubusercontent.com",
  "secured-user-images.githubusercontent.com",
  "github.githubassets.com",
  "githubusercontent.com",
  "assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
]);

const ASSET_HOSTS = new Set([
  "codeload.github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "github-releases.githubusercontent.com",
  "assets.githubusercontent.com",
]);
// /releases/download/<tag>/<file> 之外，/releases/latest/download/<file> 也会 302 到签名地址
const RELEASE_DOWNLOAD = /\/releases\/(?:latest\/)?download\//i;

/* ---------------------------------- 工具 ---------------------------------- */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: Object.assign(
      {
        "Content-Type": "application/json; charset=UTF-8",
        "Cache-Control": "no-store",
      },
      corsHeaders(),
      headers
    ),
  });
}

function uiResponse() {
  return new Response(UI_HTML, {
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

/** 一次性签名链接过期后，给出可操作的提示，而不是一个突兀的 500/403 */
function expiredSignatureResponse(base) {
  const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>下载链接已过期 · CF Proxy</title><style>
body{margin:0;background:#f7f7f7;color:#111;font:15px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;display:grid;place-items:center;min-height:100vh}
.card{background:#fff;border:1px solid #e7e7e7;border-radius:22px;padding:32px;max-width:640px; margin:20px}
h1{font-size:20px;margin:0 0 12px}p{margin:8px 0;color:#444}
code{display:block;background:#f2f2f2;border-radius:10px;padding:12px 14px;margin-top:12px;word-break:break-all;font-size:13px}
a{color:#111;font-weight:600}
</style></head><body><div class="card">
<h1>下载链接已过期</h1>
<p>这是 GitHub 生成的一次性签名下载链接，有效期约 1 小时，现在已经失效了。</p>
<p>请从<b>干净的 Release 页面链接</b>重新进入，代理会自动获取新的签名，地址栏不会变成签名链接：</p>
<code>${base}/https://github.com/用户/仓库/releases</code>
<p style="margin-top:14px"><a href="${base}/">返回代理首页 →</a></p>
</div></body></html>`;
  return new Response(html, {
    status: 410,
    headers: {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function slashEscape(s) {
  return s.replace(/\//g, "\\/");
}

/** 结构化日志：Workers Logs 会按字段建立索引，便于按事件/状态过滤 */
function logEvent(event, fields) {
  try {
    console.log(Object.assign({ event, ts: new Date().toISOString() }, fields || {}));
  } catch (e) {
    /* 日志失败不影响代理 */
  }
}

/** 签名链接含凭据，日志中只保留路径 */
function safeUrl(target) {
  const u = new URL(target.toString());
  if (u.searchParams.has("sig") || u.searchParams.has("jwt")) {
    u.search = "?<redacted>";
  }
  return u.toString();
}

/* ------------------------------ 目标 URL 解析 ------------------------------ */

function extractTarget(request, forcedRaw) {
  const url = new URL(request.url);
  let raw = "";
  const path = url.pathname || "/";

  if (forcedRaw !== undefined) {
    raw = forcedRaw;
  } else {
    if (path !== "/") {
      try {
        raw = decodeURIComponent(path.replace(/^\/+/, ""));
      } catch (e) {
        return { error: "路径解码失败" };
      }
    }
    if (!raw && url.searchParams.has("url")) {
      raw = url.searchParams.get("url");
    }
  }
  if (!raw) return null; // 根路径：交给静态页面

  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw;

  let target;
  try {
    target = new URL(raw);
  } catch (e) {
    return { error: "无法解析目标 URL：" + raw };
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return { error: "仅支持 http/https 协议" };
  }
  const hostname = target.hostname.toLowerCase();
  // 前端允许任意 *.github.io，服务端需保持一致，否则生成的链接会被自己拒绝
  if (!ALLOWED_HOSTS.has(hostname) && !hostname.endsWith(".github.io")) {
    return { error: "域名不在白名单中：" + hostname };
  }
  target.hostname = hostname;

  // 形如 /https://github.com/x?tab=readme 的查询串应透传给源站。
  // /__warm?url=... 的查询串是接口参数，不能透传。
  if (
    forcedRaw === undefined &&
    !target.search &&
    url.search &&
    !url.searchParams.has("url")
  ) {
    target.search = url.search;
  }
  return { target };
}

/**
 * 代理地址优先取请求的 Host，而不是 url.origin。
 * 自定义域名经 CNAME/内部路由进入 Worker 时，url.origin 可能是 workers.dev，
 * 会导致生成的 Location 跳回 workers.dev。
 */
function publicBase(request, url) {
  const host = request.headers.get("host");
  if (host && !host.toLowerCase().endsWith(".workers.dev")) {
    return url.protocol + "//" + host;
  }
  return url.origin;
}

/** 重定向使用相对路径，浏览器会按当前访问域名解析，避免跨域跳转 */
function toProxyPath(absolute) {
  try {
    const u = new URL(absolute);
    if (u.protocol !== "https:" && u.protocol !== "http:") return absolute;
    return "/" + u.toString();
  } catch (e) {
    return absolute;
  }
}

/* ------------------------------ 下载资源判定 ------------------------------ */

/** GitHub Release 的一次性签名下载链接（有效期约 1 小时） */
function isSignedAsset(target) {
  const host = target.hostname.toLowerCase();
  if (host !== "release-assets.githubusercontent.com" &&
      host !== "objects.githubusercontent.com") return false;
  return target.searchParams.has("sig") || target.searchParams.has("jwt");
}

function isDownloadAsset(target) {
  const host = target.hostname.toLowerCase();
  if (ASSET_HOSTS.has(host)) return true;
  if ((host === "github.com" || host === "www.github.com") &&
      RELEASE_DOWNLOAD.test(target.pathname)) return true;
  return STATIC_EXT.test(target.pathname);
}

/**
 * 稳定缓存键：签名查询串每次请求都不同，必须剥离，否则缓存永远无法命中。
 * github.com 的原始下载地址本身稳定，可以连同查询串一起作为键。
 */
function assetCacheKey(target) {
  const host = target.hostname.toLowerCase();
  // 这些对象的查询串是一次性签名，参与键会让缓存永远 MISS
  if (host === "release-assets.githubusercontent.com" ||
      host === "github-releases.githubusercontent.com" ||
      host === "objects.githubusercontent.com" ||
      host === "assets.githubusercontent.com") {
    return "cfproxy:asset:" + host + target.pathname;
  }
  return "cfproxy:asset:" + host + target.pathname + target.search;
}

/* ------------------------------ 回源线路选择 ------------------------------ */

/**
 * Workers 无法指定上游 IP：cf.resolveOverride 只对自有 zone 内的域名生效。
 * 这里能做的是把"线路"抽象成可替换的入口 URL：默认直连 GitHub，
 * 可通过 UPSTREAM_MIRRORS（JSON 数组，按优先级排序）配置可信的加速入口，
 * 失败时自动切到下一条。缓存键始终用原始 GitHub URL，切换线路不会丢缓存。
 */
function upstreamRoutes(target, env) {
  const routes = [];
  const raw = env && env.UPSTREAM_MIRRORS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const base of parsed) {
          if (typeof base !== "string" || !/^https:\/\//i.test(base)) continue;
          const clean = base.replace(/\/+$/, "");
          let name;
          try {
            name = new URL(clean).hostname;
          } catch (e) {
            continue;
          }
          routes.push({ name, url: clean + "/" + target.toString() });
        }
      }
    } catch (e) {
      logEvent("bad_mirror_config", { error: String(e) });
    }
  }
  // 官方线路兜底：github.com 与 www.github.com 等价，可作为备用线路
  routes.push({ name: "direct", url: target.toString() });
  if (target.hostname === "github.com") {
    const alternate = new URL(target.toString());
    alternate.hostname = "www.github.com";
    routes.push({ name: "www.github.com", url: alternate.toString() });
  }
  return routes;
}

/* ------------------------------ 内容链接重写 ------------------------------ */

/** 重写文本中的绝对 URL、JSON 里的转义 URL、协议相对 URL */
function rewriteUrls(text, base) {
  let out = text;

  for (const host of HOST_LIST) {
    for (const scheme of ["https", "http"]) {
      const target = scheme + "://" + host;
      const replacement = base + "/https://" + host;
      // JSON 中常见 "https:\/\/github.com"
      out = out.split(slashEscape(target)).join(slashEscape(replacement));
      // 普通绝对 URL
      out = out.split(target).join(replacement);
    }
  }

  // 协议相对 URL：//github.com/... （负向后顾避免误伤刚插入的 https://）
  const pattern = HOST_LIST.map(escapeRegExp).join("|");
  out = out.replace(
    new RegExp("(?<!:)\\/\\/(" + pattern + ")", "g"),
    function (match, host) {
      return base + "/https://" + host;
    }
  );
  return out;
}

/** HTML 额外处理根相对路径，并注入 base 标签 */
function rewriteHtml(text, base, host) {
  let out = rewriteUrls(text, base);
  const prefix = base + "/https://" + host;

  if (host === "github.com" || host === "www.github.com" || host === "gist.github.com") {
    out = out.replace(
      /(\s(?:href|src|action|poster|data-src|data-href|data-url|data-target)\s*=\s*["'])\/(?!\/)/gi,
      function (match, attr) {
        return attr + prefix + "/";
      }
    );
  }

  if (!/<base\s/i.test(out)) {
    out = out.replace(/<head([^>]*)>/i, function (match, attrs) {
      return '<head' + attrs + '><base href="' + prefix + '/">';
    });
  }
  return out;
}

/** 重写 HTML 会改变内联脚本内容，GitHub CSP 里的 sha256 白名单随之失效。
 *  必须按改写后的脚本文本重算哈希，否则页面停在骨架屏（React 未 hydrate）。 */
async function inlineScriptHashes(html) {
  const hashes = [];
  const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = pattern.exec(html))) {
    if (/\bsrc\s*=/i.test(match[1])) continue;
    const body = match[2];
    if (!body.trim()) continue;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body)
    );
    const bytes = new Uint8Array(digest);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    hashes.push("'sha256-" + btoa(binary) + "'");
  }
  return hashes;
}

/**
 * GitHub 的 CSP 只允许 github.githubassets.com 提供样式/脚本/字体，
 * 但页面里的资源 URL 已被重写到代理域名，不改写 CSP 浏览器会全部拦截，
 * 表现为"无样式裸页面"。给每个来源列表追加代理源站。
 */
function rewriteCsp(value, base, scriptHashes) {
  if (!value) return value;
  const directives = [
    "default-src", "connect-src", "font-src", "img-src", "style-src",
    "script-src", "media-src", "object-src", "child-src", "frame-src",
    "worker-src", "manifest-src", "form-action",
  ];
  let out = value;
  for (const directive of directives) {
    const pattern = new RegExp("(^|;\\s*)(" + directive + ")(\\s+)([^;]*)", "gi");
    out = out.replace(pattern, function (match, lead, name, gap, sources) {
      if (directive === "script-src" && scriptHashes && scriptHashes.length) {
        const hosts = sources
          .replace(/'sha256-[^']+'/g, "")
          .replace(/\s+/g, " ")
          .trim();
        return (
          lead + name + gap + (hosts ? hosts + " " : "") +
          scriptHashes.join(" ") + " " + base
        );
      }
      // 'self' 在代理页面里已经指向代理域名，无需重复添加
      if (/(^|\s)'self'(\s|$)/i.test(sources)) return match;
      if (/(^|\s)'none'(\s|$)/i.test(sources)) {
        return lead + name + gap + base;
      }
      return lead + name + gap + sources + " " + base;
    });
  }
  return out;
}

/* -------------------------------- 请求 / 回包 ------------------------------- */

function upstreamHeaders(request) {
  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!REQ_SKIP.has(key.toLowerCase())) headers.set(key, value);
  }
  if (!headers.has("user-agent")) headers.set("user-agent", DEFAULT_UA);
  return headers;
}

function isCacheable(target) {
  if (CACHEABLE_HOSTS.has(target.hostname)) return true;
  if (target.hostname === "github.com" && STATIC_EXT.test(target.pathname)) return true;
  return false;
}

/**
 * fetch 在网络层失败时可能返回 status = 0 的 Response.error()，
 * 直接把它传给 new Response() 会抛 RangeError（status 必须 200-599），
 * 表现为整个代理返回 500。这里统一收敛成可返回的 HTTP 状态。
 */
function normalizeStatus(status) {
  return Number.isInteger(status) && status >= 200 && status <= 599
    ? status
    : 502;
}

async function buildResponse(upstream, target, base, options = {}) {
  const status = normalizeStatus(upstream.status);
  const headers = new Headers();
  for (const [key, value] of upstream.headers.entries()) {
    if (!RESP_SKIP.has(key.toLowerCase())) headers.set(key, value);
  }
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Expose-Headers", "*");
  // 暴露给客户端，便于判断"慢"到底是回源还是链路问题
  headers.set(
    "X-CFProxy-Cache",
    upstream.headers.get("cf-cache-status") || "BYPASS"
  );

  // Release 资产内容不可变，允许浏览器缓存一天：二次下载连 Worker 都不经过。
  // 重定向与文本页面仍禁止缓存，避免旧签名链接残留在浏览器缓存里。
  const cacheableAsset = options.asset && status >= 200 && status < 300;
  headers.set(
    "Cache-Control",
    cacheableAsset ? "public, max-age=86400" : "no-store"
  );

  // 重定向地址必须指回代理，否则浏览器会直连 GitHub
  const location = upstream.headers.get("location");
  if (location) {
    let resolved = location;
    try {
      resolved = new URL(location, target).toString();
    } catch (e) {
      /* 保留原值 */
    }
    headers.set("Location", toProxyPath(resolved));
  }

  const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
  const shouldRewrite =
    status >= 200 &&
    status < 400 &&
    upstream.body &&
    (contentType.includes("text/html") ||
      contentType.includes("text/css") ||
      contentType.includes("json") ||
      contentType.includes("javascript") ||
      contentType.includes("ecmascript"));

  if (shouldRewrite) {
    // 改写后长度与编码都失效
    headers.delete("content-length");
    headers.delete("content-encoding");
    let text = await upstream.text();
    const isHtml = contentType.includes("text/html");
    text = isHtml
      ? rewriteHtml(text, base, target.hostname)
      : rewriteUrls(text, base);

    // 资源 URL 改到代理域名后，CSP 也要放行；内联脚本被改写后旧哈希失效，
    // 必须按新文本重算，否则 React 等脚本被拦，页面一直显示骨架屏。
    if (isHtml) {
      const csp = headers.get("content-security-policy");
      if (csp) {
        const hashes = await inlineScriptHashes(text);
        headers.set("content-security-policy", rewriteCsp(csp, base, hashes));
      }
      headers.delete("content-security-policy-report-only");
    }

    return new Response(text, {
      status,
      statusText: upstream.statusText,
      headers,
    });
  }

  // 二进制内容（git 协议、压缩包、图片）流式透传，保留 206 / Content-Range / Content-Length
  return new Response(upstream.body, {
    status,
    statusText: upstream.statusText,
    headers,
  });
}

const CACHE_TTL = {
  "200-299": 86400,
  "404": 300,
  "500-599": -1,
};
const ASSET_CACHE_CF = {
  cacheEverything: true,
  cacheTtlByStatus: CACHE_TTL,
};

/**
 * 预热：在后台完整拉取对象（按块丢弃，不占用内存），把整份文件写进边缘缓存。
 * 之后任意 Range 区间都能命中，避免"每个区间各回源一次"。
 * 以 cacheKey 为单位做并发去重：多线程下载器同时 MISS 时只回源一次。
 */
const inFlightWarms = new Map();

function warmAsset(target, cacheCf, routeUrl) {
  const key = cacheCf.cacheKey;
  const existing = inFlightWarms.get(key);
  if (existing) {
    logEvent("warm_skip", { url: safeUrl(target), reason: "in_flight" });
    return existing;
  }

  const started = Date.now();
  const task = (async () => {
    const warmHeaders = new Headers({
      "user-agent": DEFAULT_UA,
      accept: "application/octet-stream,application/zip,*/*",
    });
    const upstream = await fetch(
      new Request(routeUrl || target.toString(), {
        method: "GET",
        headers: warmHeaders,
        redirect: "follow",
        cf: cacheCf,
      })
    );
    const status = normalizeStatus(upstream.status);
    let bytes = 0;
    if (upstream.body) {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
      }
    }
    const result = {
      status,
      bytes,
      length: upstream.headers.get("content-length"),
      ms: Date.now() - started,
    };
    logEvent("warm", {
      url: safeUrl(target),
      status,
      bytes,
      cache: upstream.headers.get("cf-cache-status"),
    });
    return result;
  })();

  inFlightWarms.set(key, task);
  // 任务结束后立即从去重表移除；调用方自己负责捕获后台任务的错误。
  task.then(
    () => inFlightWarms.delete(key),
    () => inFlightWarms.delete(key)
  );
  return task;
}

/** 预热完成后再发一个 1 字节 Range 请求，确认边缘缓存真的可命中 */
async function warmCacheStatus(target, cacheCf, routeUrl) {
  try {
    const verify = await fetch(
      new Request(routeUrl || target.toString(), {
        method: "GET",
        headers: { Range: "bytes=0-0", "user-agent": DEFAULT_UA },
        cf: cacheCf,
      })
    );
    const status = verify.headers.get("cf-cache-status") || "BYPASS";
    if (verify.body) await verify.body.cancel();
    return /HIT|STALE|REVALIDATED/i.test(status) ? "HIT" : status;
  } catch (e) {
    return "UNKNOWN";
  }
}

/* ---------------------------------- 入口 ---------------------------------- */

async function handleRequest(request, env, ctx) {
  const started = Date.now();
  const url = new URL(request.url);
  const base = publicBase(request, url);
  const path = url.pathname || "/";

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (path === "/health") {
    return json({
      ok: true,
      service: "cfproxy",
      build: BUILD_ID,
      time: new Date().toISOString(),
    });
  }
  if (path === "/favicon.ico") {
    return new Response(null, { status: 204 });
  }

  // 显式预热接口：等整份文件写完边缘缓存才返回，页面可据此提示用户再下载。
  // 用法：/__warm?url=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Freleases%2Fdownload%2F...
  if (path === "/__warm") {
    const probe = extractTarget(request, url.searchParams.get("url") || "");
    if (!probe || probe.error) {
      return json(
        { ok: false, error: probe ? probe.error : "缺少 url 参数" },
        400
      );
    }
    const target = probe.target;
    if (!isDownloadAsset(target)) {
      return json({ ok: false, error: "该链接不是可缓存的下载资源" }, 400);
    }
    const cacheCf = Object.assign(
      { cacheKey: assetCacheKey(target) },
      ASSET_CACHE_CF
    );
    try {
      const routes = upstreamRoutes(target, env);
      let result;
      let warmUrl = target.toString();
      let lastError;
      for (const candidate of routes) {
        try {
          warmUrl = candidate.url;
          result = await warmAsset(target, cacheCf, warmUrl);
          break;
        } catch (e) {
          lastError = e;
          logEvent("upstream_failover", {
            url: safeUrl(target),
            route: candidate.name,
            error: String(e),
          });
        }
      }
      if (!result) throw lastError || new Error("所有回源线路均不可用");
      let cache = await warmCacheStatus(target, cacheCf, warmUrl);
      // 任意播可能把两次请求落到不同机房，MISS 时再确认一次
      if (cache === "MISS" || cache === "BYPASS") {
        cache = await warmCacheStatus(target, cacheCf, warmUrl);
      }
      logEvent("warm_api", {
        url: safeUrl(target),
        bytes: result.bytes,
        cache,
        ms: Date.now() - started,
      });
      return json({
        ok: true,
        url: safeUrl(target),
        status: result.status,
        bytes: result.bytes,
        cache,
        ms: result.ms,
      });
    } catch (e) {
      logEvent("warm_api_error", { url: safeUrl(target), error: String(e) });
      return json({ ok: false, error: String(e) }, 502);
    }
  }

  if ((path === "/" || path === "/index.html") && !url.searchParams.has("url")) {
    return uiResponse();
  }

  const probe = extractTarget(request);
  if (!probe) return uiResponse();
  if (probe.error) {
    logEvent("bad_target", { error: probe.error });
    return json(
      {
        error: probe.error,
        hint: "正确格式：" + base + "/https://github.com/用户/仓库",
      },
      400
    );
  }

  const target = probe.target;
  const method = request.method;
  const isRead = method === "GET" || method === "HEAD";
  const asset = isRead && isDownloadAsset(target);
  const cacheKey = asset ? assetCacheKey(target) : null;

  logEvent("request", {
    method,
    url: safeUrl(target),
    asset,
    colo: request.cf && request.cf.colo,
    country: request.cf && request.cf.country,
    range: isRead ? request.headers.get("range") : null,
  });

  const headers = upstreamHeaders(request);
  const assetCacheCf = asset
    ? Object.assign({ cacheKey }, ASSET_CACHE_CF)
    : null;
  let upstream;
  let route = "direct";
  let upstreamUrl = target.toString();
  try {
    if (asset) {
      // 服务端跟随重定向：浏览器只访问干净链接，缓存键稳定，少一次完整往返。
      // 线路按 UPSTREAM_MIRRORS 优先级尝试，失败自动切下一条；
      // cacheKey 始终基于原始 URL，所以换线路不会让边缘缓存失效。
      const routes = upstreamRoutes(target, env);
      let lastError;
      for (let i = 0; i < routes.length; i++) {
        const candidate = routes[i];
        const routeHeaders = new Headers(headers);
        if (candidate.name !== "direct") routeHeaders.delete("authorization");
        try {
          const subRequest = new Request(candidate.url, {
            method,
            headers: routeHeaders,
            redirect: "follow",
            cf: assetCacheCf,
          });
          const result = await fetch(subRequest);
          const status = normalizeStatus(result.status);
          if (status >= 500 && i < routes.length - 1) {
            logEvent("upstream_failover", {
              url: safeUrl(target),
              route: candidate.name,
              status,
            });
            if (result.body) await result.body.cancel();
            continue;
          }
          upstream = result;
          route = candidate.name;
          upstreamUrl = candidate.url;
          break;
        } catch (e) {
          lastError = e;
          logEvent("upstream_failover", {
            url: safeUrl(target),
            route: candidate.name,
            error: String(e),
          });
        }
      }
      if (!upstream) throw lastError || new Error("所有回源线路均不可用");
    } else {
      const init = {
        method,
        headers,
        redirect: "manual", // 由自己重写 Location，避免浏览器直连源站
      };
      if (!isRead) {
        init.body = request.body;
        init.duplex = "half";
      }
      if (isRead && isCacheable(target)) {
        init.cf = { cacheEverything: true, cacheTtlByStatus: CACHE_TTL };
      }
      upstream = await fetch(target.toString(), init);
    }
  } catch (e) {
    logEvent("upstream_error", {
      url: safeUrl(target),
      error: String(e),
      ms: Date.now() - started,
    });
    return json({ error: "上游请求失败", detail: String(e) }, 502);
  }

  logEvent("upstream", {
    url: safeUrl(target),
    status: upstream.status,
    cache: upstream.headers.get("cf-cache-status"),
    ms: Date.now() - started,
    asset,
    route,
    cacheKey: cacheKey || undefined,
  });

  // 一次性签名链接过期后源站返回 403/404，网络层失败时还会得到 status 0 的
  // Response.error()。直接透传会变成含义不明的 500。统一换成带操作指引的提示页，
  // 引导用户回到干净的 releases 链接重新获取新签名。
  if (isSignedAsset(target) && normalizeStatus(upstream.status) >= 400) {
    logEvent("expired_signature", {
      url: safeUrl(target),
      status: upstream.status,
      ms: Date.now() - started,
    });
    return expiredSignatureResponse(base);
  }

  // Range 未命中时后台预热完整对象，后续任意区间都能走边缘缓存
  if (asset && method === "GET" && request.headers.has("range")) {
    const cacheStatus = upstream.headers.get("cf-cache-status") || "";
    if (!/HIT|STALE|REVALIDATED/i.test(cacheStatus)) {
      ctx.waitUntil(warmAsset(target, assetCacheCf, upstreamUrl).catch((e) => {
        logEvent("warm_error", { url: safeUrl(target), error: String(e) });
      }));
    }
  }

  const response = await buildResponse(upstream, target, base, { asset });
  response.headers.set("X-CFProxy-Route", route);
  logEvent("respond", {
    url: safeUrl(target),
    status: response.status,
    length: response.headers.get("content-length"),
    cache: response.headers.get("cf-cache-status"),
    ms: Date.now() - started,
  });
  return response;
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e) {
      logEvent("internal_error", { error: String(e) });
      return json({ error: "代理内部错误", detail: String(e) }, 500);
    }
  },
};
