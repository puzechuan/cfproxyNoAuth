import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../src";

afterEach(() => {
	vi.unstubAllGlobals();
});

async function call(request) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe("代理入口", () => {
	it("/health 返回健康状态", async () => {
		const response = await call(new Request("http://example.com/health"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ ok: true, service: "cfproxy" });
	});

	it("根路径返回静态页面", async () => {
		const response = await call(new Request("http://example.com/"));
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
	});

	it("拒绝白名单外域名", async () => {
		const response = await call(new Request("http://example.com/https://evil.example.com/x"));
		expect(response.status).toBe(400);
	});
});

describe("重定向处理", () => {
	it("普通页面：Location 使用相对路径，避免跳到 workers.dev", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(null, {
					status: 302,
					headers: {
						Location: "https://release-assets.githubusercontent.com/file?sp=r&sig=abc",
					},
				})
			)
		);

		const request = new Request(
			"http://example.com/https://github.com/OpenListTeam/OpenList/releases",
			{ headers: { Host: "cfproxy.koomer.site" } }
		);
		const response = await call(request);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"/https://release-assets.githubusercontent.com/file?sp=r&sig=abc"
		);
		expect(response.headers.get("location")).not.toContain("workers.dev");
		expect(response.headers.get("cache-control")).toBe("no-store");
	});

	it("下载资源：服务端跟随重定向，浏览器看不到签名链接", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("binary", {
				status: 200,
				headers: {
					"Content-Type": "application/octet-stream",
					"Content-Length": "6",
					"Accept-Ranges": "bytes",
				},
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const request = new Request(
			"http://example.com/https://github.com/OpenListTeam/OpenList/releases/download/v4.2.10/openlist-darwin-amd64.tar.gz",
			{ headers: { Host: "cfproxy.koomer.site" } }
		);
		const response = await call(request);

		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(response.headers.get("content-length")).toBe("6");
		expect(response.headers.get("accept-ranges")).toBe("bytes");

		const sub = fetchMock.mock.calls[0][0];
		expect(sub.redirect).toBe("follow");
		expect(sub.cf.cacheKey).toBe(
			"cfproxy:asset:github.com/OpenListTeam/OpenList/releases/download/v4.2.10/openlist-darwin-amd64.tar.gz"
		);
		expect(sub.cf.cacheEverything).toBe(true);
	});
});

