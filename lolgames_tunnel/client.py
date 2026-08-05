import argparse
import asyncio
import json
import os
import sys

from .common import CONTROL_PORT, b64, now_iso, recv, send, ub64, write_status
from .status_server import run_status_server


def default_history_file(status_file):
    base, ext = os.path.splitext(status_file)
    return f'{base}-history.jsonl' if ext else f'{status_file}-history.jsonl'


def add_event(args, status, event_type, message, level='ok', **fields):
    event = {
        'time': now_iso(),
        'level': level,
        'type': event_type,
        'message': message,
        'state': status.get('state', ''),
        'active_connections': int(status.get('active_connections') or 0),
        'total_connections': int(status.get('total_connections') or 0),
        'reconnects': int(status.get('reconnects') or 0),
        **fields,
    }
    try:
        os.makedirs(os.path.dirname(args.history_file) or '.', exist_ok=True)
        with open(args.history_file, 'a', encoding='utf-8') as f:
            json.dump(event, f, separators=(',', ':'))
            f.write('\n')
    except Exception as exc:
        print(f'failed to write history file {args.history_file}: {exc}', file=sys.stderr, flush=True)


async def client_once(args):
    target = args.target
    if target.startswith('localhost:'):
        host = '127.0.0.1'
        target_port = int(target.split(':', 1)[1])
    elif ':' in target:
        host, port_text = target.rsplit(':', 1)
        target_port = int(port_text)
    else:
        raise SystemExit('target must be host:port, e.g. localhost:3000')

    public_port = 0 if args.same_port else (args.public_port or target_port)
    status_base = {
        'ok': False,
        'state': 'connecting',
        'server': args.server,
        'control_port': CONTROL_PORT,
        'target': target,
        'target_host': host,
        'target_port': target_port,
        'same_port': bool(args.same_port),
        'public_port': public_port,
        'subdomain': args.name or '',
        'pid': os.getpid(),
        'started_at': now_iso(),
        'last_error': '',
        'last_ping_at': '',
        'last_pong_at': '',
        'last_open_at': '',
        'last_close_at': '',
        'active_connections': 0,
        'total_connections': 0,
        'reconnects': getattr(args, '_reconnects', 0),
        'history_file': args.history_file,
    }
    add_event(args, status_base, 'connect', f'connecting to broker {args.server}:{CONTROL_PORT}', level='info')
    write_status(args.status_file, status_base)

    reader, writer = await asyncio.open_connection(args.server, CONTROL_PORT)
    lock = asyncio.Lock()
    conns = {}
    try:
        registration = {
            'type': 'register',
            'subdomain': args.name,
            'public_port': public_port,
            'display_port': target_port,
        }
        expires_at = os.environ.get('LOLGAMES_TUNNEL_EXPIRES_AT', '').strip()
        if expires_at:
            registration['expires_at'] = expires_at
        await send(writer, registration, lock)
        try:
            msg = await asyncio.wait_for(recv(reader), timeout=45)
        except asyncio.TimeoutError as exc:
            # A broker reboot can orphan the control connection before
            # registration; fail fast instead of hanging in state 'connecting'.
            raise ConnectionError('broker did not answer registration within 45s') from exc
        if not msg:
            raise ConnectionError('broker closed control connection before registration')
    except BaseException:
        writer.close()
        raise
    print(msg['url'], flush=True)
    status = {
        **status_base,
        'ok': True,
        'state': 'registered',
        'url': msg.get('url', ''),
        'subdomain': msg.get('subdomain') or args.name or '',
        'public_port': int(msg.get('port') or public_port),
    }
    add_event(args, status, 'register', f'registered {status.get("url", "")} -> {target}', url=status.get('url', ''), target=target)
    write_status(args.status_file, status)

    async def keepalive():
        while True:
            await asyncio.sleep(args.keepalive_interval)
            status['last_ping_at'] = now_iso()
            add_event(args, status, 'ping', 'sent keepalive ping')
            write_status(args.status_file, status)
            await send(writer, {'type': 'ping'}, lock)

    async def pump_local(conn_id, local_reader):
        try:
            while True:
                data = await local_reader.read(32768)
                if not data:
                    break
                await send(writer, {'type': 'data', 'id': conn_id, 'data': b64(data)}, lock)
        finally:
            try:
                await send(writer, {'type': 'close', 'id': conn_id}, lock)
            finally:
                status['last_close_at'] = now_iso()
                status['active_connections'] = max(0, int(status.get('active_connections') or 0) - 1)
                add_event(args, status, 'close', f'closed connection {conn_id}', connection_id=conn_id)
                write_status(args.status_file, status)

    keepalive_task = asyncio.create_task(keepalive())
    try:
        while True:
            try:
                msg = await asyncio.wait_for(recv(reader), timeout=45)
            except asyncio.TimeoutError:
                print('control session idle timeout; reconnecting', file=sys.stderr, flush=True)
                status['last_error'] = 'control session idle timeout'
                add_event(args, status, 'reconnect', 'control session idle timeout; reconnecting', level='warn', error=status['last_error'])
                write_status(args.status_file, status)
                break
            if msg is None:
                break
            typ = msg.get('type')
            conn_id = msg.get('id')
            if typ == 'pong':
                status['last_pong_at'] = now_iso()
                add_event(args, status, 'pong', 'received keepalive pong')
                write_status(args.status_file, status)
                continue
            if typ == 'open':
                status['last_open_at'] = now_iso()
                status['active_connections'] = int(status.get('active_connections') or 0) + 1
                status['total_connections'] = int(status.get('total_connections') or 0) + 1
                public_port = int(msg.get('port') or target_port)
                connect_port = public_port if args.same_port else target_port
                add_event(args, status, 'open', f'opened connection {conn_id} on port {public_port}', connection_id=conn_id, public_port=public_port, target_port=connect_port)
                write_status(args.status_file, status)
                try:
                    local_reader, local_writer = await asyncio.open_connection(host, connect_port)
                except Exception as exc:
                    status['last_error'] = str(exc)
                    status['active_connections'] = max(0, int(status.get('active_connections') or 0) - 1)
                    add_event(args, status, 'error', f'target connection failed: {exc}', level='error', connection_id=conn_id, target_port=connect_port, error=str(exc))
                    write_status(args.status_file, status)
                    await send(writer, {'type': 'close', 'id': conn_id, 'error': str(exc)}, lock)
                    continue
                conns[conn_id] = local_writer
                initial = ub64(msg.get('initial', ''))
                if initial:
                    local_writer.write(initial)
                    await local_writer.drain()
                task = asyncio.create_task(pump_local(conn_id, local_reader))
                task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
            elif typ == 'data' and conn_id in conns:
                conns[conn_id].write(ub64(msg['data']))
                await conns[conn_id].drain()
            elif typ == 'close' and conn_id in conns:
                status['last_close_at'] = now_iso()
                status['active_connections'] = max(0, int(status.get('active_connections') or 0) - 1)
                add_event(args, status, 'close', f'broker closed connection {conn_id}', connection_id=conn_id)
                write_status(args.status_file, status)
                conns.pop(conn_id).close()
    finally:
        status['ok'] = False
        status['state'] = 'disconnected'
        add_event(args, status, 'reconnect', 'control connection disconnected', level='warn')
        write_status(args.status_file, status)
        keepalive_task.cancel()
        await asyncio.gather(keepalive_task, return_exceptions=True)
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def client(args):
    if not args.history_file:
        args.history_file = default_history_file(args.status_file)
    args._reconnects = 0
    status_task = None
    if args.status_http:
        status_task = asyncio.create_task(run_status_server(args.status_http, args.status_file))
    try:
        while True:
            try:
                await client_once(args)
            except (KeyboardInterrupt, asyncio.CancelledError):
                raise
            except Exception as exc:
                status = {
                    'ok': False,
                    'state': 'error',
                    'server': args.server,
                    'control_port': CONTROL_PORT,
                    'target': args.target,
                    'subdomain': args.name or '',
                    'pid': os.getpid(),
                    'reconnects': args._reconnects,
                    'last_error': str(exc),
                    'history_file': args.history_file,
                }
                add_event(args, status, 'error', f'control connection lost: {exc}', level='error', error=str(exc))
                write_status(args.status_file, status)
                print(f'control connection lost: {exc}; reconnecting in {args.reconnect_delay}s', file=sys.stderr, flush=True)
            args._reconnects += 1
            await asyncio.sleep(args.reconnect_delay)
    finally:
        if status_task:
            status_task.cancel()
            await asyncio.gather(status_task, return_exceptions=True)


