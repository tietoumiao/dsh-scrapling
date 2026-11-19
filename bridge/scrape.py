"""dsh-scrapling bridge — one JSON request on stdin, one JSON response on stdout.

Every scrapling log line goes to stderr, so stdout stays parseable.

OPS
---
fetch    one URL -> markdown / text / html
extract  one URL -> named fields, or rows (container x fields)
batch    many URLs -> per-URL fetch/extract, concurrent
site     crawl a site with ContentSpider -> per-page markdown items

SHARED REQUEST FIELDS
---------------------
url / urls, mode ("http" | "stealth"), timeout_ms, wait_ms, wait_selector,
headers, proxy, session (named cookie jar on disk), options (passthrough knobs,
whitelisted per engine), cache_dir (injected by the host plugin).
"""

import dataclasses
import json
import os
import re
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor

# ---------------------------------------------------------------------------
# Passthrough knob whitelists. These are exactly the JSON-representable keys of
# scrapling's GetRequestParams / DataRequestParams / StealthSession TypedDicts.
# Deliberately excluded because they are Python callables / live objects and
# therefore cannot cross a JSON boundary:
#   page_action, page_setup (callables), proxy_rotator (ProxyRotator object),
#   selector_config (carries callables), additional_args (live Playwright opts).
# ---------------------------------------------------------------------------
HTTP_OPTION_KEYS = {
    "impersonate", "http3", "stealthy_headers", "proxies", "proxy_auth",
    "retries", "retry_delay", "follow_redirects", "max_redirects",
    "verify", "cert", "params", "auth",
}
STEALTH_OPTION_KEYS = {
    "headless", "disable_resources", "network_idle", "load_dom", "pierce_shadow",
    "wait_selector_state", "google_search", "timezone_id", "init_script",
    "user_data_dir", "locale", "useragent", "extra_flags", "blocked_domains",
    "block_ads", "record_requests", "max_recorded_requests", "executable_path",
    "dns_over_https", "real_chrome", "allow_webgl", "hide_canvas",
    "block_webrtc", "solve_cloudflare", "max_pages", "retries", "retry_delay",
}

TRUNCATE_NOTE = "\n\n...[truncated %d chars; raise max_chars to see more]"


# ---------------------------------------------------------------------------
# plumbing
# ---------------------------------------------------------------------------
def emit(payload):
    data = json.dumps(payload, ensure_ascii=False, default=str)
    sys.stdout.buffer.write(data.encode("utf-8"))
    sys.stdout.buffer.flush()


def fail(message, kind="error"):
    emit({"ok": False, "kind": kind, "error": message})


def read_request():
    raw = sys.stdin.buffer.read()
    if not raw:
        raise ValueError("empty request on stdin")
    return json.loads(raw.decode("utf-8-sig"))


def as_int(value, default, low=None, high=None):
    try:
        if value is None or value == "":
            return default
        number = int(value)
    except (TypeError, ValueError):
        return default
    if low is not None and number < low:
        return default
    if high is not None and number > high:
        return default
    return number


def truncate(text, max_chars):
    if max_chars and max_chars > 0 and len(text) > max_chars:
        return text[:max_chars] + (TRUNCATE_NOTE % (len(text) - max_chars)), True
    return text, False


def compact(mapping):
    """Drop None values: the host's output schema has no nullable types."""
    return {key: value for key, value in mapping.items() if value is not None}


# ---------------------------------------------------------------------------
# named cookie jars (state across calls, since every call is its own process)
# ---------------------------------------------------------------------------
def cache_root(req):
    """Directory for cookie jars.

    `cache_dir` is injected by the host plugin (`<root>/.sessions`). Writing
    inside `<root>` is the only reliably writable location here: this machine
    denies a python child write access to the plugin directory itself, so a
    makedirs failure falls back instead of failing the fetch.
    """
    explicit = req.get("cache_dir")
    candidate = explicit or os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".cache")
    candidate = os.path.abspath(candidate)
    try:
        os.makedirs(candidate, exist_ok=True)
        return candidate
    except OSError:
        fallback = os.path.join(os.environ.get("TEMP") or os.path.dirname(candidate), "dsh-scrapling-sessions")
        try:
            os.makedirs(fallback, exist_ok=True)
        except OSError:
            return fallback
        return fallback


def session_file(req, name):
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", str(name)).strip("-") or "default"
    return os.path.join(cache_root(req), safe + ".json")


