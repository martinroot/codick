"""Upload and inspect a profile archive as bytes, not as a path on disk.

The dashboard and the agent share a filesystem, so ``POST /api/profiles/import``
takes a path. That is fine locally and useless everywhere else — a desktop client,
or moving a profile to one of twelve servers. ``import-upload`` accepts the bytes.

These tests cover the properties that make uploading safe and honest: the staged
file is cleaned up on *every* exit, a malformed archive is a 400 with a reason
rather than a 500, a taken name is a rename suggestion rather than an overwrite,
and the preview says plainly that credentials do not travel with the archive.
"""

from __future__ import annotations

import io
import tarfile

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402


def _make_archive(roots: dict, top: str = "writer") -> bytes:
    """A .tar.gz in memory: ``{relative path: text}`` under a single top dir."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for rel, text in roots.items():
            data = text.encode("utf-8")
            info = tarfile.TarInfo(name=f"{top}/{rel}")
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


SKILL = "---\nname: drafting\ndescription: write things\n---\n\nbody\n"


@pytest.fixture()
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    from hermes_cli import profiles as profiles_mod
    from hermes_cli.config import invalidate_env_cache

    invalidate_env_cache()
    return tmp_path


@pytest.fixture()
def client(home):
    from hermes_cli import web_server

    with TestClient(web_server.app, raise_server_exceptions=False) as c:
        c.headers["Authorization"] = f"Bearer {web_server._SESSION_TOKEN}"
        yield c


def _uploads_dir():
    from hermes_cli import profiles as profiles_mod

    return profiles_mod._profile_export_directory() / "uploads"


# ── inspect_archive ───────────────────────────────────────────────────────────

def test_inspect_names_the_profile_and_the_skills_it_carries(home):
    from hermes_cli import profiles as profiles_mod

    archive = home / "writer.tar.gz"
    archive.write_bytes(_make_archive({
        "config.yaml": "model: {}\n",
        "skills/drafting/SKILL.md": SKILL,
    }))
    report = profiles_mod.inspect_archive(archive)
    assert report["name"] == "writer"
    assert report["skills"] == ["drafting"]
    assert report["available_name"] is True


def test_inspect_says_plainly_that_credentials_do_not_travel(home):
    """Export strips auth.json, .env and bot-desktop. Someone shipping a profile to
    twelve servers must be told before the import, not after they find out."""
    from hermes_cli import profiles as profiles_mod

    archive = home / "w.tar.gz"
    archive.write_bytes(_make_archive({"config.yaml": "model: {}\n"}))
    report = profiles_mod.inspect_archive(archive)
    assert report["credentials_transferred"] is False
    assert "NOT part of a profile archive" in report["credentials_note"]


def test_a_taken_name_is_a_rename_suggestion_not_a_failure(home):
    from hermes_cli import profiles as profiles_mod

    existing = profiles_mod.get_profile_dir("writer")
    existing.mkdir(parents=True, exist_ok=True)
    archive = home / "writer.tar.gz"
    archive.write_bytes(_make_archive({"config.yaml": "model: {}\n"}))
    report = profiles_mod.inspect_archive(archive)
    assert report["name_taken"] is True
    assert report["suggested_name"] != "writer"


def test_inspect_refuses_the_default_profile_name(home):
    """Importing as `default` would target ~/.hermes itself."""
    from hermes_cli import profiles as profiles_mod

    archive = home / "x.tar.gz"
    archive.write_bytes(_make_archive({"config.yaml": "model: {}\n"}))
    report = profiles_mod.inspect_archive(archive, name="default")
    assert report["available_name"] is False
    assert "default" in report["name_error"]


def test_inspect_names_the_reason_for_two_top_level_dirs(home):
    """`import_profile` requires exactly one. Saying so beats "invalid archive"."""
    from hermes_cli import profiles as profiles_mod

    archive = home / "two.tar.gz"
    with tarfile.open(archive, "w:gz") as tf:
        for name, text in (("one/a.txt", "a"), ("two/b.txt", "b")):
            data = text.encode()
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    with pytest.raises(ValueError, match="exactly one top-level directory"):
        profiles_mod.inspect_archive(archive)


def test_inspect_rejects_something_that_is_not_an_archive(home):
    from hermes_cli import profiles as profiles_mod

    junk = home / "junk.tar.gz"
    junk.write_bytes(b"this is not a tarball at all")
    with pytest.raises(ValueError, match="Not a readable"):
        profiles_mod.inspect_archive(junk)


# ── the upload endpoint ───────────────────────────────────────────────────────

def test_inspect_only_writes_nothing(client, home):
    from hermes_cli import profiles as profiles_mod

    archive = _make_archive({"config.yaml": "model: {}\n", "skills/drafting/SKILL.md": SKILL})
    resp = client.post("/api/profiles/import-upload",
                       files={"file": ("writer.tar.gz", archive, "application/gzip")},
                       data={"inspect_only": "true"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["inspect"]["name"] == "writer"
    assert not profiles_mod.get_profile_dir("writer").exists(), "inspect must not create a profile"


def test_upload_imports_the_profile(client, home):
    from hermes_cli import profiles as profiles_mod

    archive = _make_archive({"config.yaml": "model: {}\n", "skills/drafting/SKILL.md": SKILL})
    resp = client.post("/api/profiles/import-upload",
                       files={"file": ("writer.tar.gz", archive, "application/gzip")})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["ok"] is True
    assert body["name"] == "writer"
    assert profiles_mod.get_profile_dir("writer").is_dir()
    assert (profiles_mod.get_profile_dir("writer") / "skills" / "drafting" / "SKILL.md").is_file()


def test_junk_upload_is_a_400_naming_the_reason_not_a_500(client):
    """The file is the user's, not the server's fault."""
    resp = client.post("/api/profiles/import-upload",
                       files={"file": ("bad.tar.gz", b"not a tarball", "application/gzip")})
    assert resp.status_code == 400
    assert "Not a readable" in resp.json()["detail"]


def _two_root_archive() -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        for name, text in (("one/a.txt", "a"), ("two/b.txt", "b")):
            data = text.encode()
            info = tarfile.TarInfo(name=name)
            info.size = len(data)
            tf.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def test_two_top_level_dirs_is_a_400_naming_the_reason(client):
    resp = client.post("/api/profiles/import-upload",
                       files={"file": ("two.tar.gz", _two_root_archive(), "application/gzip")})
    assert resp.status_code == 400
    assert "exactly one top-level directory" in resp.json()["detail"]


def test_importing_as_default_is_refused_with_a_reason(client):
    archive = _make_archive({"config.yaml": "model: {}\n"})
    resp = client.post("/api/profiles/import-upload",
                       files={"file": ("w.tar.gz", archive, "application/gzip")},
                       data={"name": "default"})
    assert resp.status_code == 400
    assert "default" in resp.json()["detail"]


def test_a_taken_name_does_not_overwrite(client, home):
    from hermes_cli import profiles as profiles_mod

    existing = profiles_mod.get_profile_dir("writer")
    existing.mkdir(parents=True, exist_ok=True)
    (existing / "config.yaml").write_text("model: {keep: me}\n")

    archive = _make_archive({"config.yaml": "model: {fresh: yes}\n"})
    resp = client.post("/api/profiles/import-upload",
                       files={"file": ("writer.tar.gz", archive, "application/gzip")})
    assert resp.status_code == 400
    # The existing profile is untouched — refusal, not overwrite.
    assert "keep: me" in (existing / "config.yaml").read_text()
    assert not profiles_mod.get_profile_dir("writer-imported").exists()


def test_the_staged_archive_is_gone_after_every_outcome(client, home):
    """Success, malformed and refused alike. A staged profile copy left behind
    accumulates a full set of profiles nobody asked to keep."""
    staging = _uploads_dir()
    ok = _make_archive({"config.yaml": "model: {}\n"})
    client.post("/api/profiles/import-upload",
                files={"file": ("writer.tar.gz", ok, "application/gzip")})
    assert not list(staging.glob("*.tar.gz")) if staging.is_dir() else True

    client.post("/api/profiles/import-upload",
                files={"file": ("bad.tar.gz", b"nope", "application/gzip")})
    assert not list(staging.glob("*.tar.gz")) if staging.is_dir() else True

    client.post("/api/profiles/import-upload",
                files={"file": ("w2.tar.gz", ok, "application/gzip")},
                data={"inspect_only": "true"})
    assert not list(staging.glob("*.tar.gz")) if staging.is_dir() else True


def test_a_crafted_filename_cannot_choose_where_the_upload_lands(client, home):
    """The filename comes from the browser and is used to build a path."""
    from hermes_cli import profiles as profiles_mod

    archive = _make_archive({"config.yaml": "model: {}\n"})
    resp = client.post(
        "/api/profiles/import-upload",
        files={"file": ("../../../../tmp/evil.tar.gz", archive, "application/gzip")})
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "writer"
    assert not (home.parent / "tmp" / "evil").exists()


def test_uploaded_name_is_forced_to_tar_gz():
    from hermes_cli.web_routers.profiles import _safe_archive_upload_name

    assert _safe_archive_upload_name("profile.tar.gz") == "profile.tar.gz"
    assert _safe_archive_upload_name("profile.zip") == "profile.zip.tar.gz"
    assert _safe_archive_upload_name("profile.tar") == "profile.tar.gz"
    assert _safe_archive_upload_name("../../etc/passwd") == "passwd.tar.gz"
    assert "/" not in _safe_archive_upload_name("a/b/c.tar.gz")
    assert _safe_archive_upload_name(None).endswith(".tar.gz")