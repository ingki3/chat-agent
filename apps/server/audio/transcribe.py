# The interpreter side of `audio_transcribe` (#173). Started by the server as
#   <standalone python>/bin/python3.12 -I -S -B transcribe.py
# inside the macOS sandbox (apps/server/src/audio/runner.ts): it may read the interpreter, this folder, the pinned
# packages and models (program folders) and its working folder, and write only its working folder; no network, no
# child processes, the GPU through Metal only. Its input is a 16 kHz mono PCM WAV that ffmpeg made in a sandbox of
# its own — this process never parses the uploaded container.
#
# stdin: one JSON object {packages, models: {stt, diarizer}, wav, language, diarize, threshold, minDuration,
# mergeGap, fileBytes}. stdout: one JSON object (the report). File descriptors 1 and 2 point at /dev/null while the
# models run (libraries print progress and warnings), so nothing they write can mix with the report — or reach a
# log: the report carries exception type names only, never messages (they may quote the audio's words).
import json
import os
import sys
import time


def set_limits(job):
    try:
        import resource

        size = int(job["fileBytes"])
        resource.setrlimit(resource.RLIMIT_FSIZE, (size, size))
    except Exception:
        pass  # the server's own limits (time, memory, folder size) still hold


def error_name(exc):
    name = type(exc).__name__
    return name if name.isidentifier() and len(name) <= 100 else "Error"


def diarize(job):
    from mlx_audio.vad import load

    model = load(job["models"]["diarizer"], strict=True)
    result = model.generate(
        job["wav"],
        threshold=float(job["threshold"]),
        min_duration=float(job["minDuration"]),
        merge_gap=float(job["mergeGap"]),
    )
    return [
        {"speaker": int(s.speaker), "start": float(s.start), "end": float(s.end)} for s in result.segments
    ]


def transcribe(job):
    from mlx_audio.stt import load

    model = load(job["models"]["stt"])
    out = model.generate(
        job["wav"],
        language=job["language"],
        task="transcribe",
        verbose=None,
        # Long recordings: conditioning on the previous window is what makes Whisper loop on one sentence.
        condition_on_previous_text=False,
    )
    segments = []
    for s in out.segments or []:
        text = str(s.get("text", "")).strip()
        if text:
            segments.append({"start": float(s["start"]), "end": float(s["end"]), "text": text})
    return segments


def main():
    job = json.loads(sys.stdin.read())
    report_fd = os.dup(1)
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    sys.stdout = open(os.devnull, "w")
    sys.stderr = sys.stdout
    sys.path.insert(0, job["packages"])
    set_limits(job)
    report = {"stt": None, "diarization": None}
    t0 = time.monotonic()
    if job.get("diarize"):
        try:
            report["diarization"] = {"ok": True, "segments": diarize(job)}
        except BaseException as e:  # noqa: BLE001 — reported as a failed stage; the words may still come
            report["diarization"] = {"ok": False, "error": error_name(e)}
    t1 = time.monotonic()
    if job.get("stt", True):
        try:
            report["stt"] = {"ok": True, "segments": transcribe(job)}
        except BaseException as e:  # noqa: BLE001 — the server decides on the fallback
            report["stt"] = {"ok": False, "error": error_name(e)}
    report["seconds"] = {"diarization": round(t1 - t0, 3), "stt": round(time.monotonic() - t1, 3)}
    data = json.dumps(report, ensure_ascii=False).encode("utf-8")
    view = memoryview(data)
    while view:
        n = os.write(report_fd, view)
        view = view[n:]
    os.close(report_fd)


main()