def load_session(req):
    name = req.get("session")
    if not name:
        return {}
    try:
        with open(session_file(req, name), "r", encoding="utf-8") as handle:
            data = json.load(handle)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def cookies_to_dict(cookies):
    """curl_cffi `Cookies` and plain dicts both end up as {name: value}."""
    if not cookies:
        return {}
    if isinstance(cookies, dict):
        return {str(k): str(v) for k, v in cookies.items()}
    out = {}
    try:
        for item in cookies:
            name = getattr(item, "name", None)
            value = getattr(item, "value", None)
            if name is not None and value is not None:
                out[str(name)] = str(value)
            elif isinstance(item, (list, tuple)) and len(item) == 2:
                out[str(item[0])] = str(item[1])
    except TypeError:
        pass
    return out


def cookies_from_set_cookie(headers):
    """Minimal `Set-Cookie` parser: the `name=value` pairs only.

    `headers` may be a dict, a curl_cffi `Headers`, or a list of pairs — `.get()`
    and `.items()` are both tried, case-insensitively on the name.
    """
    out = {}
    raw = None
    if headers is None:
        return out
    getter = getattr(headers, "get", None)
    if callable(getter):
        for key in ("set-cookie", "Set-Cookie", "SET-COOKIE"):
            try:
                value = getter(key)
            except Exception:
                value = None
            if value:
                raw = value
                break
    if raw is None:
        items = getattr(headers, "items", None)
        if callable(items):
            try:
                for key, value in items():
                    if str(key).lower() == "set-cookie":
                        raw = value
                        break
            except Exception:
                pass
    if not raw:
        return out
    for chunk in str(raw).split(","):
        pair = chunk.split(";")[0].strip()
        if "=" in pair:
            name, _, value = pair.partition("=")
            if name.strip():
                out[name.strip()] = value.strip()
    return out


def harvest_cookies(page):
    """Every cookie this exchange set, including the redirect chain.

    The final `Response.cookies` is only what THAT response set, which is empty
    whenever the server sets cookies on a 30x hop — the common login shape.
    """
    jar = cookies_to_dict(getattr(page, "cookies", None))
    jar.update(cookies_from_set_cookie(getattr(page, "headers", None)))
    for hop in (getattr(page, "history", None) or []):
        jar.update(cookies_to_dict(getattr(hop, "cookies", None)))
        jar.update(cookies_from_set_cookie(getattr(hop, "headers", None)))
    return jar


def save_session(req, cookies):
    name = req.get("session")
    if not name or not cookies:
        return
    path = session_file(req, name)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    merged = load_session(req)
    merged.update({str(k): str(v) for k, v in cookies.items()})
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(merged, handle, ensure_ascii=False, indent=0)


def cookie_header(cookies):
    return "; ".join("%s=%s" % (k, v) for k, v in cookies.items())


# ---------------------------------------------------------------------------
# request -> scrapling kwargs
# ---------------------------------------------------------------------------
def engine_options(req, mode):
    """Whitelisted `options`, or a ValueError listing what is supported."""
    allowed = STEALTH_OPTION_KEYS if mode == "stealth" else HTTP_OPTION_KEYS
    options = req.get("options") or {}
    if not isinstance(options, dict):
        raise ValueError("`options` must be an object")
    unknown = sorted(set(options) - allowed)
    if unknown:
        raise ValueError(
            "unsupported %s option(s): %s (supported: %s)"
            % (mode, ", ".join(unknown), ", ".join(sorted(allowed)))
        )
    return dict(options)


