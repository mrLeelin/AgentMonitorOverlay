import { TEAM_TASK_FILE_COUNT, TEAM_TASK_FILE_LIMIT, type TeamTask, type TeamTaskFile, type TeamTaskFileInput, type TeamTaskStatus } from "@amo-studio/protocol";

export const TEAM_STATUS: Record<TeamTaskStatus, string> = { pending: "待处理", doing: "处理中", review: "待验收", done: "已完成" };
const ACTION = { create: "提交任务", start: "开始执行", deliver: "提交结果", accept: "确认完成", return: "发回处理", note: "补充说明" };
const date = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
export const teamDate = (at: number) => date.format(at);

export function TeamStatus({ status }: { status: TeamTaskStatus }) {
  return <span className={`tt-status tt-${status}`}>{TEAM_STATUS[status]}</span>;
}

export function TeamTaskHistory({ ticket, onFile }: { ticket: TeamTask; onFile(file: TeamTaskFile): void }) {
  return (
    <section className="tt-history" aria-label="任务记录">
      <h3>任务记录</h3>
      <ol>{ticket.events.map((entry) => (
        <li key={entry.id}>
          <div className="tt-event-head"><strong>{ACTION[entry.action]}</strong><span>{entry.actor}</span><time>{teamDate(entry.at)}</time></div>
          {entry.text && <p className="tt-copy">{entry.text}</p>}
          {!!entry.files.length && <div className="tt-attachments">{entry.files.map((file) => <button key={file.id} type="button" className="tt-button" onClick={() => onFile(file)} title={`下载 ${file.name}`}>{file.name}</button>)}</div>}
        </li>
      ))}</ol>
    </section>
  );
}

/** Files travel with the action so a failed upload cannot leave a partial handover. */
export async function readTeamTaskFiles(files: readonly File[]): Promise<TeamTaskFileInput[]> {
  if (files.length > TEAM_TASK_FILE_COUNT) throw new Error(`每次最多添加 ${TEAM_TASK_FILE_COUNT} 个附件`);
  if (files.some((file) => file.size === 0)) throw new Error("附件不能为空文件");
  if (files.reduce((sum, file) => sum + file.size, 0) > TEAM_TASK_FILE_LIMIT) throw new Error("附件合计最多 16 MB");
  return Promise.all(files.map((file) => new Promise<TeamTaskFileInput>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ name: file.name, base64: String(reader.result).split(",")[1]! });
    reader.onerror = () => reject(new Error(`读不到文件：${file.name}`));
    reader.readAsDataURL(file);
  })));
}
