"""Bounded streaming extraction for the pinned LLVM build on Windows.

Uses CPython's lzma implementation instead of Windows tar.exe. No archive
extract()/extractall() call, privileged symlink creation, or owner restoration.
Only existing compiler source trees are copied; disabled test trees are omitted.
"""
import argparse
import hashlib
import io
import json
import lzma
import os
from pathlib import Path
import posixpath
import shutil
import tarfile
import tempfile
import time
import unittest
from unittest.mock import patch

ARCHIVE_SHA256 = "4633a23617fa31a3ea51242586ea7fb1da7140e426bd62fc164261fe036aa142"
PREFIX = "llvm-project-21.1.8.src"
TREES = {"llvm", "clang", "lld", "cmake", "third-party"}
DISABLED = {"test", "tests", "unittests", "benchmarks"}
REQUIRED = ["LICENSE.TXT", "llvm/CMakeLists.txt", "clang/CMakeLists.txt",
            "lld/CMakeLists.txt", "cmake/Modules/CMakePolicy.cmake",
            "cmake/Modules/LLVMVersion.cmake", "llvm/lib/Target/Mips/CMakeLists.txt",
            "llvm/include/llvm/Support/LICENSE.TXT", "llvm/lib/Support/BLAKE3/LICENSE"]


def digest(filename):
    result = hashlib.sha256()
    with open(filename, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def safe_member(name):
    name = name.rstrip("/")
    if not name or name.startswith("/") or "\\" in name or "\x00" in name:
        raise ValueError("Unsafe source archive path: " + repr(name))
    parts = name.split("/")
    if parts[0] != PREFIX or any(part in ("", ".", "..") for part in parts):
        raise ValueError("Source archive path escapes its pinned root: " + repr(name))
    return parts


def selected(parts):
    return len(parts) > 1 and (parts[1] in TREES or parts[1] == "LICENSE.TXT") \
        and not (parts[1] in {"llvm", "clang", "lld"} and len(parts) > 2 and parts[2] in DISABLED)


def safe_windows_parts(parts):
    reserved = {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)],
                *[f"LPT{i}" for i in range(1, 10)]}
    for part in parts:
        if any(ord(character) < 32 or character in '<>:"|?*' for character in part) \
                or part.endswith((".", " ")) or part.split(".")[0].upper() in reserved:
            raise ValueError("Nonportable selected source path: " + repr(part))


def safe_link(member):
    target = member.linkname
    if not target or target.startswith("/") or "\\" in target or "\x00" in target:
        raise ValueError("Unsafe source archive link")
    resolved = target if member.islnk() else posixpath.normpath(posixpath.join(posixpath.dirname(member.name), target))
    return safe_member(resolved)


