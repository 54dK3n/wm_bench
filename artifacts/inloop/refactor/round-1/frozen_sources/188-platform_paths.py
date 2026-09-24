"""Repository-relative paths and explicit external-platform configuration."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLATFORM_PREFIX = "@platform/"


def platform_root(required=True):
    value = os.environ.get("GUANGYANG_PLATFORM_ROOT")
    if not value:
        if not required:
            return None
        raise ValueError("Set GUANGYANG_PLATFORM_ROOT to the external car-python platform directory")
    path = Path(value).expanduser().resolve()
    if not path.is_dir():
        raise ValueError("GUANGYANG_PLATFORM_ROOT is not an existing directory")
    return path


def platform_worker(override=None):
    expected = platform_root() / "python-worker.js"
    if override is not None and Path(override).resolve() != expected:
        raise ValueError("--worker must match GUANGYANG_PLATFORM_ROOT/python-worker.js")
    if not expected.is_file():
        raise ValueError("GUANGYANG_PLATFORM_ROOT does not contain python-worker.js")
    return expected


def repository_path(value):
    path = (ROOT / value).resolve()
    if not path.is_relative_to(ROOT):
        raise ValueError("Repository path escapes workspace: " + str(value))
    return path


def recorded_repository_path(value):
    """Resolve immutable historical provenance without rewriting old evidence."""
    path = Path(value)
    if not path.is_absolute():
        return repository_path(path)
    if path.is_relative_to(ROOT):
        return path
    # Old evidence records its original checkout prefix. Only the artifacts
    # subtree may be relocated; arbitrary external absolute paths are rejected.
    if "artifacts" in path.parts:
        return repository_path(Path(*path.parts[path.parts.index("artifacts"):]))
    raise ValueError("Historical path is not repository evidence: " + str(value))


def file_reference(value):
    path = Path(value).resolve()
    if path.is_relative_to(ROOT):
        return path.relative_to(ROOT).as_posix()
    platform = platform_root(required=False)
    if platform is not None and path.is_relative_to(platform):
        return PLATFORM_PREFIX + path.relative_to(platform).as_posix()
    raise ValueError("Dependency is outside repository and configured platform: " + str(path))


def resolve_reference(value):
    if value.startswith(PLATFORM_PREFIX):
        root = platform_root()
        path = (root / value[len(PLATFORM_PREFIX):]).resolve()
        if not path.is_relative_to(root):
            raise ValueError("Platform reference escapes configured directory")
        return path
    return repository_path(value)
