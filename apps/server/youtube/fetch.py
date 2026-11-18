"""youtube_audio_fetch (#191): the pinned yt-dlp, run as `python -I -S -B fetch.py` inside its sandbox.

The job comes as one JSON object on stdin, one JSON report goes to stdout — never yt-dlp's own messages: they are
read here only to tell why a call failed (a fixed code), and dropped. Modes:

- probe:    the video's metadata (no download) — the server checks duration, live status and the audio formats
            before anything is downloaded. The whole info goes to `info` (a file of the working folder) for the
            download step; stdout gets a small summary.
- download: the chosen audio-only format of that info, into `out` as `audio.<ext>`, at most `maxBytes`.
- check:    `pnpm youtube:check` — yt-dlp imports, deno starts as yt-dlp starts it and solves a tiny script, the
            challenge scripts are there. No network.

Network: only through `proxy` (the server's egress proxy for YouTube's hosts — the sandbox allows nothing else).
No cookies, no login, no config files (`-I`, HOME is the working folder), no remote components (the JS challenge
scripts come from the pinned yt-dlp-ejs; deno gets `--no-remote --no-npm`), no post-processing (ffmpeg runs in
its own sandbox afterwards).
"""

import errno
import json
import os
import resource
import sys

# Room above the download limit for RLIMIT_FSIZE (a part file's last chunk; deno's cache files are small).
FSIZE_MARGIN = 2 * 1024 * 1024


# What yt-dlp's deno gets besides yt-dlp's own options (`--no-remote --no-npm --cached-only …`): an explicit denial
# of deno's permissions. deno already grants none by default (no `--allow-*` is passed); this keeps it so even if a
# later yt-dlp starts passing one. The player JS then cannot start a process, load a native library, read the
# environment or system information, use deno's file APIs (read or write), open network connections or import from
# remote hosts. Local module loading still works (a static or dynamic import of a local file, a `data:` import):
# what it can reach is bounded by the OS sandbox profile — the work folder, the pinned runtime and packages,
# apps/server/youtube, the system CA bundle and the OS files of system.sb; family data is not readable. This guards the trusted path (the pinned yt-dlp running
# YouTube's JS); it is not a boundary against the python side itself — python may exec itself and deno with any
# arguments, so for malicious code the OS sandbox is the boundary (docs/decisions/isolation.md, #191 review 3/4).
DENO_LOCKDOWN = (
    "--deny-run",
    "--deny-ffi",
    "--deny-sys",
    "--deny-env",
    "--deny-net",
    "--deny-read",
    "--deny-write",
    "--deny-import",
)


def lock_deno():
    """Appends DENO_LOCKDOWN to the options yt-dlp starts deno with; refuses (raises) if those options are not where
    this pinned yt-dlp keeps them, or already allow something — fail closed on a yt-dlp that changed."""
    from yt_dlp.extractor.youtube.jsc._builtin import deno as jcp

    base = list(jcp.DenoJCP._DENO_BASE_OPTIONS)
    if any(o.startswith("--allow") or o == "-A" for o in base):
        raise RuntimeError("deno options allow a permission")
    jcp.DenoJCP._DENO_BASE_OPTIONS = [o for o in base if o not in DENO_LOCKDOWN] + list(DENO_LOCKDOWN)
    return list(jcp.DenoJCP._DENO_BASE_OPTIONS)


class TooLarge(BaseException):
    """Raised from the progress hook: a BaseException, so no `except Exception` inside yt-dlp swallows it or
    retries the download with the page's address."""

# Why yt-dlp failed, from its messages (lower case), first match wins. The bot check comes before the login
# group: its message also says "sign in".
CLASSES = (
    (
        "youtube_bot_check",
        (
            "not a bot",
            "confirm you're not",
            "confirm you’re not",
            "http error 429",
            "too many requests",
            "rate-limit",
            "rate limit",
        ),
    ),
    (
        "youtube_login_required",
        (
            "confirm your age",
            "age-restricted",
            "age restricted",
            "inappropriate for some users",
            "private video",
            "members-only",
            "members only",
            "join this channel",
            "requires payment",
            "premium",
            "sign in",
            "login required",
        ),
    ),
    (
        "youtube_live",
        (
            "live event will begin",
            "premieres in",
            "premiere will begin",
            "this live event",
            "is live",
            "live stream recording is not available",
        ),
    ),
    (
        "youtube_unavailable",
        (
            "video unavailable",
            "is not available",
            "isn't available",
            "not available in your country",
            "has been removed",
            "copyright",
            "account associated with this video has been terminated",
        ),
    ),
    ("youtube_no_audio", ("requested format is not available", "no video formats found")),
    ("youtube_too_large", ("larger than max-filesize",)),
)

