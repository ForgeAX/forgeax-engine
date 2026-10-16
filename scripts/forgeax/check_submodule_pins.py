#!/usr/bin/env python3
"""check_submodule_pins.py - verify pins on declared maintained submodule branches.

Every gitlink in HEAD must be reachable from a freshly fetched remote maintenance
branch. Read the standard branch field from .gitmodules; absent fields use main.
Local .git/config overrides, symbolic '.', invalid names and duplicate fields
cannot change the authority. Feature work must merge into that maintenance line
before its superrepo pin is published. Declared maintenance lines are durable
repository contracts, not temporary feature branches.

This preserves paired-repository delivery across declared maintenance lines.
Remote access failure and missing branches fail closed; shallow clones are unshallowed before
ancestry checks. No local/stale ref can substitute for a successful fetch.

Exit codes: 0 verified, 1 invalid/unreachable/unverifiable pin, 2 CLI/IO error.
Usage: --repo <path> selects a checkout; --self-test exercises real Git fixtures.
"""
import argparse
import os
import subprocess
import sys
from pathlib import Path


def _git(repo: Path, *args: str, env=None) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(repo), *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def _list_submodules(repo: Path) -> list[tuple[str, str]]:
    """Read path and maintained branch from .gitmodules, never local overrides."""
    gitmodules = repo / ".gitmodules"
    if not gitmodules.exists():
        return []
    res = _git(repo, "config", "--file", str(gitmodules), "--get-regexp", r"^submodule\..*\.path$")
    if res.returncode == 1:
        return []
    if res.returncode != 0:
        raise ValueError(f"could not read .gitmodules: {_git_detail(res)}")
    modules: list[tuple[str, str]] = []
    for line in res.stdout.splitlines():
        key, path = line.split(None, 1)
        configured = _git(repo, "config", "--file", str(gitmodules), "--get-all", key[:-4] + "branch")
        if configured.returncode == 1:
            branch = "main"
        elif configured.returncode != 0:
            raise ValueError(f"could not read maintained branch for {path}: {_git_detail(configured)}")
        else:
            values = configured.stdout.splitlines()
            if len(values) != 1:
                raise ValueError(f"{path}: declare exactly one maintained branch in .gitmodules")
            branch = values[0]
        if (
            not branch or branch == "." or branch.startswith("-")
            or _git(repo, "check-ref-format", f"refs/heads/{branch}").returncode != 0
        ):
            raise ValueError(f"{path}: invalid maintained branch {branch!r}; use a literal remote branch name")
        modules.append((path, branch))
    return modules


def _pin_sha(repo: Path, sub_path: str) -> str | None:
    """The gitlink SHA recorded in HEAD for sub_path (the pin)."""
    res = _git(repo, "ls-tree", "HEAD", sub_path)
    if res.returncode != 0:
        return None
    # "<mode> commit <sha>\t<path>"
    parts = res.stdout.split()
    if len(parts) >= 3 and parts[1] == "commit":
        return parts[2]
    return None


def _git_detail(res: subprocess.CompletedProcess) -> str:
    detail = (res.stderr or res.stdout).strip()
    return detail or f"git exited with code {res.returncode}"


def _resolve_branch_ref(
    sub_repo: Path, authorization_repo: Path | None = None, branch: str = "main",
) -> tuple[str | None, str | None]:
    """Refresh and resolve the submodule's declared remote branch.

    The submodule checkout is detached in CI and may be shallow. Never fall
    back to a stale local ref when refreshing the remote fails: that turns a
    transport or cache problem into a misleading ancestry verdict.
    """
    shallow = _git(sub_repo, "rev-parse", "--is-shallow-repository")
    if shallow.returncode != 0:
        return None, f"could not inspect repository depth: {_git_detail(shallow)}"

    fetch_args = [
        "fetch",
        "--quiet",
    ]
    if shallow.stdout.strip() == "true":
        fetch_args.append("--unshallow")
    fetch_args.extend([
        "origin",
        f"+refs/heads/{branch}:refs/remotes/origin/{branch}",
    ])
    environment = os.environ.copy()
    if authorization_repo is not None:
        remote = _git(sub_repo, "remote", "get-url", "origin")
        if remote.returncode != 0:
            return None, f"could not resolve origin URL: {_git_detail(remote)}"
        remote_url = remote.stdout.strip()
        authorization = _git(
            authorization_repo, "config", "--get-urlmatch", "http.extraheader", remote_url,
        )
        if authorization.returncode == 0 and authorization.stdout.strip():
            index = int(environment.get("GIT_CONFIG_COUNT", "0"))
            environment["GIT_CONFIG_COUNT"] = str(index + 1)
            environment[f"GIT_CONFIG_KEY_{index}"] = f"http.{remote_url}.extraheader"
            environment[f"GIT_CONFIG_VALUE_{index}"] = authorization.stdout.strip()
    fetched = _git(sub_repo, *fetch_args, env=environment)
    if fetched.returncode != 0:
        return None, (
            f"failed to refresh origin/{branch} (exit={fetched.returncode}): {_git_detail(fetched)}; "
            "hint=check remote access and the source checkout credentials, then retry; "
            "ancestry has not been determined"
        )

    branch_ref = _git(
        sub_repo,
        "rev-parse",
        "--verify",
        "--quiet",
        f"refs/remotes/origin/{branch}",
    )
    if branch_ref.returncode != 0:
        return None, f"origin/{branch} is missing after a successful fetch"
    return f"refs/remotes/origin/{branch}", None


