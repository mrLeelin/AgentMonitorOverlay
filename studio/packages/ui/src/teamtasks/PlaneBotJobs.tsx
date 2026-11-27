import type { PlaneBotJob } from "@amo-studio/protocol";
import { call, type HostLink } from "../host/client.js";
import { useLiveResource } from "../host/live.js";
import { PlaneBotDeliveryCard, planeBotCheckChanged, planeBotStatus } from "./PlaneBot.js";

export function PlaneBotJobs({ link, botId, onOpen }: { link: HostLink; botId: string; onOpen(taskId: string, sessionId?: string, botId?: string): void }) {
  const [jobs, setJobs, reload] = useLiveResource<PlaneBotJob[]>({
    load: () => call(link, "GET /api/team-board/plane/bots/:id/jobs", { id: botId }),
    initial: [], reset: true, reloadDelay: 80,
    reloadOn: (event): boolean => event.type === "plane.bot.changed" || (event.type === "data.purged" && event.taskIds.length > 0)
      || jobs.some((job) => planeBotCheckChanged(job, event)),
    onError: () => setJobs([]),
  }, [link, botId]);
  const visible = jobs.filter((job) => !!job.item);
  if (!visible.length) return null;
  const open = (taskId: string, sessionId?: string) => onOpen(taskId, sessionId, botId);
  const update = (updated: PlaneBotJob) => setJobs((rows) => rows.map((row) => row.taskId === updated.taskId ? updated : row));
  return <section aria-label="Plane 工单" className="settings-section plane-bot-jobs">
    <strong>Plane 工单</strong>
    {visible.map((job, index) => <details className="plane-bot-job" data-state={job.state} key={job.taskId ?? job.botSessionId ?? `${job.itemId}:${index}`} open={job.state === "review"}>
      <summary><strong>{job.item.number} · {job.item.title}</strong><span className="plane-bot-job-status">{planeBotStatus(job)}</span></summary>
      <div className="plane-bot-job-content">
        {job.state === "failed" && job.error && <p className="form-error">{job.error}</p>}
        {job.state === "awaiting-approval" && <p className="settings-hint">到团队看板的原单上确认。</p>}
        {job.delivery && <PlaneBotDeliveryCard key={job.delivery.resultId} link={link} job={job} onJobChange={update} onReload={reload} onOpen={open} />}
        {job.taskId ? <button type="button" className="btn-ghost small" onClick={() => open(job.taskId!)}>打开执行任务</button>
          : job.botTaskId && job.botSessionId ? <button type="button" className="btn-ghost small" onClick={() => open(job.botTaskId!, job.botSessionId!)}>查看 Bot 分析</button> : null}
      </div>
    </details>)}
  </section>;
}