AUDIO_KEYS = (
    "format_id",
    "ext",
    "acodec",
    "vcodec",
    "abr",
    "tbr",
    "asr",
    "audio_channels",
    "filesize",
    "filesize_approx",
    "protocol",
    "language",
    "language_preference",
    "format_note",
    "has_drm",
)


class Log:
    """yt-dlp's logger: keeps the last error messages (bounded) for `classify`, prints nothing."""

    def __init__(self):
        self.lines = []

    def debug(self, msg):
        # The one screen message that tells a reason: yt-dlp stops a download over max_filesize without an error.
        if "larger than max-filesize" in str(msg):
            self.error(msg)

    def info(self, msg):
        self.debug(msg)

    def warning(self, msg):
        pass

    def error(self, msg):
        self.lines.append(str(msg)[:800].lower())
        del self.lines[:-20]


def classify(texts):
    """The first text (the exception's message, then the newest errors) that names a known reason decides."""
    for t in texts:
        for code, needles in CLASSES:
            if any(n in t for n in needles):
                return code
    return "youtube_failed"


def options(job, log):
    return {
        "quiet": True,
        "noprogress": True,
        "logger": log,
        "color": {"stdout": "no_color", "stderr": "no_color"},
        "noplaylist": True,
        "allowed_extractors": ["youtube"],
        "proxy": job["proxy"],
        "socket_timeout": 30,
        "retries": 3,
        "fragment_retries": 3,
        "extractor_retries": 1,
        "js_runtimes": {"deno": {"path": job["deno"]}},
        "remote_components": [],
        "cachedir": False,
        "cookiefile": None,
        "writeinfojson": False,
        "writethumbnail": False,
        "writesubtitles": False,
        "writeautomaticsub": False,
        "live_from_start": False,
        "wait_for_video": None,
        "check_formats": False,
        "postprocessors": [],
        "fixup": "never",
    }


def summary(info):
    formats = []
    for f in info.get("formats") or []:
        if not isinstance(f, dict):
            continue
        if f.get("vcodec") not in (None, "none") or f.get("acodec") in (None, "none"):
            continue
        formats.append({k: f.get(k) for k in AUDIO_KEYS if f.get(k) is not None})
    keep = (
        "id",
        "title",
        "description",
        "channel",
        "uploader",
        "upload_date",
        "duration",
        "live_status",
        "is_live",
        "was_live",
        "availability",
        "age_limit",
        "extractor_key",
    )
    out = {k: info.get(k) for k in keep if info.get(k) is not None}
    out["type"] = info.get("_type") or "video"
    out["description"] = str(out.get("description", ""))[:4000]
    out["formats"] = formats[:80]
    return out