def build_kwargs(req, mode, timeout_ms):
    kwargs = engine_options(req, mode)
    headers = req.get("headers") if isinstance(req.get("headers"), dict) else None
    cookies = load_session(req)

    if mode == "stealth":
        kwargs.setdefault("headless", True)
        kwargs.setdefault("network_idle", True)
        kwargs["timeout"] = timeout_ms
        wait_ms = as_int(req.get("wait_ms"), 0, 0, 120000)
        if wait_ms:
            kwargs["wait"] = wait_ms
        wait_selector = req.get("wait_selector")
        if isinstance(wait_selector, str) and wait_selector.strip():
            kwargs["wait_selector"] = wait_selector.strip()
        if req.get("proxy"):
            kwargs["proxy"] = req["proxy"]
        extra = dict(kwargs.get("extra_headers") or {})
        if headers:
            extra.update(headers)
        if extra:
            kwargs["extra_headers"] = extra
        if cookies:
            kwargs.setdefault("cookies", cookies)
        return kwargs

    kwargs.setdefault("stealthy_headers", True)
    kwargs.setdefault("follow_redirects", True)
    kwargs["timeout"] = max(1, timeout_ms // 1000)
    if headers:
        merged = dict(kwargs.get("headers") or {})
        merged.update(headers)
        kwargs["headers"] = merged
    if req.get("proxy"):
        kwargs["proxy"] = req["proxy"]
    if cookies:
        merged = dict(kwargs.get("cookies") or {})
        for key, value in cookies.items():
            merged.setdefault(key, value)
        kwargs["cookies"] = merged
    return kwargs


def fetch_page(req):
    mode = (req.get("mode") or "http").lower()
    if mode not in ("http", "stealth"):
        raise ValueError('`mode` must be "http" or "stealth"')
    timeout_ms = as_int(req.get("timeout_ms"), 30000, 1000, 300000)
    url = req["url"]
    method = (req.get("method") or "GET").upper()
    kwargs = build_kwargs(req, mode, timeout_ms)

    if mode == "stealth":
        from scrapling.fetchers import StealthyFetcher

        if method != "GET":
            raise ValueError('`method` other than GET is not supported in stealth mode')
        return StealthyFetcher.fetch(url, **kwargs)

    from scrapling.fetchers import Fetcher

    if method == "POST":
        if req.get("json_body") is not None:
            kwargs["json"] = req["json_body"]
        elif req.get("body") is not None:
            kwargs["data"] = req["body"]
        return Fetcher.post(url, **kwargs)
    if method != "GET":
        raise ValueError('`method` must be "GET" or "POST"')
    return Fetcher.get(url, **kwargs)


# ---------------------------------------------------------------------------
# selector helpers (plain fields and per-row fields share one resolver)
# ---------------------------------------------------------------------------
def select(scope, selector, adaptive=False):
    selector = selector.strip()
    if selector.startswith("/") or selector.startswith("("):
        return scope.xpath(selector)
    if adaptive:
        return scope.css(selector, adaptive=True, auto_save=True)
    return scope.css(selector)


def node_text(node):
    """Text of one element.

    `.text` is the element's own text and is EMPTY for container elements
    (`div`, `body`, `article`); those need `get_all_text()` for the subtree.
    Falling back keeps `{selector: "body", regex: ...}` usable, which is the
    main reason to select a container at all.
    """
    text = getattr(node, "text", None)
    if text is None or (isinstance(text, str) and not text.strip()):
        getter = getattr(node, "get_all_text", None)
        if callable(getter):
            try:
                text = getter()
            except Exception:
                pass
    if text is None:
        text = str(node)
    return str(text).strip()


def node_value(node, attribute, regex):
    if attribute:
        attrib = getattr(node, "attrib", None) or {}
        value = attrib.get(attribute)
    else:
        value = node_text(node)
    if value is None:
        return None
    value = str(value).strip()
    if not value:
        return None
    if regex:
        match = re.search(regex, value, re.S)
        if not match:
            return None
        value = (match.group(1) if match.groups() else match.group(0)).strip()
        if not value:
            return None
    return value


def normalise_spec(spec):
    if isinstance(spec, str):
        return {"selector": spec}
    if isinstance(spec, dict):
        return spec
    raise ValueError("a field spec must be a selector string or an object")


def resolve_values(scope, spec, default_limit, adaptive=False):
    """Every value one field spec produces inside `scope`."""
    spec = normalise_spec(spec)
    selector = spec.get("selector")
    attribute = spec.get("attribute")
    regex = spec.get("regex")
    limit = as_int(spec.get("limit"), default_limit, 1, 1000)
    if spec.get("all") is True:
        limit = 1000
    if selector:
        nodes = select(scope, str(selector), adaptive)
    else:
        nodes = [scope]
    values = []
    for node in list(nodes)[:limit]:
        value = node_value(node, attribute, regex)
        if value:
            values.append(value)
    return values


def page_title(page):
    try:
        texts = page.css("title::text").getall()
        if texts:
            return texts[0].strip()
    except Exception:
        pass
    return ""


# ---------------------------------------------------------------------------
# fetch
# ---------------------------------------------------------------------------
def do_fetch(req):
    started = time.time()
    page = fetch_page(req)
    fmt = (req.get("format") or "markdown").lower()
    if fmt not in ("markdown", "text", "html"):
        fmt = "markdown"
    if fmt == "html":
        text = page.html_content or ""
    elif fmt == "text":
        text = page.get_all_text() or ""
    else:
        text = page.markdown() or ""
    content, truncated = truncate(text, as_int(req.get("max_chars"), 20000, 0, 2000000))
    save_session(req, harvest_cookies(page))
    return {
        "ok": True,
        "url": req["url"],
        "finalUrl": str(getattr(page, "url", "") or req["url"]),
        "status": int(getattr(page, "status", 0) or 0),
        "mode": (req.get("mode") or "http").lower(),
        "format": fmt,
        "title": page_title(page),
        "chars": len(content),
        "truncated": truncated,
        "elapsedMs": int((time.time() - started) * 1000),
        "content": content,
    }


# ---------------------------------------------------------------------------
# extract (fields and/or rows)
# ---------------------------------------------------------------------------
def do_extract(req):
    started = time.time()
    selectors = req.get("selectors") or {}
    rows = req.get("rows") or None
    if not selectors and not rows:
        raise ValueError("`selectors` or `rows` is required")
    if selectors and not isinstance(selectors, dict):
        raise ValueError("`selectors` must be an object")
    if rows is not None and not isinstance(rows, dict):
        raise ValueError("`rows` must be an object")

    adaptive = req.get("adaptive") is True
    attribute = req.get("attribute") or None
    default_limit = as_int(req.get("limit"), 20, 1, 200)
    page = fetch_page(req)
    save_session(req, harvest_cookies(page))

    result = {
        "ok": True,
        "url": req["url"],
        "finalUrl": str(getattr(page, "url", "") or req["url"]),
        "status": int(getattr(page, "status", 0) or 0),
        "mode": (req.get("mode") or "http").lower(),
        "title": page_title(page),
        "adaptive": adaptive,
        "count": 0,
        "elapsedMs": 0,
        "fields": [],
        "rows": [],
    }

    if selectors:
        for field, spec in selectors.items():
            try:
                if isinstance(spec, str) and attribute:
                    spec = {"selector": spec, "attribute": attribute}
                values = resolve_values(page, spec, default_limit, adaptive)
                result["fields"].append({"field": str(field), "values": values})
            except Exception as exc:
                result["fields"].append({
                    "field": str(field),
                    "values": [],
                    "error": "%s: %s" % (type(exc).__name__, exc),
                })
        result["count"] = sum(len(entry["values"]) for entry in result["fields"])

    if rows:
        container = rows.get("container") or rows.get("selector")
        if not isinstance(container, str) or not container.strip():
            raise ValueError("`rows.container` must be a CSS or XPath selector")
        field_specs = rows.get("fields") or {}
        if not isinstance(field_specs, dict) or not field_specs:
            raise ValueError("`rows.fields` must be a non-empty object of field name -> spec")
        row_limit = as_int(rows.get("limit"), default_limit, 1, 500)
        containers = select(page, container)
        items = []
        for node in list(containers)[:row_limit]:
            item = {}
            for name, spec in field_specs.items():
                try:
                    values = resolve_values(node, spec, 1)
                    item[str(name)] = values[0] if values else None
                except Exception as exc:
                    item[str(name)] = None
                    item[str(name) + "_error"] = "%s: %s" % (type(exc).__name__, exc)
            items.append(compact(item))
        result["rows"] = items
        result["rowCount"] = len(items)
        result["count"] += sum(1 for item in items for key, value in item.items()
                               if value is not None and not key.endswith("_error"))

    result["elapsedMs"] = int((time.time() - started) * 1000)
    return result


# ---------------------------------------------------------------------------
# batch (concurrent per-URL fetch or extract)
# ---------------------------------------------------------------------------
def do_batch(req):
    started = time.time()
    urls = req.get("urls")
    if not isinstance(urls, list) or not urls:
        raise ValueError("`urls` must be a non-empty array")
    urls = [str(url) for url in urls][:50]
    mode = (req.get("mode") or "http").lower()
    requested = as_int(req.get("concurrency"), 4, 1, 16)
    # One browser per worker is heavy: stealth batches stay serial unless asked.
    concurrency = 1 if mode == "stealth" else requested
    extract_mode = bool(req.get("selectors") or req.get("rows"))

    def one(url):
        sub = dict(req)
        sub["url"] = url
        sub.pop("urls", None)
        try:
            if extract_mode:
                value = do_extract(sub)
                return compact({
                    "url": url,
                    "status": value.get("status"),
                    "title": value.get("title"),
                    "fields": value.get("fields", []),
                    "rows": value.get("rows", []),
                })
            value = do_fetch(sub)
            return compact({
                "url": url,
                "status": value.get("status"),
                "finalUrl": value.get("finalUrl"),
                "title": value.get("title"),
                "chars": value.get("chars"),
                "truncated": value.get("truncated"),
                "content": value.get("content"),
            })
        except Exception as exc:
            return {"url": url, "error": "%s: %s" % (type(exc).__name__, exc)}

    if concurrency == 1:
        results = [one(url) for url in urls]
    else:
        with ThreadPoolExecutor(max_workers=concurrency) as pool:
            futures = [pool.submit(one, url) for url in urls]
            results = [future.result() for future in futures]

    ok = sum(1 for item in results if "error" not in item)
    return {
        "ok": True,
        "mode": mode,
        "concurrency": concurrency,
        "count": len(results),
        "succeeded": ok,
        "failed": len(results) - ok,
        "elapsedMs": int((time.time() - started) * 1000),
        "results": results,
    }


# ---------------------------------------------------------------------------
# site (ContentSpider crawl)
# ---------------------------------------------------------------------------
def do_site(req):
    from urllib.parse import urlparse

    from scrapling.spiders import ContentSpider

    started = time.time()
    url = req["url"]
    host = urlparse(url).netloc
    domains = req.get("allowed_domains")
    if isinstance(domains, list) and domains:
        allowed = {str(domain) for domain in domains}
    else:
        allowed = {host}

    max_pages = as_int(req.get("max_pages"), 10, 0, 500)
    max_total = as_int(req.get("max_total_chars"), 60000, 1000, 2000000)
    per_page = as_int(req.get("max_chars_per_page"), 12000, 500, 400000)
    concurrency = as_int(req.get("concurrency"), 4, 1, 16)
    crawl = type("DshScraplingCrawl", (ContentSpider,), {
        "name": "dsh-scrapling",
        "start_urls": [url],
        "allowed_domains": allowed,
        "max_pages": max_pages,
        "main_content_only": req.get("main_content_only") is not False,
        "css_selector": req.get("css_selector") or None,
        "concurrent_requests": concurrency,
        "robots_txt_obey": req.get("robots_txt_obey") is True,
        "download_delay": float(req.get("download_delay") or 0),
        "logging_level": 30,
    })

    spider = crawl()
    cookies = load_session(req)
    headers = req.get("headers") if isinstance(req.get("headers"), dict) else None
    if cookies or headers:
        merged = dict(headers or {})
        if cookies:
            merged.setdefault("Cookie", cookie_header(cookies))
        spider.default_headers = merged

    result = spider.start()
    items = list(getattr(result, "items", []) or [])
    pages = []
    total = 0
    stopped_by_budget = False
    for item in items:
        remaining = max_total - total
        if remaining <= 200:
            stopped_by_budget = True
            break
        markdown, truncated = truncate(str(item.get("markdown") or ""), min(per_page, remaining))
        total += len(markdown)
        pages.append({
            "url": str(item.get("url") or ""),
            "title": str(item.get("title") or ""),
            "chars": len(markdown),
            "truncated": truncated,
            "markdown": markdown,
        })

    stats = {}
    raw_stats = getattr(result, "stats", None)
    if raw_stats is not None:
        try:
            stats = dataclasses.asdict(raw_stats)
        except Exception:
            stats = {"repr": str(raw_stats)}

    return {
        "ok": True,
        "startUrl": url,
        "allowedDomains": sorted(allowed),
        "paused": bool(getattr(result, "paused", False)),
        "pageCount": len(pages),
        "totalChars": total,
        "stoppedByCharBudget": stopped_by_budget,
        "elapsedMs": int((time.time() - started) * 1000),
        "stats": stats,
        "pages": pages,
    }


OPS = {"fetch": do_fetch, "extract": do_extract, "batch": do_batch, "site": do_site}


def main():
    try:
        req = read_request()
    except Exception as exc:
        fail("could not read the request: %s: %s" % (type(exc).__name__, exc), "bad_request")
        return 1
    op = (req.get("op") or "fetch").lower()
    handler = OPS.get(op)
    if handler is None:
        fail("unknown op %r (expected one of: %s)" % (op, ", ".join(sorted(OPS))), "bad_request")
        return 1
    if op != "batch" and not req.get("url"):
        fail("`url` is required", "bad_request")
        return 1
    try:
        result = handler(req)
        if result is not None:
            emit(result)
        return 0
    except ModuleNotFoundError as exc:
        fail("scrapling is not importable in this interpreter: %s" % exc, "no_scrapling")
    except ValueError as exc:
        fail(str(exc), "bad_request")
    except Exception as exc:
        sys.stderr.write(traceback.format_exc())
        fail("%s: %s" % (type(exc).__name__, exc), "fetch_failed")
    return 1


if __name__ == "__main__":
    sys.exit(main())