describe("下载加速与缓存", () => {
	it("latest/download 也由服务端跟随，浏览器看不到签名链接且可缓存", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("binary", {
				status: 200,
				headers: { "Content-Type": "application/octet-stream", "Content-Length": "6" },
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			new Request(
				"http://example.com/https://github.com/OpenListTeam/OpenList/releases/latest/download/tool.tar.gz",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("location")).toBeNull();
		expect(response.headers.get("cache-control")).toBe("public, max-age=86400");
		expect(fetchMock.mock.calls[0][0].redirect).toBe("follow");
	});

	it("直接访问签名资源链接时使用剥离查询串的稳定缓存键", async () => {
		const fetchMock = vi.fn(async () => new Response("binary", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await call(
			new Request(
				"http://example.com/https://release-assets.githubusercontent.com/github-production-release-asset/123/tool.tar.gz?sig=abc&jwt=def",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(fetchMock.mock.calls[0][0].cf.cacheKey).toBe(
			"cfproxy:asset:release-assets.githubusercontent.com/github-production-release-asset/123/tool.tar.gz"
		);
	});

	it("并发 Range 未命中只预热一次完整对象，且预热不带条件请求头", async () => {
		const fetchMock = vi.fn((req) => {
			const isRange = req.headers.has("range");
			const response = new Response(isRange ? "0123456789" : "full-object", {
				status: isRange ? 206 : 200,
				headers: isRange
					? { "Content-Range": "bytes 0-9/100", "Content-Length": "10" }
					: { "Content-Length": "11", "Accept-Ranges": "bytes" },
			});
			// 让预热保持 pending，确保并发请求能命中"正在预热"状态
			return isRange
				? Promise.resolve(response)
				: new Promise((resolve) => setTimeout(() => resolve(response), 40));
		});
		vi.stubGlobal("fetch", fetchMock);

		const make = () =>
			new Request(
				"http://example.com/https://github.com/foo/bar/releases/download/v1/tool.tar.gz",
				{
					headers: {
						Host: "cfproxy.koomer.site",
						Range: "bytes=0-9",
						"If-None-Match": "etag-1",
					},
				}
			);

		const ctx1 = createExecutionContext();
		const ctx2 = createExecutionContext();
		await Promise.all([
			worker.fetch(make(), env, ctx1),
			worker.fetch(make(), env, ctx2),
		]);
		await Promise.all([waitOnExecutionContext(ctx1), waitOnExecutionContext(ctx2)]);

		// 两次 Range 请求 + 一次完整预热，而不是两次完整预热
		expect(fetchMock).toHaveBeenCalledTimes(3);
		const warm = fetchMock.mock.calls.find(([req]) => !req.headers.has("range"));
		expect(warm).toBeDefined();
		expect(warm[0].headers.has("if-none-match")).toBe(false);
	});
});

describe("异常上游与过期签名", () => {
	it("上游返回 status 0 的 error response 时返回 502 而不是 500", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.error()));

		const response = await call(
			new Request(
				"http://example.com/https://raw.githubusercontent.com/a/b/main/file.txt",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(502);
	});

	it("过期签名的 release-assets 链接返回带指引的 410 提示页", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Forbidden", { status: 403 }))
		);

		const response = await call(
			new Request(
				"http://example.com/https://release-assets.githubusercontent.com/blob/abc?sig=expired",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(410);
		expect(response.headers.get("content-type")).toContain("text/html");
		const html = await response.text();
		expect(html).toContain("下载链接已过期");
		expect(html).toContain("/https://github.com/用户/仓库/releases");
	});

	it("签名链接遇到 status 0 的 error response 也返回过期提示页", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => Response.error()));

		const response = await call(
			new Request(
				"http://example.com/https://release-assets.githubusercontent.com/blob/abc?sig=expired",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(410);
		expect(await response.text()).toContain("下载链接已过期");
	});

	it("签名有效的正常下载不受影响", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response("binary", {
					status: 200,
					headers: { "Content-Type": "application/octet-stream" },
				})
			)
		);

		const response = await call(
			new Request(
				"http://example.com/https://release-assets.githubusercontent.com/blob/abc?sig=valid",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(200);
	});
});

describe("GitHub 静态资源代理", () => {
	it("github.githubassets.com 走代理并启用缓存", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("body", {
				status: 200,
				headers: { "Content-Type": "application/javascript", "Content-Length": "4" },
			})
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			new Request(
				"http://example.com/https://github.githubassets.com/assets/app.js",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(200);
		const sub = fetchMock.mock.calls[0][0];
		expect(sub.url).toBe("https://github.githubassets.com/assets/app.js");
		expect(sub.cf.cacheEverything).toBe(true);
	});

	it("CSS 里的绝对 URL 也会被重写", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response('body{background:url(https://github.githubassets.com/img/bg.png)}', {
					status: 200,
					headers: { "Content-Type": "text/css; charset=utf-8" },
				})
			)
		);

		const response = await call(
			new Request(
				"https://example.com/https://github.githubassets.com/assets/app.css",
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);
		expect(await response.text()).toContain(
			"https://cfproxy.koomer.site/https://github.githubassets.com/img/bg.png"
		);
	});

	it("支持 *.github.io 子域（与首页白名单一致）", async () => {
		const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const response = await call(
			new Request("http://example.com/https://foo.github.io/index.html", {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);
		expect(response.status).toBe(200);
		expect(fetchMock.mock.calls[0][0]).toBe("https://foo.github.io/index.html");
	});

	it("响应头暴露边缘缓存命中状态", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response("x", {
					status: 200,
					headers: { "CF-Cache-Status": "HIT", Age: "12" },
				})
			)
		);

		const response = await call(
			new Request("http://example.com/https://raw.githubusercontent.com/a/b/main/x", {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);
		expect(response.headers.get("x-cfproxy-cache")).toBe("HIT");
		expect(response.headers.get("age")).toBeNull();
	});
});

describe("显式预热接口", () => {
	const target = "https://github.com/foo/bar/releases/download/v1/tool.tar.gz";

	function stubFetch() {
		const fetchMock = vi.fn(async (req) => {
			if (typeof req !== "string" && req.headers.has("range")) {
				return new Response(null, {
					status: 206,
					headers: { "CF-Cache-Status": "HIT" },
				});
			}
			return new Response("binary", {
				status: 200,
				headers: { "Content-Length": "6" },
			});
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("/__warm 等完整对象下载完成后返回字节数与缓存状态", async () => {
		const fetchMock = stubFetch();
		const response = await call(
			new Request(
				"http://example.com/__warm?url=" + encodeURIComponent(target),
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);

		expect(response.status).toBe(200);
		const data = await response.json();
		expect(data.ok).toBe(true);
		expect(data.bytes).toBe(6);
		expect(data.cache).toBe("HIT");

		const warm = fetchMock.mock.calls.find(
			([req]) => typeof req !== "string" && !req.headers.has("range")
		);
		expect(warm[0].cf.cacheEverything).toBe(true);
		expect(warm[0].cf.cacheKey).toBe("cfproxy:asset:github.com/foo/bar/releases/download/v1/tool.tar.gz");
	});

	it("并发预热同一对象只回源一次", async () => {
		const fetchMock = stubFetch();
		const make = () =>
			new Request("http://example.com/__warm?url=" + encodeURIComponent(target), {
				headers: { Host: "cfproxy.koomer.site" },
			});
		const ctx1 = createExecutionContext();
		const ctx2 = createExecutionContext();
		const [r1, r2] = await Promise.all([
			worker.fetch(make(), env, ctx1),
			worker.fetch(make(), env, ctx2),
		]);
		await Promise.all([waitOnExecutionContext(ctx1), waitOnExecutionContext(ctx2)]);

		expect((await r1.json()).ok).toBe(true);
		expect((await r2.json()).ok).toBe(true);
		// 1 次完整预热 + 2 次 1 字节验证
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("非下载资源拒绝预热", async () => {
		stubFetch();
		const response = await call(
			new Request(
				"http://example.com/__warm?url=" +
					encodeURIComponent("https://github.com/foo/bar"),
				{ headers: { Host: "cfproxy.koomer.site" } }
			)
		);
		expect(response.status).toBe(400);
		expect((await response.json()).ok).toBe(false);
	});
});

describe("CSP 重写", () => {
	it("HTML 页面的 CSP 放行代理域名，避免样式和脚本被拦截", async () => {
		const csp =
			"default-src 'none'; base-uri 'self'; " +
			"style-src 'unsafe-inline' github.githubassets.com; " +
			"script-src github.githubassets.com 'sha256-abc'; " +
			"font-src github.githubassets.com; img-src 'self' data:";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response("<html><head></head><body>hi</body></html>", {
					status: 200,
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Security-Policy": csp,
						"Content-Security-Policy-Report-Only": "script-src 'none'",
					},
				})
			)
		);

		const response = await call(
			new Request("https://example.com/https://github.com/foo/bar", {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);
		const out = response.headers.get("content-security-policy");
		expect(out).toContain(
			"style-src 'unsafe-inline' github.githubassets.com https://cfproxy.koomer.site"
		);
		expect(out).toContain(
			"font-src github.githubassets.com https://cfproxy.koomer.site"
		);
		expect(out).toContain(
			"script-src github.githubassets.com 'sha256-abc' https://cfproxy.koomer.site"
		);
		expect(out).toContain("base-uri 'self'");
		expect(response.headers.get("content-security-policy-report-only")).toBeNull();
	});
});

describe("回源线路优选", () => {
	const assetUrl = "https://github.com/foo/bar/releases/download/v1/tool.tar.gz";

	async function callWith(request, customEnv) {
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, customEnv, ctx);
		await waitOnExecutionContext(ctx);
		return response;
	}

	function assetRequest() {
		return new Request("http://example.com/" + assetUrl, {
			headers: { Host: "cfproxy.koomer.site" },
		});
	}

	it("配置镜像后走镜像，但缓存键仍基于原始 GitHub URL", async () => {
		const fetchMock = vi.fn(async () =>
			new Response("binary", { status: 200 })
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await callWith(assetRequest(), {
			UPSTREAM_MIRRORS: JSON.stringify(["https://mirror.example"]),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("x-cfproxy-route")).toBe("mirror.example");
		const sub = fetchMock.mock.calls[0][0];
		expect(sub.url).toBe("https://mirror.example/" + assetUrl);
		expect(sub.cf.cacheKey).toBe(
			"cfproxy:asset:github.com/foo/bar/releases/download/v1/tool.tar.gz"
		);
	});

	it("首选线路 5xx 或网络失败时自动切到下一条", async () => {
		const fetchMock = vi.fn(async (req) => {
			if (req.url.startsWith("https://mirror1.example")) {
				return new Response("bad", { status: 503 });
			}
			if (req.url.startsWith("https://mirror2.example")) {
				throw new Error("network down");
			}
			return new Response("binary", { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const response = await callWith(assetRequest(), {
			UPSTREAM_MIRRORS: JSON.stringify([
				"https://mirror1.example",
				"https://mirror2.example",
			]),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("x-cfproxy-route")).toBe("direct");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("/health 不缓存，便于确认线上版本", async () => {
		const response = await call(new Request("http://example.com/health"));
		expect(response.headers.get("cache-control")).toBe("no-store");
	});
});

describe("内联脚本哈希", () => {
	it("HTML 改写后重算 CSP 中的 sha256，避免脚本被拦截导致骨架屏", async () => {
		const oldHash = "'sha256-oldHash='";
		const html =
			'<html><head><script>window.x="https://github.com/foo/bar";</script></head><body>x</body></html>';
		const csp =
			"default-src 'none'; script-src github.githubassets.com " +
			oldHash +
			"; style-src 'unsafe-inline' github.githubassets.com";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(html, {
					status: 200,
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Security-Policy": csp,
					},
				})
			)
		);

		const response = await call(
			new Request("https://example.com/https://github.com/foo/bar", {
				headers: { Host: "cfproxy.koomer.site" },
			})
		);
		const finalHtml = await response.text();
		const scriptBody = finalHtml.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
		const digest = await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(scriptBody)
		);
		let binary = "";
		for (const byte of new Uint8Array(digest)) {
			binary += String.fromCharCode(byte);
		}
		const expected = "sha256-" + btoa(binary);
		const out = response.headers.get("content-security-policy");

		expect(finalHtml).toContain(
			"https://cfproxy.koomer.site/https://github.com/foo/bar"
		);
		expect(out).not.toContain(oldHash);
		expect(out).toContain(expected);
	});
});

describe("内容链接重写", () => {
	it("使用请求 Host 作为代理地址", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response('<a href="https://github.com/foo/bar">x</a>', {
					status: 200,
					headers: {
						"Content-Type": "text/html; charset=utf-8",
						"Content-Length": "45",
					},
				})
			)
		);

		const request = new Request("https://example.com/https://raw.githubusercontent.com/a/b/main/readme.md", {
			headers: { Host: "cfproxy.koomer.site" },
		});
		const response = await call(request);
		const html = await response.text();

		expect(html).toContain("https://cfproxy.koomer.site/https://github.com/foo/bar");
		expect(html).not.toContain("http://example.com/https://github.com");
		// 文本被改写后原 Content-Length 已失效，必须移除
		expect(response.headers.get("content-length")).toBeNull();
	});
});
