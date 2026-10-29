#!/usr/bin/env python3
"""Fetch and verify the exact unmodified upstream sources used by this prototype."""
import hashlib
import io
from pathlib import Path
import shutil
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parent
SOURCES = (
    ("wallet-libraries", "zakura-core/wallet-libraries",
     "a7c842fd4f16790ed6739346f44557a97065d242",
     "a424889b2a26c24c6416bbc085fbc7fdf35fa82e7fe35e695cd4cd7726927361"),
    ("ipir-sp", "valargroup/ipir-sp",
     "5ea080a3281a01c5459f585e0a1bbbde50ec2bd2",
     "2f8145e0aaf9ad201aafcd2843dc39cb71d90422374f5e4c15074debf51b819c"),
)


def verify_tree(archive, destination):
    """Compare every upstream regular source file with its verified archive."""
    expected_paths = set()
    for member in archive.getmembers():
        if not (member.isfile() or member.issym()):
            continue
        relative = Path(*Path(member.name).parts[1:])
        expected_paths.add(relative)
        file = destination / relative
        if member.issym():
            if not file.is_symlink() or str(file.readlink()) != member.linkname:
                return False
            continue
        expected = archive.extractfile(member).read()
        if not file.is_file() or file.read_bytes() != expected:
            return False
    actual_paths = {
        file.relative_to(destination)
        for file in destination.rglob("*")
        if file.is_file() or file.is_symlink()
    }
    return actual_paths == expected_paths


def main():
    upstream = ROOT / ".upstream"
    upstream.mkdir(exist_ok=True)
    for name, repository, revision, digest in SOURCES:
        cache = upstream / f"{name}-{revision}.tar.gz"
        if not cache.is_file():
            request = urllib.request.Request(
                f"https://api.github.com/repos/{repository}/tarball/{revision}",
                headers={"User-Agent": "ZecBlock-local-PIR-fixture"},
            )
            with urllib.request.urlopen(request, timeout=120) as response:
                data = response.read()
            if hashlib.sha256(data).hexdigest() != digest:
                raise SystemExit(f"Unexpected immutable archive checksum: {name}")
            cache.write_bytes(data)
        data = cache.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise SystemExit(f"Cached archive checksum mismatch: {name}")
        destination = upstream / name
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
            if destination.is_dir() and verify_tree(archive, destination):
                print(f"Verified {name} {revision}")
                continue
            if destination.exists() or destination.is_symlink():
                raise SystemExit(f"Upstream source differs; inspect before removing {destination}")
            with tempfile.TemporaryDirectory(dir=upstream) as temporary:
                archive.extractall(temporary, filter="data")
                roots = list(Path(temporary).iterdir())
                if len(roots) != 1 or not roots[0].is_dir():
                    raise SystemExit(f"Unexpected archive layout: {name}")
                shutil.move(str(roots[0]), destination)
            if not verify_tree(archive, destination):
                raise SystemExit(f"Extracted source mismatch: {name}")
        print(f"Verified {name} {revision}")


if __name__ == "__main__":
    main()
