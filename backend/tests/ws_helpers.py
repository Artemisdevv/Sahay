def authenticate(ws, token: str) -> None:
    """WebSocket login: the JWT goes in the first message, never in the URL."""
    ws.send_json({"type": "auth", "token": token})
    assert ws.receive_json() == {"type": "auth.ok"}
