from __future__ import annotations
import json
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

class RDKError(RuntimeError):
    pass

class RDKClient:
    """Synchronous stdlib client; works in a clean robot/edge Python install."""
    def __init__(self, base_url: str = "http://127.0.0.1:18102", token: str | None = None):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(self, method: str, path: str, body: dict | None = None) -> dict:
        headers = {"Accept": "application/json"}
        if body is not None:
            headers["Content-Type"] = "application/json"
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        req = Request(self.base_url + path, method=method, headers=headers,
                      data=json.dumps(body).encode() if body is not None else None)
        try:
            with urlopen(req, timeout=30) as response:
                return json.loads(response.read().decode())
        except (HTTPError, URLError, json.JSONDecodeError) as exc:
            raise RDKError(str(exc)) from exc

    def health(self) -> dict:
        return self.request("GET", "/healthz")

    def overview(self) -> dict:
        return self.request("GET", "/api/v1/duck/overview")

    def submit_training(self, model_id: str, profile: str = "smoke", backend: str = "local") -> dict:
        return self.request("POST", "/api/v1/duck/runs", {
            "modelId": model_id, "backend": backend, "profile": profile
        })

    def run(self, run_id: str) -> dict:
        return self.request("GET", f"/api/v1/duck/runs/{run_id}")