def _is_ancestor(sub_repo: Path, pin: str, branch_ref: str) -> tuple[bool, str | None]:
    result = _git(sub_repo, "merge-base", "--is-ancestor", pin, branch_ref)
    if result.returncode == 0:
        return True, None
    if result.returncode == 1:
        return False, None
    return False, f"could not verify ancestry: {_git_detail(result)}"


def check_repo(repo: Path) -> tuple[int, list[tuple[str, str, str]]]:
    """Return (exit_code, findings). findings: (sub_path, pin, reason)."""
    try:
        modules = _list_submodules(repo)
    except ValueError as error:
        return 1, [(".gitmodules", "", str(error))]
    if not modules:
        return 0, []

    findings: list[tuple[str, str, str]] = []
    for sub_path, branch in modules:
        pin = _pin_sha(repo, sub_path)
        if pin is None:
            # Declared in .gitmodules but not a gitlink in HEAD — nothing to verify.
            continue
        sub_repo = (repo / sub_path).resolve()
        if not (sub_repo / ".git").exists():
            findings.append((
                sub_path,
                pin,
                f"submodule worktree not initialized — run "
                f"`git submodule update --init {sub_path}` then re-check",
            ))
            continue
        branch_ref, resolve_error = _resolve_branch_ref(sub_repo, repo, branch)
        if branch_ref is None:
            findings.append((
                sub_path,
                pin,
                resolve_error or f"no origin/{branch} in submodule — cannot verify pin",
            ))
            continue
        is_ancestor, ancestry_error = _is_ancestor(sub_repo, pin, branch_ref)
        if ancestry_error is not None:
            findings.append((sub_path, pin, ancestry_error))
            continue
        if not is_ancestor:
            findings.append((
                sub_path,
                pin,
                f"pin {pin[:12]} not on {branch_ref}; merge the submodule change into "
                "its declared maintained branch before publishing the superrepo pin.",
            ))
    return (1 if findings else 0), findings


def _print_findings(repo: Path, findings: list[tuple[str, str, str]]) -> None:
    print("[BLOCKED] submodule pin verification failed.", file=sys.stderr)
    print(f"  superrepo: {repo}", file=sys.stderr)
    print("  Follow the per-submodule reason below; a failed fetch is not an ancestry verdict.", file=sys.stderr)
    print("", file=sys.stderr)
    for sub_path, pin, reason in findings:
        print(f"  - {sub_path}", file=sys.stderr)
        print(f"      pin:    {pin}", file=sys.stderr)
        print(f"      reason: {reason}", file=sys.stderr)


