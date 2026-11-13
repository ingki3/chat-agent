# The interpreter side of `python_run` (#47). Started by the server as
#   <standalone python>/bin/python3.12 -I -S -B runner.py
# inside the macOS sandbox (apps/server/src/python/runner.ts): its working folder is the only place it may read
# besides the interpreter, this folder and the pinned packages, and the only place it may write; no network, no
# child processes, an environment of a few fixed variables. The sandbox is the guarantee; this file only runs the
# code and reports what happened.
#
# stdin: one JSON object {code, files, packages, limits}. stdout: one JSON object (the report). The code's own
# output goes to capped buffers; file descriptors 1 and 2 are pointed at /dev/null while it runs, so nothing the
# code writes there can mix with the report.
import builtins
import io
import json
import linecache
import os
import sys
import traceback

FILENAME = "<python_run>"


class Capped(io.TextIOBase):
    """A text stream that keeps the first `limit` characters and counts the rest."""

    def __init__(self, limit):
        super().__init__()
        self.limit = limit
        self.parts = []
        self.kept = 0
        self.total = 0

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def isatty(self):
        return False

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError("write() argument must be str, not %s" % type(s).__name__)
        self.total += len(s)
        room = self.limit - self.kept
        if room > 0:
            part = s[:room]
            self.parts.append(part)
            self.kept += len(part)
        return len(s)

    def text(self):
        return "".join(self.parts)


def set_limits(limits):
    try:
        import resource

        cpu = int(limits["cpuSeconds"])
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        size = int(limits["fileBytes"])
        resource.setrlimit(resource.RLIMIT_FSIZE, (size, size))
    except Exception:
        pass  # the server's own limits (time, memory, folder size) still hold


def user_traceback(exc):
    """The traceback without this file's own frame (the code's frames and the libraries' it called)."""
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename != __file__]
    lines = ["Traceback (most recent call last):\n"] if frames else []
    lines += traceback.format_list(frames)
    lines += traceback.format_exception_only(type(exc), exc)
    return "".join(lines)


def main():
    job = json.loads(sys.stdin.read())
    report_fd = os.dup(1)
    try:
        null = os.open(os.devnull, os.O_WRONLY)
        os.dup2(null, 1)
        os.dup2(null, 2)
        os.close(null)
    except OSError:
        pass
    # In launcher mode the trusted launcher sets AGENTLEE_PACKAGES to the root-owned packages dir; it wins over any
    # path from stdin (the server's own copy path is never used as the import root).
    env_packages = os.environ.get("AGENTLEE_PACKAGES")
    if env_packages:
        job["packages"] = env_packages
    limits = job["limits"]
    set_limits(limits)
    if job.get("packages"):
        sys.path.insert(0, job["packages"])
    out = Capped(int(limits["captureChars"]))
    err = Capped(int(limits["captureChars"]))
    code = job["code"]
    # Source lines for the traceback.
    linecache.cache[FILENAME] = (len(code), None, code.splitlines(True), FILENAME)
    scope = {"__name__": "__main__", "__builtins__": builtins, "FILES": dict(job.get("files") or {})}
    report = {"status": "ok", "exitCode": 0, "errorType": None, "traceback": None}
    sys.stdout, sys.stderr, sys.stdin = out, err, io.StringIO("")
    try:
        exec(compile(code, FILENAME, "exec"), scope)
    except SystemExit as e:
        c = e.code
        report["exitCode"] = c if isinstance(c, int) else (0 if c is None else 1)
        if c is not None and not isinstance(c, int):
            err.write(str(c) + "\n")
        if report["exitCode"] != 0:
            report["status"] = "error"
            report["errorType"] = "SystemExit"
    except BaseException as e:  # noqa: B036 — the code's every failure is reported, KeyboardInterrupt included
        report["status"] = "error"
        report["exitCode"] = 1
        report["errorType"] = type(e).__name__[:100]
        try:
            report["traceback"] = user_traceback(e)
        except BaseException:
            report["traceback"] = type(e).__name__
    finally:
        sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
    report.update(
        stdout=out.text(),
        stdoutChars=out.total,
        stderr=err.text(),
        stderrChars=err.total,
    )
    data = json.dumps(report, ensure_ascii=False).encode("utf-8", "replace")
    view = memoryview(data)
    while view:
        n = os.write(report_fd, view)
        view = view[n:]
    os.close(report_fd)


main()
