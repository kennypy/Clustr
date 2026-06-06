"""
Tests for the connection retry policy:

- reads (proxmox_get) recover transparently from a transient connection drop.
- writes (proxmox_post) are NOT auto-retried (no double-execution), but the
  dead connection is reset so the next call rebuilds it.
"""

import pytest
from requests.exceptions import ConnectionError as RequestsConnectionError

import clustr.proxmox.client as cl
from clustr.proxmox.client import ProxmoxError


class _Fake:
    def __init__(self, alive: bool) -> None:
        self.alive = alive

    def go(self) -> str:
        if not self.alive:
            raise RequestsConnectionError("stale socket")
        return "ok"


@pytest.fixture
def fake_builds(monkeypatch):
    """Replace the connection builder with a controllable sequence of clients."""
    state = {"build": 0, "calls": 0}
    seq = [_Fake(False), _Fake(True)]  # first dead, rebuilt one is alive

    def fake_build():
        c = seq[min(state["build"], len(seq) - 1)]
        state["build"] += 1
        return c

    cl.reset_client()
    monkeypatch.setattr(cl, "_build_client", fake_build)
    yield state
    cl.reset_client()


def _call_go():
    state_holder = {}

    def thunk():
        state_holder["n"] = state_holder.get("n", 0) + 1
        return cl.get_client().go()

    return thunk


def test_get_retries_and_recovers(fake_builds):
    # First client is dead -> get retries once on a freshly built (alive) client.
    out = cl.proxmox_get(_call_go())
    assert out == "ok"
    assert fake_builds["build"] == 2  # rebuilt exactly once


def test_post_does_not_retry_but_resets(fake_builds):
    # The write hits the dead connection and fails WITHOUT being re-sent.
    with pytest.raises(ProxmoxError, match="not retried"):
        cl.proxmox_post(_call_go())
    assert fake_builds["build"] == 1  # built once, NOT retried

    # But the connection was reset, so the next call rebuilds and succeeds.
    out = cl.proxmox_post(_call_go())
    assert out == "ok"
    assert fake_builds["build"] == 2
