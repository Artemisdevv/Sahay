"""WebSocket authentication: the token travels in the first message, not in the URL (access logs)."""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.main import app
from app.settings import settings
from tests.test_incidents_api import setup
from tests.ws_helpers import authenticate

client = TestClient(app)


def admin_token():
    return setup()["Authorization"].split()[1]


def test_first_message_auth_then_events_flow():
    token = admin_token()
    with client.websocket_connect("/ws/v1") as ws:
        authenticate(ws, token)
        ws.send_json({"type": "ping"})
        assert ws.receive_json() == {"type": "pong"}


def test_token_in_the_url_is_not_accepted(monkeypatch):
    monkeypatch.setattr(settings, "sahay_ws_auth_timeout_s", 0.3)
    token = admin_token()
    with client.websocket_connect(f"/ws/v1?token={token}") as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()  # no auth message was sent, so the server closes it
    assert closed.value.code == 1008


@pytest.mark.parametrize("first", [{"type": "auth", "token": "not-a-jwt"}, {"type": "auth"}, {"type": "ping"}, {"token": "x"}])
def test_bad_first_message_is_closed(first):
    with client.websocket_connect("/ws/v1") as ws:
        ws.send_json(first)
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 1008


def test_no_first_message_times_out(monkeypatch):
    monkeypatch.setattr(settings, "sahay_ws_auth_timeout_s", 0.3)
    with client.websocket_connect("/ws/v1") as ws:
        with pytest.raises(WebSocketDisconnect) as closed:
            ws.receive_json()
    assert closed.value.code == 1008


def test_no_events_before_auth():
    from app.events import manager

    token = admin_token()
    with client.websocket_connect("/ws/v1") as ws:
        assert not manager._clients  # not registered until authenticated
        authenticate(ws, token)
        assert len(manager._clients) == 1