def add_client_args(parser):
    parser.add_argument('target')
    parser.add_argument('--server', default='agentsweb.space')
    parser.add_argument('--name')
    parser.add_argument('--public-port', type=int)
    parser.add_argument('--same-port', action='store_true', help='route any public port on this hostname to the same port on the target host')
    parser.add_argument('--reconnect-delay', type=float, default=2.0, help='seconds to wait before reconnecting the control session after a broker reset')
    parser.add_argument('--keepalive-interval', type=float, default=10.0, help='seconds between control-session pings')
    parser.add_argument('--status-file', default=os.environ.get('LOLGAMES_TUNNEL_STATUS_FILE', '/tmp/lolgames-tunnel-status.json'), help='JSON status file written by the client')
    parser.add_argument('--history-file', default=os.environ.get('LOLGAMES_TUNNEL_HISTORY_FILE', ''), help='JSONL history file written by the client')
    parser.add_argument('--status-http', default=os.environ.get('LOLGAMES_TUNNEL_STATUS_HTTP', ''), help='optional status UI bind address, e.g. 127.0.0.1:1457')
    return parser


def main():
    parser = add_client_args(argparse.ArgumentParser(description='Run agentsweb tunnel client'))
    args = parser.parse_args()
    if not args.history_file:
        args.history_file = default_history_file(args.status_file)
    asyncio.run(client(args))


if __name__ == '__main__':
    main()
