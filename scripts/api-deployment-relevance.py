"""Select API deployments, exempting only root Node-engine metadata changes."""
import argparse
import json
import math
import re
import subprocess
import sys


ROOT_PACKAGES = {"package.json", "package-lock.json"}


def git(*arguments):
    return subprocess.check_output(["git", *arguments], stderr=subprocess.DEVNULL)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON key")
        result[key] = value
    return result


def invalid_constant(_value):
    raise ValueError("Nonstandard JSON constant")


def finite_float(value):
    parsed = float(value)
    if not math.isfinite(parsed):
        raise ValueError("Nonfinite JSON number")
    return parsed


def root_package(commit, path):
    entry = git("ls-tree", "-z", commit, "--", path).rstrip(b"\0")
    metadata, filename = entry.split(b"\t", 1)
    mode, kind, _object_id = metadata.split()
    if filename.decode("utf-8") != path or kind != b"blob" or mode not in (b"100644", b"100755"):
        raise ValueError("Root package must be a regular file")
    document = json.loads(
        git("show", f"{commit}:{path}").decode("utf-8"),
        object_pairs_hook=unique_object,
        parse_constant=invalid_constant,
        parse_float=finite_float,
    )
    if not isinstance(document, dict):
        raise ValueError("Root package must be a JSON object")
    root = document if path == "package.json" else document["packages"][""]
    engines = root["engines"]
    if not isinstance(engines, dict) or not isinstance(engines["node"], str) or not engines["node"].strip():
        raise ValueError("Root Node engine must be a nonempty string")
    node = engines.pop("node")
    # Sorted JSON preserves distinctions such as true versus 1 that Python's
    # direct dictionary equality would otherwise treat as equal.
    remainder = json.dumps(document, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    return mode, node, remainder


def deployment_required(previous, current):
    """Return (deploy, reason); uncertainty always retains the deployment."""
    try:
        if not all(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha) for sha in (previous, current)):
            raise ValueError("Expected full commit identities")
        for sha in (previous, current):
            git("cat-file", "-e", f"{sha}^{{commit}}")
        if previous == current:
            return False, "Primary already has the tested commit; skipping API deployment."
        # A move out of server/lib must still count as removal of an API file.
        changed = git(
            "diff", "--no-renames", "--name-only", "-z", previous, current,
            "--", "server", "lib", "package.json", "package-lock.json",
        )
        paths = [path.decode("utf-8") for path in changed.split(b"\0") if path]
        if not paths:
            return False, "No server/lib/root-package changes since the deployed commit; skipping API deployment."
        if any(path not in ROOT_PACKAGES for path in paths):
            return True, "Server or shared-library changes since the deployed commit require API deployment."
        for path in paths:
            old_mode, old_node, old_remainder = root_package(previous, path)
            new_mode, new_node, new_remainder = root_package(current, path)
            if old_mode != new_mode or old_node == new_node or old_remainder != new_remainder:
                return True, "Root package changes extend beyond Node-engine metadata; API deployment required."
        return False, "Only root engines.node metadata changed; preserving self-managed API runtimes."
    except (KeyError, TypeError, ValueError, UnicodeError, RecursionError, OSError, subprocess.CalledProcessError):
        return True, "Cannot prove changes are limited to root Node-engine metadata; API deployment required."


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--previous", required=True)
    parser.add_argument("--current", required=True)
    args = parser.parse_args()
    deploy, reason = deployment_required(args.previous, args.current)
    print(reason, file=sys.stderr)
    print(f"deploy={'true' if deploy else 'false'}")


if __name__ == "__main__":
    main()
