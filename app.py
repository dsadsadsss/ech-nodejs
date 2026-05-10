import asyncio
import os
import json
import time
import socket
import logging
from aiohttp import web
import aiohttp
import aiohttp.web_ws

# ── 配置 ──────────────────────────────────────────────────────────────────────
PORT = int(os.environ.get('PORT', 3000))
TOKEN = os.environ.get('TOKEN', '123')
CF_FALLBACK_IPS = (
    os.environ.get('PRIP', 'ProxyIP.JP.CMLiussss.net').split(',')
)

DOH_SERVERS = [
    'https://dns.google/dns-query',
    'https://cloudflare-dns.com/dns-query',
    'https://dns.alidns.com/dns-query',
]

DNS_CACHE_TTL = 300          # 秒
dns_cache: dict[str, tuple[str, float]] = {}   # hostname -> (ip, timestamp)

logging.basicConfig(
    level=logging.INFO,
    format='[%(levelname)s] %(message)s',
)
log = logging.getLogger(__name__)


# ── DoH 解析 ─────────────────────────────────────────────────────────────────

def _is_ip(host: str) -> bool:
    """判断字符串是否为 IP 地址（IPv4 / IPv6）。"""
    try:
        socket.inet_pton(socket.AF_INET, host)
        return True
    except OSError:
        pass
    try:
        socket.inet_pton(socket.AF_INET6, host)
        return True
    except OSError:
        pass
    return False


async def _query_doh(session: aiohttp.ClientSession, server: str, hostname: str) -> str | None:
    """向单个 DoH 服务器查询 A 记录，返回第一个 IP 或 None。"""
    url = f"{server}?name={hostname}&type=A"
    try:
        async with session.get(
            url,
            headers={'Accept': 'application/dns-json'},
            timeout=aiohttp.ClientTimeout(total=5),
        ) as resp:
            data = await resp.json(content_type=None)
            for answer in data.get('Answer', []):
                if answer.get('type') == 1:   # A 记录
                    return answer['data']
    except Exception as exc:
        log.error(f"[DoH Failed] {server}: {exc}")
    return None


async def resolve_doh(hostname: str) -> str:
    """
    通过 DoH 解析域名，带缓存。
    若所有 DoH 服务器失败则回退到系统 DNS。
    """
    if _is_ip(hostname):
        return hostname

    # 缓存命中
    cached = dns_cache.get(hostname)
    if cached and (time.time() - cached[1]) < DNS_CACHE_TTL:
        log.info(f"[DoH Cache Hit] {hostname} -> {cached[0]}")
        return cached[0]

    log.info(f"[DoH Query] Resolving {hostname}...")

    async with aiohttp.ClientSession() as session:
        for server in DOH_SERVERS:
            ip = await _query_doh(session, server, hostname)
            if ip:
                dns_cache[hostname] = (ip, time.time())
                log.info(f"[DoH Success] {hostname} -> {ip} (via {server})")
                return ip

    # 回退到系统 DNS
    log.info(f"[DoH Fallback] Using system DNS for {hostname}")
    loop = asyncio.get_event_loop()
    try:
        infos = await loop.getaddrinfo(hostname, None, family=socket.AF_INET)
        if infos:
            ip = infos[0][4][0]
            dns_cache[hostname] = (ip, time.time())
            return ip
    except Exception as exc:
        log.error(f"[System DNS Failed] {hostname}: {exc}")

    raise RuntimeError(f"Failed to resolve {hostname}")


# ── 地址解析 ─────────────────────────────────────────────────────────────────

def parse_address(addr: str) -> tuple[str, int]:
    """解析 'host:port' 或 '[ipv6]:port' 格式。"""
    if addr.startswith('['):
        end = addr.index(']')
        host = addr[1:end]
        port = int(addr[end + 2:])
    else:
        sep = addr.rfind(':')
        host = addr[:sep]
        port = int(addr[sep + 1:])
    return host, port