def main():
    job = json.loads(sys.stdin.read())
    sys.path.insert(0, job["packages"])
    import yt_dlp  # noqa: E402 — from the pinned packages only

    mode = job["mode"]
    log = Log()
    deno_args = lock_deno()
    if mode == "check":
        import yt_dlp_ejs.yt.solver  # noqa: F401 — the challenge scripts are installed
        from yt_dlp.extractor.youtube.jsc._builtin import deno as jcp

        # Through yt-dlp's own provider, as a YouTube extraction would: its runtime lookup, its script sources (the
        # installed yt-dlp-ejs), its deno command line (recorded here) — with a probe instead of a player. The probe
        # loads the solver scripts, then tries to start an executable the OS sandbox does allow (this deno itself):
        # only deno's own permission check can refuse that, so the answer must be its `NotCapable`.
        argvs = []

        class Recording(jcp.Popen):
            def __init__(self, args, *a, **k):
                argvs.append(list(args))
                super().__init__(args, *a, **k)

        jcp.Popen = Recording

        class Quiet:
            def __getattr__(self, _name):
                return lambda *a, **k: None

        with yt_dlp.YoutubeDL(options(job, log)) as ydl:
            provider = jcp.DenoJCP(ydl.get_info_extractor("Youtube"), Quiet(), {})
            if not provider.is_available():
                return {"ok": False, "error": "deno"}
            lib, core = provider._lib_script, provider._core_script
            probe_js = (
                "let refused = 'ran';"
                f" try {{ new Deno.Command({json.dumps(job['deno'])}, {{ args: ['--version'] }}).outputSync(); }}"
                " catch (e) { refused = e.name; }"
                " console.log(JSON.stringify({ solver: typeof jsc, refused }))"
            )
            out = provider._run_js_runtime(f"{lib.code}\nObject.assign(globalThis, lib);\n{core.code}\n{probe_js}")
        got = json.loads(out or "{}")
        run_args = [a for a in argvs if len(a) > 1 and a[1] == "run"]
        ok = (
            got.get("solver") == "function"
            and got.get("refused") == "NotCapable"
            and len(run_args) == 1
            and not any(a.startswith("--allow") or a == "-A" for a in run_args[0])
        )
        return {
            "ok": ok,
            "ytdlp": yt_dlp.version.__version__,
            "deno": provider.runtime_info.version,
            "denoArgs": deno_args,
            "providerArgv": run_args[0][1:] if run_args else None,
            "scripts": [lib.source.value, core.source.value],
        }
    if mode == "probe":
        opts = options(job, log)
        # Metadata only: no format is required to exist (the server decides from the audio formats listed).
        opts.update({"skip_download": True, "format": "bestaudio/best", "ignore_no_formats_error": True})
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.sanitize_info(ydl.extract_info(job["url"], download=False))
        except Exception as e:  # yt-dlp's DownloadError and anything else: a fixed code only
            return {"ok": False, "error": classify([str(e).lower()] + log.lines[::-1])}
        if not isinstance(info, dict):
            return {"ok": False, "error": "youtube_failed"}
        with open(job["info"], "w", encoding="utf-8") as f:
            json.dump(info, f)
        return {"ok": True, "info": summary(info)}
    if mode == "download":
        out = job["out"]
        limit = int(job["maxBytes"])
        opts = options(job, log)

        def bounded(d):
            # Every progress report, whatever the server said the size would be (none, or a wrong one): the bytes
            # actually received, and the file on disk, never over the limit. yt-dlp's max_filesize alone only
            # compares the announced length.
            got = d.get("downloaded_bytes") or 0
            for key in ("tmpfilename", "filename"):
                name = d.get(key)
                if name:
                    try:
                        got = max(got, os.path.getsize(name))
                    except OSError:
                        pass
            if got > limit:
                raise TooLarge()

        opts.update(
            {
                "format": job["formatId"],
                "outtmpl": {"default": os.path.join(out, "audio.%(ext)s")},
                "paths": {"home": out, "temp": out},
                "max_filesize": limit,
                "progress_hooks": [bounded],
                "overwrites": True,
                "continuedl": False,
                "http_chunk_size": 10 * 1024 * 1024,
            }
        )
        # And the kernel's own bound on every file this process (and the deno it starts) writes: a write past it
        # fails (EFBIG — python ignores SIGXFSZ), even between two progress reports.
        resource.setrlimit(resource.RLIMIT_FSIZE, (limit + FSIZE_MARGIN, limit + FSIZE_MARGIN))
        try:
            with yt_dlp.YoutubeDL(opts) as ydl:
                rc = ydl.download_with_info_file(job["info"])
        except TooLarge:
            return {"ok": False, "error": "youtube_too_large"}
        except Exception as e:
            text = str(e).lower()
            if (isinstance(e, OSError) and e.errno == errno.EFBIG) or "file too large" in text:
                return {"ok": False, "error": "youtube_too_large"}
            return {"ok": False, "error": classify([text] + log.lines[::-1])}
        names = sorted(n for n in os.listdir(out) if n.startswith("audio.") and not n.endswith(".part"))
        if rc != 0 or len(names) != 1:
            # yt-dlp returns without a file (and without an error) when the file is over max_filesize; a failed
            # write past RLIMIT_FSIZE is reported as an error message.
            if any("file too large" in t or "errno 27" in t for t in log.lines):
                return {"ok": False, "error": "youtube_too_large"}
            return {"ok": False, "error": classify(log.lines[::-1])}
        size = os.path.getsize(os.path.join(out, names[0]))
        if size > limit:
            return {"ok": False, "error": "youtube_too_large"}
        return {"ok": True, "file": names[0], "bytes": size}
    return {"ok": False, "error": "youtube_bad_input"}


if __name__ == "__main__":
    try:
        result = main()
    except Exception:
        result = {"ok": False, "error": "youtube_failed"}
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()