def _run_git(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _self_test() -> int:
    """Exercise remote refresh, shallow history, and ancestry failure modes."""
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        bare = Path(td) / "remote.git"
        seed = Path(td) / "seed"
        bare.mkdir()
        seed.mkdir()
        env_cfg = [
            ("config", "user.email", "t@t"),
            ("config", "user.name", "t"),
        ]
        if _run_git("init", "-q", "--bare", str(bare)).returncode != 0:
            print("self-test setup failed: bare repo", file=sys.stderr)
            return 2
        if _git(seed, "init", "-q", "-b", "main").returncode != 0:
            print("self-test setup failed: seed repo", file=sys.stderr)
            return 2
        for args in env_cfg:
            if _git(seed, *args).returncode != 0:
                print("self-test setup failed: git config", file=sys.stderr)
                return 2
        (seed / "f").write_text("1\n")
        _git(seed, "add", "f")
        _git(seed, "commit", "-q", "-m", "c1")
        main_commit = _git(seed, "rev-parse", "HEAD").stdout.strip()
        _git(seed, "remote", "add", "origin", str(bare))
        _git(seed, "push", "-q", "origin", "main")
        _git(seed, "checkout", "-q", "-b", "feat")
        (seed / "f").write_text("2\n")
        _git(seed, "add", "f")
        _git(seed, "commit", "-q", "-m", "c2")
        feat_commit = _git(seed, "rev-parse", "HEAD").stdout.strip()
        _git(seed, "push", "-q", "origin", "feat")

        checkout = Path(td) / "checkout"
        clone = _run_git(
            "clone",
            "-q",
            "--depth=1",
            "--branch",
            "feat",
            f"file://{bare}",
            str(checkout),
        )
        if clone.returncode != 0:
            print(f"self-test setup failed: shallow clone: {_git_detail(clone)}", file=sys.stderr)
            return 2

        ok = True
        branch_ref, resolve_error = _resolve_branch_ref(checkout)
        if resolve_error is not None or branch_ref != "refs/remotes/origin/main":
            print(f"self-test FAIL: remote refresh: {resolve_error or branch_ref}", file=sys.stderr)
            ok = False
        main_is_ancestor, ancestry_error = _is_ancestor(checkout, main_commit, "origin/main")
        if ancestry_error is not None or not main_is_ancestor:
            print(f"self-test FAIL: main ancestry: {ancestry_error or 'not an ancestor'}", file=sys.stderr)
            ok = False
        feature_is_ancestor, ancestry_error = _is_ancestor(checkout, feat_commit, "origin/main")
        if ancestry_error is not None or feature_is_ancestor:
            print("self-test FAIL: feature-only commit should NOT be on main", file=sys.stderr)
            ok = False
        # Exercise a real authenticated Git fetch, with credentials owned only
        # by the superrepo. Local submodule metadata must not receive a copy.
        from functools import partial
        from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
        from threading import Thread

        credential = "fixture-only-authorization"

        class AuthenticatedGitHandler(SimpleHTTPRequestHandler):
            def do_GET(self):
                if self.headers.get("Authorization") != credential:
                    self.send_response(401)
                    self.end_headers()
                    return
                super().do_GET()

            def log_message(self, *_args):
                pass

        _git(bare, "update-server-info")
        server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(AuthenticatedGitHandler, directory=td)
        )
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            remote_url = f"http://127.0.0.1:{server.server_port}/remote.git"
            _git(checkout, "remote", "set-url", "origin", remote_url)
            # The fixture represents actions/checkout storing auth in the root
            # repository, while source-only checkout leaves the child without it.
            _git(seed, "config", f"http.{remote_url}.extraheader", f"Authorization: {credential}")
            unauthenticated_ref, authentication_error = _resolve_branch_ref(checkout)
            if unauthenticated_ref is not None or authentication_error is None:
                print("self-test FAIL: missing credentials must fail refresh", file=sys.stderr)
                ok = False
            authenticated_ref, authentication_error = _resolve_branch_ref(checkout, seed)
            if authenticated_ref != "refs/remotes/origin/main" or authentication_error is not None:
                print(f"self-test FAIL: inherited checkout authentication: {authentication_error}", file=sys.stderr)
                ok = False
            stored = _git(checkout, "config", "--local", "--get-regexp", r"http\..*extraheader")
            if stored.stdout.strip():
                print("self-test FAIL: authentication persisted in submodule config", file=sys.stderr)
                ok = False
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

        super_repo = Path(td) / "super"
        super_repo.mkdir()
        _git(super_repo, "init", "-q", "-b", "main")
        for args in env_cfg:
            _git(super_repo, *args)
        _run_git("clone", "-q", "--branch", "feat", f"file://{bare}", str(super_repo / "dependency"))
        modules = super_repo / ".gitmodules"
        modules.write_text('[submodule "dep"]\n path = dependency\n branch = feat\n')
        _git(super_repo, "add", ".gitmodules")
        _git(super_repo, "update-index", "--add", "--cacheinfo", f"160000,{feat_commit},dependency")
        _git(super_repo, "commit", "-q", "-m", "pin maintained dependency")
        _git(super_repo, "config", "submodule.dep.branch", "missing-local-override")
        _git(super_repo / "dependency", "tag", "origin/feat", main_commit)
        _git(super_repo / "dependency", "tag", "origin/main", feat_commit)
        code, findings = check_repo(super_repo)
        if code != 0:
            print(f"self-test FAIL: explicit maintained branch ancestry: {findings}", file=sys.stderr)
            ok = False
        for branch_lines in (
            "", " branch = .\n", " branch = \n", " branch = bad..name\n",
            " branch = @{-1}\n", " branch = feat\n branch = main\n", " branch = missing\n",
        ):
            modules.write_text('[submodule "dep"]\n path = dependency\n' + branch_lines)
            code, _ = check_repo(super_repo)
            if code == 0:
                print(f"self-test FAIL: unmerged, invalid or missing maintained branch accepted: {branch_lines!r}", file=sys.stderr)
                ok = False

        _git(checkout, "remote", "set-url", "origin", str(Path(td) / "missing.git"))
        missing_ref, refresh_error = _resolve_branch_ref(checkout)
        if missing_ref is not None or refresh_error is None:
            print("self-test FAIL: fetch failure must not use a stale ref", file=sys.stderr)
            ok = False
        if ok:
            print("self-test OK")
            return 0
        return 1


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__.splitlines()[0],
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--repo", type=Path, default=None,
                    help="superrepo worktree to check (default: current directory)")
    ap.add_argument("--self-test", action="store_true",
                    help="run built-in fixtures and exit")
    args = ap.parse_args(argv)

    if args.self_test:
        return _self_test()

    repo = (args.repo or Path.cwd()).resolve()
    if not (repo / ".git").exists():
        print(f"[error] not a git repo: {repo}", file=sys.stderr)
        return 2

    code, findings = check_repo(repo)
    if code == 0:
        print("[OK] all submodule pins are on their declared maintained branches (default: main)")
    else:
        _print_findings(repo, findings)
    return code


if __name__ == "__main__":
    sys.exit(main())