def is_cf_error(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(k in msg for k in ('proxy request', 'cannot connect', 'connection refused', 'timed out'))


# ── WebSocket 会话处理 ────────────────────────────────────────────────────────

async def handle_session(ws: web.WebSocketResponse) -> None:
    remote_reader: asyncio.StreamReader | None = None
    remote_writer: asyncio.StreamWriter | None = None
    closed = False
    pump_task: asyncio.Task | None = None

    async def cleanup():
        nonlocal closed, remote_writer, pump_task
        if closed:
            return
        closed = True
        if pump_task and not pump_task.done():
            pump_task.cancel()
        if remote_writer:
            try:
                remote_writer.close()
                await remote_writer.wait_closed()
            except Exception:
                pass
            remote_writer = None
        if not ws.closed:
            await ws.close(code=1000, message='Server closed')

    async def pump_remote_to_ws(reader: asyncio.StreamReader) -> None:
        """持续读取远端数据并转发给 WebSocket 客户端。"""
        try:
            while not closed:
                data = await reader.read(65536)
                if not data:
                    if not closed:
                        await ws.send_str('CLOSE')
                    break
                if not ws.closed:
                    await ws.send_bytes(data)
        except asyncio.CancelledError:
            pass
        except Exception:
            pass
        finally:
            await cleanup()

    async def connect_to_remote(target_addr: str, first_data: bytes | None) -> None:
        nonlocal remote_reader, remote_writer, pump_task

        host, port = parse_address(target_addr)
        attempts = [None, *CF_FALLBACK_IPS]

        for i, override in enumerate(attempts):
            target_host = override or host
            try:
                resolved = target_host
                if not _is_ip(target_host):
                    try:
                        resolved = await resolve_doh(target_host)
                        log.info(f"[Connect] {target_host} resolved to {resolved}")
                    except Exception as exc:
                        log.error(f"[DNS Error] {target_host}: {exc}")

                remote_reader, remote_writer = await asyncio.wait_for(
                    asyncio.open_connection(resolved, port),
                    timeout=10,
                )

                if first_data:
                    remote_writer.write(first_data)
                    await remote_writer.drain()

                await ws.send_str('CONNECTED')
                pump_task = asyncio.create_task(pump_remote_to_ws(remote_reader))
                return

            except Exception as exc:
                if remote_writer:
                    try:
                        remote_writer.close()
                    except Exception:
                        pass
                    remote_writer = None
                    remote_reader = None

                if not is_cf_error(exc) or i == len(attempts) - 1:
                    raise

    # 主消息循环
    async for msg in ws:
        if closed:
            break

        if msg.type == aiohttp.WSMsgType.TEXT:
            text: str = msg.data

            if text.startswith('CONNECT:'):
                sep = text.index('|', 8)
                target_addr = text[8:sep]
                first_payload = text[sep + 1:].encode()
                try:
                    await connect_to_remote(target_addr, first_payload or None)
                except Exception as exc:
                    try:
                        await ws.send_str(f"ERROR:{exc}")
                    except Exception:
                        pass
                    await cleanup()

            elif text.startswith('DATA:'):
                payload = text[5:].encode()
                if remote_writer and not remote_writer.is_closing():
                    remote_writer.write(payload)
                    await remote_writer.drain()

            elif text == 'CLOSE':
                await cleanup()

        elif msg.type == aiohttp.WSMsgType.BINARY:
            if remote_writer and not remote_writer.is_closing():
                remote_writer.write(msg.data)
                await remote_writer.drain()

        elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.ERROR):
            break

    await cleanup()


# ── HTTP 路由 ─────────────────────────────────────────────────────────────────

async def handle_stats(request: web.Request) -> web.Response:
    payload = {
        'cacheSize': len(dns_cache),
        'dohServers': DOH_SERVERS,
    }
    return web.Response(
        text=json.dumps(payload),
        content_type='application/json',
    )


async def handle_root(request: web.Request) -> web.StreamResponse:
    """根路径同时处理普通 HTTP 和 WebSocket 升级请求（与原 Node.js 版行为一致）。"""
    if request.headers.get('Upgrade', '').lower() == 'websocket':
        # Token 验证
        protocol = request.headers.get('Sec-WebSocket-Protocol', '')
        if TOKEN and protocol != TOKEN:
            log.warning(f"[WS Reject] bad token from {request.remote}: got='{protocol}'")
            raise web.HTTPForbidden()

        ws = web.WebSocketResponse(protocols=[TOKEN] if TOKEN else ())
        await ws.prepare(request)
        log.info(f"[WS Connected] {request.remote}")

        try:
            await handle_session(ws)
        except Exception:
            pass

        return ws

    # 普通 HTTP GET → Hello-world
    return web.Response(text='Hello-world')


# ── 入口 ──────────────────────────────────────────────────────────────────────

def main() -> None:
    app = web.Application()
    app.router.add_get('/', handle_root)    # 根路径同时承载 HTTP 和 WebSocket
    app.router.add_get('/stats', handle_stats)

    log.info(f"Web listening on port {PORT}")
    log.info(f"Token authentication: {'enabled' if TOKEN else 'disabled'}")
    log.info(f"DoH Servers: {', '.join(DOH_SERVERS)}")
    log.info(f"DNS Cache TTL: {DNS_CACHE_TTL}s")

    web.run_app(app, host='0.0.0.0', port=PORT)


if __name__ == '__main__':
    main()
