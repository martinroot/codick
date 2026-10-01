"""A JSON body must not be rejected for failing to announce itself.

`fetch` assigns no content type to a string body, so a client that supplies its
own headers -- an idempotency key, say -- sends `text/plain`. The body model then
rejects the entire document with "Input should be a valid dictionary or object",
a message that reads like the caller's data is malformed when the caller's data
is fine and only the header is missing.

Fixing that in the web client fixed one caller. These pin the contract where it
belongs, on the API, so a curl script or a second client cannot hit it again.
"""

from __future__ import annotations

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", ".."))
os.environ.setdefault("HERMES_HOME", tempfile.mkdtemp(prefix="web-json-ct-test-"))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from pydantic import BaseModel  # noqa: E402


class Payload(BaseModel):
    name: str
    count: int = 0


def _client():
    from hermes_cli.web_server import json_content_type_middleware

    app = FastAPI()
    app.middleware("http")(json_content_type_middleware)

    @app.post("/thing")
    def create(body: Payload):
        return body.model_dump()

    return TestClient(app)


DOC = '{"name": "a", "count": 2}'


@pytest.mark.parametrize("headers", [
    {},                                     # fetch's default for a string body
    {"Content-Type": "text/plain"},        # what that becomes on the wire
    {"Content-Type": "text/plain;charset=UTF-8"},
    # curl's default for --data-binary, which is what every shell script sends.
    {"Content-Type": "application/x-www-form-urlencoded"},
])
def test_a_json_document_is_accepted_without_a_declared_type(headers):
    response = _client().post("/thing", content=DOC, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {"name": "a", "count": 2}


def test_a_declared_type_is_left_alone():
    response = _client().post("/thing", json={"name": "a"})
    assert response.status_code == 200, response.text


def test_a_non_json_body_is_still_refused_and_still_says_why():
    # The middleware corrects the *declared* type, never the bytes. If it
    # coerced everything, a genuinely wrong payload would be reported as a
    # shape problem instead of a parse failure.
    response = _client().post("/thing", content="name=a&count=2",
                              headers={"Content-Type": "text/plain"})
    assert response.status_code == 422, response.text


def test_a_json_scalar_is_not_relabelled():
    # `"a"` is valid JSON but not an object, and the body model must be the one
    # to say so -- this is exactly the failure the middleware exists to stop,
    # and stopping it by pretending every JSON body is an object would just
    # move the error somewhere less honest.
    response = _client().post("/thing", content='"a"',
                              headers={"Content-Type": "text/plain"})
    assert response.status_code == 422, response.text