def extract(archive, destination, expected_sha256=ARCHIVE_SHA256, budget_seconds=600):
    start = time.monotonic()
    print("LLVM extraction: verifying archive SHA256", flush=True)
    if digest(archive) != expected_sha256:
        raise ValueError("LLVM source archive checksum mismatch")
    destination = Path(destination).absolute()
    if destination.exists():
        raise ValueError("Extraction destination already exists; use a fresh work directory")
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".llvm-source-stage-", dir=destination.parent))
    count = written = skipped = total = 0
    seen = set()
    links = []
    last_progress = start
    try:
        print("LLVM extraction: streaming lzma/tar; selecting compiler source trees", flush=True)
        # Bound buffering in uncompressed bytes. In r|xz mode tarfile inflates
        # an entire compressed chunk, then copies its remaining inflated bytes
        # for each small header read. LLVM's highly compressed tests magnify that
        # copying cost; LZMAFile instead decodes only the bytes requested by r|.
        with lzma.open(archive, "rb") as decoded, \
                tarfile.open(fileobj=decoded, mode="r|", bufsize=64 * 1024) as source:
            for member in source:
                count += 1
                if count > 300000 or time.monotonic() - start > budget_seconds:
                    raise ValueError("LLVM source extraction exceeded its member/time budget")
                parts = safe_member(member.name)
                if member.issym() or member.islnk():
                    target_parts = safe_link(member)
                elif not (member.isdir() or member.isfile()) or member.issparse():
                    raise ValueError("Unsupported source archive entry type")
                if not selected(parts):
                    skipped += 1
                else:
                    relative = parts[1:]
                    safe_windows_parts(relative)
                    key = "/".join(relative).casefold()
                    if key in seen:
                        raise ValueError("Duplicate/case-colliding source archive member")
                    seen.add(key)
                    target = stage.joinpath(*relative)
                    if member.isdir():
                        target.mkdir(parents=True, exist_ok=True)
                    elif member.issym() or member.islnk():
                        if not selected(target_parts):
                            raise ValueError("Selected link refers to an excluded source tree")
                        safe_windows_parts(target_parts[1:])
                        links.append((target, stage.joinpath(*target_parts[1:])))
                    else:
                        if member.size > 128 * 1024 * 1024 or total + member.size > 1024 * 1024 * 1024:
                            raise ValueError("Selected source exceeds extraction size budget")
                        target.parent.mkdir(parents=True, exist_ok=True)
                        body = source.extractfile(member)
                        if body is None:
                            raise ValueError("Missing source archive file body")
                        with body, open(target, "xb") as output:
                            shutil.copyfileobj(body, output, 1024 * 1024)
                        if target.stat().st_size != member.size:
                            raise ValueError("Truncated source archive member")
                        os.chmod(target, 0o755 if member.mode & 0o111 else 0o644)
                        written += 1
                        total += member.size
                if time.monotonic() - last_progress >= 2:
                    print(f"LLVM extraction: scanned={count} files={written} skipped={skipped} bytes={total} elapsed={time.monotonic()-start:.1f}s", flush=True)
                    last_progress = time.monotonic()
        # The pinned selected trees have three MLGO Python aliases. Materialize
        # their identical file bytes, avoiding Windows symlink privilege prompts.
        for target, origin in links:
            if not origin.is_file() or origin.is_symlink():
                raise ValueError("Selected source link does not reference a regular extracted file")
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(origin, target)
            written += 1
        for name in REQUIRED:
            if not (stage / name).is_file():
                raise ValueError("Required compiler source missing: " + name)
        for tree in TREES:
            if not (stage / tree).is_dir():
                raise ValueError("Required compiler tree missing: " + tree)
        report = {"format": "mnsg-llvm-source-extraction", "version": 1,
                  "sha256": expected_sha256, "method": "python-streaming-lzmafile-tar",
                  "uncompressedBufferBytes": 64 * 1024,
                  "trees": sorted(TREES), "excludedTopLevelTestTrees": sorted(DISABLED),
                  "scanned": count, "files": written, "skipped": skipped,
                  "bytes": total, "materializedLinks": len(links),
                  "elapsedSeconds": round(time.monotonic() - start, 2)}
        (stage / ".mnsg-llvm-extraction.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
        stage.rename(destination)
        print("LLVM extraction complete: " + json.dumps(report), flush=True)
        return report
    finally:
        if stage.exists():
            shutil.rmtree(stage)


class ExtractionTests(unittest.TestCase):
    def fixture(self, directory, extra=()):
        archive = Path(directory) / "source.tar.xz"
        with tarfile.open(archive, "w:xz") as output:
            for name in REQUIRED + ["third-party/README.md", "llvm/test/skipped.txt"]:
                data = b"preserved source bytes\n"
                member = tarfile.TarInfo(PREFIX + "/" + name)
                member.size = len(data)
                output.addfile(member, io.BytesIO(data))
            for member, data in extra:
                output.addfile(member, io.BytesIO(data) if data is not None else None)
        return archive

    def test_selected_bytes_and_disabled_tests(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = self.fixture(directory)
            target = Path(directory) / "output"
            report = extract(archive, target, digest(archive))
            self.assertEqual((target / "llvm/CMakeLists.txt").read_bytes(), b"preserved source bytes\n")
            self.assertFalse((target / "llvm/test").exists())
            self.assertEqual(report["skipped"], 1)
            self.assertEqual(report["method"], "python-streaming-lzmafile-tar")
            self.assertEqual(report["uncompressedBufferBytes"], 65536)

    def test_checksum_rejected_before_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = self.fixture(directory)
            with self.assertRaisesRegex(ValueError, "checksum"):
                extract(archive, Path(directory) / "output", "0" * 64)
            self.assertFalse((Path(directory) / "output").exists())

    def test_unsafe_members_and_links_leave_no_destination(self):
        for name, link, kind in [(PREFIX + "/llvm/../../escape", "", tarfile.REGTYPE),
                                 (PREFIX + "/llvm/alias", "/outside", tarfile.SYMTYPE),
                                 (PREFIX + "/llvm/alias", "../../outside", tarfile.SYMTYPE),
                                 (PREFIX + "/llvm/CON.txt", "", tarfile.REGTYPE),
                                 (PREFIX + "/llvm/device", "", tarfile.CHRTYPE)]:
            with self.subTest(name=name, link=link), tempfile.TemporaryDirectory() as directory:
                member = tarfile.TarInfo(name)
                member.type, member.linkname = kind, link
                archive = self.fixture(directory, [(member, None)])
                with self.assertRaises(ValueError):
                    extract(archive, Path(directory) / "output", digest(archive))
                self.assertFalse((Path(directory) / "output").exists())

    def test_safe_link_materialized_as_regular_file(self):
        with tempfile.TemporaryDirectory() as directory:
            link = tarfile.TarInfo(PREFIX + "/llvm/alias.txt")
            link.type, link.linkname = tarfile.SYMTYPE, "CMakeLists.txt"
            archive = self.fixture(directory, [(link, None)])
            target = Path(directory) / "output"
            extract(archive, target, digest(archive))
            self.assertFalse((target / "llvm/alias.txt").is_symlink())
            self.assertEqual((target / "llvm/alias.txt").read_bytes(), (target / "llvm/CMakeLists.txt").read_bytes())

    def test_case_collisions_and_excluded_link_targets(self):
        for name, link, kind in [(PREFIX + "/llvm/cmakelists.txt", "", tarfile.REGTYPE),
                                 (PREFIX + "/llvm/alias", "test/skipped.txt", tarfile.SYMTYPE),
                                 (PREFIX + "/llvm/ads:stream", "", tarfile.REGTYPE)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                member = tarfile.TarInfo(name)
                member.type, member.linkname = kind, link
                archive = self.fixture(directory, [(member, None)])
                with self.assertRaises(ValueError):
                    extract(archive, Path(directory) / "output", digest(archive))
                self.assertFalse((Path(directory) / "output").exists())
                self.assertFalse(list(Path(directory).glob(".llvm-source-stage-*")))

    def test_time_budget_cleans_partial_extraction(self):
        with tempfile.TemporaryDirectory() as directory:
            archive = self.fixture(directory)
            with self.assertRaisesRegex(ValueError, "budget"):
                extract(archive, Path(directory) / "output", digest(archive), budget_seconds=-1)
            self.assertFalse((Path(directory) / "output").exists())
            self.assertFalse(list(Path(directory).glob(".llvm-source-stage-*")))

    def test_decode_requests_bounded_for_highly_compressed_skipped_data(self):
        with tempfile.TemporaryDirectory() as directory:
            data = b"\0" * (10 * 1024 * 1024)
            member = tarfile.TarInfo(PREFIX + "/llvm/test/compressible.txt")
            member.size = len(data)
            archive = self.fixture(directory, [(member, data)])
            requests = []
            original_open = lzma.open

            class BoundedReader:
                def __init__(self, *args, **kwargs):
                    self.source = original_open(*args, **kwargs)

                def __enter__(self):
                    return self

                def __exit__(self, *args):
                    self.source.close()

                def read(self, size=-1):
                    if not 0 < size <= 65536:
                        raise AssertionError("Unbounded inflated-data read")
                    requests.append(size)
                    return self.source.read(size)

            with patch("lzma.open", side_effect=BoundedReader):
                report = extract(archive, Path(directory) / "output", digest(archive))
            self.assertGreater(len(requests), 100)
            self.assertEqual(report["skipped"], 2)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive")
    parser.add_argument("--destination")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        unittest.main(argv=[__file__])
    elif args.archive and args.destination:
        extract(args.archive, args.destination)
    else:
        parser.error("--archive and --destination are required")
