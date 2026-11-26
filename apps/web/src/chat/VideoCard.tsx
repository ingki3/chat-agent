import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { VIDEO_ENDED, VIDEO_JOB_CODE_TEXT, VideoJob, VideoJobRefusal } from "@agentlee/shared";
import { ApiError, errorText, files, videoJobs } from "../api.js";
import { audioText, canPlayMp4, newestJob, usdText, VIDEO_STATUS_TEXT } from "./video-card.js";

const key = (id: string) => ["video-job", id] as const;

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

/** Follows the job live (server-sent events) while it can still change; a page that cannot falls back to polling. */
function useVideoJob(id: string) {
  const qc = useQueryClient();
  const [polling, setPolling] = useState(false);
  const q = useQuery({
    queryKey: key(id),
    queryFn: () => videoJobs.get(id),
    structuralSharing: (old: unknown, next: unknown) =>
      newestJob(old as VideoJob | undefined, next as VideoJob),
    refetchInterval: (query) =>
      polling && query.state.data && !VIDEO_ENDED.has(query.state.data.status) ? 5000 : false,
    retry: (n, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && n < 2,
  });
  const status = q.data?.status;
  // Waiting for approval changes only when someone acts (or it expires): a stream is opened once it runs.
  const live = !!status && !VIDEO_ENDED.has(status) && status !== "awaiting_approval";
  useEffect(() => {
    if (!live || typeof EventSource === "undefined") return;
    const es = new EventSource(videoJobs.eventsUrl(id));
    es.addEventListener("job", (e) => {
      const parsed = VideoJob.safeParse(JSON.parse((e as MessageEvent<string>).data));
      if (parsed.success) qc.setQueryData<VideoJob>(key(id), (old) => newestJob(old, parsed.data));
    });
    es.onerror = () => {
      es.close();
      setPolling(true);
    };
    return () => es.close();
  }, [id, live, qc]);
  return q;
}

/**
 * The confirmation card of `video_generate` (#238 stage 3): what would be made — model, length, resolution, aspect
 * ratio, sound, the most it may cost — and 승인 / 닫기. Nothing is made or paid until the owner approves it here (their
 * own request names the card's version); then its progress, live, and the video in a player (an old browser gets the
 * download). The job runs on the server: leaving the page changes nothing. Offline, 승인 is disabled.
 */
export function VideoCard({ jobId }: { jobId: string }) {
  const qc = useQueryClient();
  const q = useVideoJob(jobId);
  const online = useOnline();
  const [notice, setNotice] = useState<{ kind: "changed" | "error"; error?: unknown } | null>(null);
  const settle = (e: unknown) => {
    const body = e instanceof ApiError ? VideoJobRefusal.safeParse(e.body) : undefined;
    if (body?.success && body.data.job) qc.setQueryData<VideoJob>(key(jobId), body.data.job);
    const changed =
      e instanceof ApiError && (e.code === "video_job_changed" || e.code === "video_estimate_changed");
    setNotice(changed ? { kind: "changed", error: e } : { kind: "error", error: e });
  };
  const approve = useMutation({
    mutationFn: (version: number) => videoJobs.approve(jobId, version),
    onMutate: () => setNotice(null),
    onSuccess: (j) => qc.setQueryData<VideoJob>(key(jobId), (old) => newestJob(old, j)),
    onError: settle,
  });
  const dismiss = useMutation({
    mutationFn: (version: number) => videoJobs.dismiss(jobId, version),
    onMutate: () => setNotice(null),
    onSuccess: (j) => qc.setQueryData<VideoJob>(key(jobId), (old) => newestJob(old, j)),
    onError: settle,
  });
  const job = q.data;
  const headId = `video-card-${jobId}`;
  if (q.isError)
    return (
      <div className="video-card small muted" data-testid="video-card">
        {q.error instanceof ApiError && q.error.status === 403
          ? "영상 확인 카드는 대화 주인만 볼 수 있어요."
          : `영상 확인 카드를 불러오지 못했어요. ${errorText(q.error)}`}
      </div>
    );
  if (!job)
    return (
      <div className="video-card small muted" data-testid="video-card">
        영상 확인 카드를 불러오는 중…
      </div>
    );
  const busy = approve.isPending || dismiss.isPending;
  const waiting = job.status === "awaiting_approval";
  const running = !waiting && !VIDEO_ENDED.has(job.status);
  return (
    <section
      className="video-card"
      data-testid="video-card"
      data-status={job.status}
      aria-labelledby={headId}
    >
      <div className="row">
        <span aria-hidden>🎬</span>
        <b id={headId} className="grow">
          영상 만들기
        </b>
        <span
          className={`badge ${job.status === "done" ? "ok" : job.status === "failed" ? "err" : waiting ? "" : "gray"}`}
          data-testid="video-card-status"
        >
          {VIDEO_STATUS_TEXT[job.status]}
        </span>
      </div>
      <p className="video-prompt small">{job.prompt}</p>
      <dl className="sched-facts small">
        <dt>모델</dt>
        <dd>{job.model}</dd>
        <dt>길이</dt>
        <dd data-testid="video-card-duration">{job.durationSec}초</dd>
        <dt>해상도</dt>
        <dd data-testid="video-card-resolution">{job.resolution}</dd>
        <dt>화면비</dt>
        <dd>{job.aspectRatio ?? "모델 기본값"}</dd>
        <dt>소리</dt>
        <dd>{audioText(job.audio)}</dd>
        <dt>{job.costUsd === null ? "예상 최대 비용" : "비용"}</dt>
        <dd data-testid="video-card-cost">
          {job.costUsd === null ? `최대 ${usdText(job.estimateUsd)}` : usdText(job.costUsd)}
        </dd>
      </dl>
      {waiting && (
        <>
          <p className="muted small">
            승인하면 바로 OpenRouter에 보내고, 승인한 뒤에는 취소할 수 없어요. 몇 분 걸릴 수 있고 이 화면을
            닫아도 서버에서 계속 만들어요. 오늘 미디어 예산에서 최대 비용만큼을 먼저 잡아 두고, 끝나면 실제
            비용으로 바꿔요.
          </p>
          <div className="row wrap">
            <button
              type="button"
              className="primary"
              disabled={busy || !online}
              onClick={() => approve.mutate(job.version)}
              data-testid="video-card-approve"
            >
              {approve.isPending ? "보내는 중…" : "승인하고 만들기"}
            </button>
            <button
              type="button"
              disabled={busy || !online}
              onClick={() => dismiss.mutate(job.version)}
              data-testid="video-card-dismiss"
            >
              닫기
            </button>
          </div>
          {!online && (
            <p className="muted small" role="status" data-testid="video-card-offline">
              인터넷에 연결되면 승인할 수 있어요.
            </p>
          )}
        </>
      )}
      {running && (
        <p className="small" role="status" data-testid="video-card-progress">
          {VIDEO_STATUS_TEXT[job.status]}
          {job.progress !== null && job.status === "in_progress" ? ` (${job.progress}%)` : ""} — 60분 안에
          끝나지 않으면 멈춰요. 승인한 뒤에는 취소할 수 없어요.
        </p>
      )}
      {job.status === "done" && job.file && <Player file={job.file} />}
      {job.status === "done" && !job.file && (
        <p className="muted small">영상 파일이 이 대화에서 지워졌어요.</p>
      )}
      {job.errorCode && (job.status === "failed" || job.status === "expired") && (
        <p
          className={job.status === "failed" ? "error small" : "muted small"}
          data-testid="video-card-reason"
        >
          {VIDEO_JOB_CODE_TEXT[job.errorCode]}
        </p>
      )}
      {notice?.kind === "changed" && (
        <p className="notice warn small" role="alert" data-testid="video-card-changed">
          {errorText(notice.error)}
        </p>
      )}
      {notice?.kind === "error" && (
        <p className="error small" role="alert" data-testid="video-card-error">
          {errorText(notice.error)}
        </p>
      )}
    </section>
  );
}

/** The video in place (`?inline=1`: only a video job's checked MP4 is served so), or — can't play MP4 — its download. */
function Player({ file }: { file: NonNullable<VideoJob["file"]> }) {
  const [playable] = useState(canPlayMp4);
  const [failed, setFailed] = useState(false);
  return (
    <div className="video-player" data-testid="video-card-player">
      {playable && !failed ? (
        <video
          className="video-el"
          controls
          preload="metadata"
          playsInline
          src={files.url(file.fileId, true)}
          aria-label={`${file.name} 재생`}
          onError={() => setFailed(true)}
          data-testid="video-card-video"
        />
      ) : (
        <p className="muted small" data-testid="video-card-no-player">
          이 브라우저에서는 영상을 바로 재생할 수 없어요. 내려받아 보세요.
        </p>
      )}
      <a
        className="chip small fileref"
        href={files.url(file.fileId)}
        download
        data-testid="video-card-download"
      >
        📎 {file.name} 내려받기
      </a>
    </div>
  );
}
