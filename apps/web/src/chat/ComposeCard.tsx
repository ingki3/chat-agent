import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { COMPOSE_ENDED, COMPOSE_JOB_CODE_TEXT, ComposeJob } from "@agentlee/shared";
import { ApiError, composeJobs, errorText, files } from "../api.js";
import { canPlayMp4 } from "./video-card.js";
import { COMPOSE_STATUS_TEXT, composePollMs, durationText, newestComposeJob } from "./compose-card.js";

const key = (id: string) => ["compose-job", id] as const;

/** Follows the job live (server-sent events) while it can still change; a page that cannot falls back to polling. */
function useComposeJob(id: string) {
  const qc = useQueryClient();
  const [polling, setPolling] = useState(false);
  const q = useQuery({
    queryKey: key(id),
    queryFn: () => composeJobs.get(id),
    structuralSharing: (old: unknown, next: unknown) =>
      newestComposeJob(old as ComposeJob | undefined, next as ComposeJob),
    refetchInterval: (query) =>
      composePollMs(query.state.data?.status, polling, typeof EventSource !== "undefined"),
    retry: (n, e) => !(e instanceof ApiError && (e.status === 403 || e.status === 404)) && n < 2,
  });
  const status = q.data?.status;
  const live = !!status && !COMPOSE_ENDED.has(status);
  useEffect(() => {
    if (!live || typeof EventSource === "undefined") return;
    const es = new EventSource(composeJobs.eventsUrl(id));
    es.addEventListener("job", (e) => {
      const parsed = ComposeJob.safeParse(JSON.parse((e as MessageEvent<string>).data));
      if (parsed.success) qc.setQueryData<ComposeJob>(key(id), (old) => newestComposeJob(old, parsed.data));
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
 * The card of a `compose_video` call (#238 stage 4-1): its place in the queue, a progress bar while it runs, then the
 * video in a player with its subtitle track (on by default, switchable in the player) — or why it failed. The job runs
 * on the server (no cost, no approval): leaving the page changes nothing. A browser that cannot play MP4 gets the
 * download.
 */
export function ComposeCard({ jobId }: { jobId: string }) {
  const q = useComposeJob(jobId);
  const job = q.data;
  const headId = `compose-card-${jobId}`;
  if (q.isError)
    return (
      <div className="video-card small muted" data-testid="compose-card">
        {q.error instanceof ApiError && q.error.status === 403
          ? "영상 합성 카드는 대화 주인만 볼 수 있어요."
          : `영상 합성 카드를 불러오지 못했어요. ${errorText(q.error)}`}
      </div>
    );
  if (!job)
    return (
      <div className="video-card small muted" data-testid="compose-card">
        영상 합성 카드를 불러오는 중…
      </div>
    );
  const running = job.status === "running";
  return (
    <section
      className="video-card"
      data-testid="compose-card"
      data-status={job.status}
      aria-labelledby={headId}
    >
      <div className="row">
        <span aria-hidden>🎞️</span>
        <b id={headId} className="grow">
          영상 합성
        </b>
        <span
          className={`badge ${job.status === "done" ? "ok" : job.status === "failed" ? "err" : "gray"}`}
          data-testid="compose-card-status"
        >
          {COMPOSE_STATUS_TEXT[job.status]}
        </span>
      </div>
      <dl className="sched-facts small">
        <dt>길이</dt>
        <dd data-testid="compose-card-duration">{durationText(job)}</dd>
        <dt>크기</dt>
        <dd>
          {job.width > 0
            ? `${job.width}×${job.height}, 30fps`
            : COMPOSE_ENDED.has(job.status)
              ? "확인할 수 없음"
              : "계산 중"}
        </dd>
        <dt>클립</dt>
        <dd>{job.clips}개</dd>
        <dt>자막</dt>
        <dd>{job.subtitles ? "있음 (켜고 끌 수 있어요)" : "없음"}</dd>
      </dl>
      {job.status === "queued" && (
        <p className="small" role="status" data-testid="compose-card-queue">
          {job.queuePosition === 1
            ? "다음 차례예요. 앞의 합성이 끝나면 바로 시작해요."
            : `대기 ${job.queuePosition ?? "?"}번째예요. 한 번에 하나씩 합성해요.`}
        </p>
      )}
      {running && (
        <div className="compose-progress" data-testid="compose-card-progress">
          <progress max={100} value={job.progress ?? 0} aria-label="합성 진행률" />
          <span className="small" role="status">
            {job.progress ?? 0}% — 30분 안에 끝나지 않으면 멈춰요. 이 화면을 닫아도 서버에서 계속 만들어요.
          </span>
        </div>
      )}
      {job.status === "done" && job.file && <Player job={job} file={job.file} />}
      {job.status === "done" && !job.file && (
        <p className="muted small">합성한 영상 파일이 이 대화에서 지워졌어요.</p>
      )}
      {job.status === "failed" && job.errorCode && (
        <p className="error small" data-testid="compose-card-reason">
          {COMPOSE_JOB_CODE_TEXT[job.errorCode]}
        </p>
      )}
    </section>
  );
}

/** The video in place (`?inline=1`: only a checked result is served so) with its subtitles, or — no MP4 — the download. */
function Player({ job, file }: { job: ComposeJob; file: NonNullable<ComposeJob["file"]> }) {
  const [playable] = useState(canPlayMp4);
  const [failed, setFailed] = useState(false);
  return (
    <div className="video-player" data-testid="compose-card-player">
      {playable && !failed ? (
        <video
          className="video-el"
          controls
          preload="metadata"
          playsInline
          src={files.url(file.fileId, true)}
          aria-label={`${file.name} 재생`}
          onError={() => setFailed(true)}
          data-testid="compose-card-video"
        >
          {job.subtitles && (
            <track
              kind="subtitles"
              srcLang="ko"
              label="한국어"
              default
              src={composeJobs.subtitlesUrl(job.id)}
              data-testid="compose-card-track"
            />
          )}
        </video>
      ) : (
        <p className="muted small" data-testid="compose-card-no-player">
          이 브라우저에서는 영상을 바로 재생할 수 없어요. 내려받아 보세요.
        </p>
      )}
      <a
        className="chip small fileref"
        href={files.url(file.fileId)}
        download
        data-testid="compose-card-download"
      >
        📎 {file.name} 내려받기
      </a>
    </div>
  );
}
