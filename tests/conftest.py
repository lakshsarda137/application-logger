from __future__ import annotations

import io
import json
from datetime import datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from server.config import Config
from server.main import create_app
from server.storage import month_name

TOKEN = "test-token"


@pytest.fixture
def config(tmp_path: Path) -> Config:
    base = tmp_path / "Professional" / "Sophomore"
    base.mkdir(parents=True)
    return Config(
        api_token=TOKEN,
        base_path=base,
        db_path=tmp_path / "data" / "app.db",
        host="127.0.0.1",
        port=8765,
        extension_id="",
        path=tmp_path / "config.local.json",
    )


@pytest.fixture
def month_dir(config: Config) -> Path:
    path = config.base_path / month_name(datetime.now())
    path.mkdir()
    return path


@pytest.fixture
def client(config: Config) -> TestClient:
    return TestClient(
        create_app(config),
        base_url="http://127.0.0.1:8765",
        headers={"X-API-Token": TOKEN},
    )


def multipart(payload: dict, files: list[tuple[str, bytes, str]] = ()) -> list:
    """Build the multipart body the extension sends."""
    parts = [("payload", ("payload.json", json.dumps(payload).encode(), "application/json"))]
    parts += [("files", (name, io.BytesIO(data), mime)) for name, data, mime in files]
    return parts
