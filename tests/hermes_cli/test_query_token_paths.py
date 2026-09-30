"""Which routes may authenticate by ``?token=`` rather than a header.

A download link opened by a browser cannot set ``Authorization``, so the session
token may ride in the query — but only on the routes that need it, because a
query parameter lands in proxy logs and browser history while a header does not.
These tests pin the *narrowness*: a rule that quietly widened would keep working
and keep leaking.
"""

def _is_query_token_path(path: str) -> bool:
    """Imported lazily, on purpose.

    `hermes_cli.web_server` builds the whole app at import time, which touches
    process-wide state. Importing it at module scope made this file change the
    behaviour of the pipeline API tests that ran after it in the same session —
    the symptom was an input request that had already expired. A test file that
    perturbs the tests next to it is a defect in the test file, so the import
    happens where it is used.
    """
    from hermes_cli.web_server import _is_query_token_path as predicate

    return predicate(path)


def test_the_known_exact_path_still_qualifies():
    assert _is_query_token_path("/api/files/download") is True


def test_the_artifact_download_qualifies():
    assert _is_query_token_path("/api/pipelines/artifacts/art_123/download") is True


def test_a_pipeline_id_with_path_characters_is_encoded_into_one_segment():
    # The id is URL-encoded by the client, so a real id never introduces a slash.
    # The segment count is the check that keeps that true.
    assert _is_query_token_path("/api/pipelines/artifacts/art%2F..%2Fetc/download") is True


def test_the_rest_of_the_pipeline_surface_does_not_qualify():
    # The whole point of "kept narrow": a prefix would have let all of these in.
    for path in [
        "/api/pipelines/templates",
        "/api/pipelines/runs/run_1",
        "/api/pipelines/runs/run_1/events",
        "/api/pipelines/credentials",
        "/api/pipelines/maintenance/expire-inputs",
        "/api/kanban/board",
        "/api/files",
        "/api/files/download/extra",
    ]:
        assert _is_query_token_path(path) is False, path


def test_a_shaped_path_needs_an_id_segment():
    # No id means the route shape does not match, whatever the verbs say.
    assert _is_query_token_path("/api/pipelines/artifacts//download") is False
    assert _is_query_token_path("/api/pipelines/artifacts/x/y/download") is False
